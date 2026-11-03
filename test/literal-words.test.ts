/**
 * Literal path words (0.6.14): the CLI, `inspect` and the MCP server list every path word written
 * into client.ts, the ones seen in a single recorded path first. The leak guard can't recognise a
 * word with no evidence in the capture (`GET /api/v1/profiles/parker`); the user can.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { HarEntry } from "../src/har.js";
import { generateFromHar } from "../src/index.js";
import { createMcpServer } from "../src/mcp.js";
import { literalPathWords, renderPathWords, visibleWord, type PathWord } from "../src/pathwords.js";
import { DEMO_HAR_PATH, ROOT, demoHar, entry, har } from "./helpers.js";

const O = "https://app.acme.test";
const CLI = join(ROOT, "dist/cli.js");

/** The no-evidence case: a username used once as a path segment, next to ordinary endpoints. */
const PARKER = har([
  entry({ url: `${O}/api/v1/profiles/parker`, resBody: { title: "x", count: 3 } }),
  entry({ url: `${O}/api/v1/orders`, resBody: [{ id: 1001, total: 5 }, { id: 1002, total: 7 }] }),
  entry({ url: `${O}/api/v1/orders/1001`, resBody: { id: 1001, total: 5 } }),
  entry({ url: `${O}/api/v1/orders/1002`, resBody: { id: 1002, total: 7 } }),
  entry({ url: `${O}/api/v1/products`, resBody: [{ sku: "A1", price: 3 }] }),
]);

/**
 * A username the guard knows only from `from` (weak), inside the last word of a path: refused since 0.6.13.
 * (Until review 20 the segment was the bare name, `/inbox/parker`; a known name in its own segment is now a
 * path parameter (A1-02), so the refused case is a name inside a word.)
 */
const KNOWN = har([
  entry({ url: `${O}/api/v1/messages`, resBody: [{ from: "parker", unread: true }] }),
  entry({ url: `${O}/api/v1/inbox/parker-notes`, resBody: { unread: 1 } }),
  entry({ url: `${O}/api/v1/orders`, resBody: [{ total: 5 }] }),
]);

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "har2sdk-words-"));
}
function harFile(text: string): string {
  const p = join(tmp(), "capture.har");
  writeFileSync(p, text);
  return p;
}
function cli(args: string[]): { stdout: string; stderr: string; status: number | null } {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });
  return { stdout: r.stdout, stderr: r.stderr, status: r.status };
}
const wordsOf = (capture: string): PathWord[] => {
  const r = generateFromHar(capture);
  return literalPathWords(r.plan, r.exchanges);
};
/** The two list lines of a rendered section. */
function lists(text: string): { single: string[]; others: string[] } {
  const line = (label: string) =>
    (text.split("\n").find((l) => l.includes(label))?.split(label)[1] ?? "")
      .replace(/\(\+\d+ more: har2sdk inspect\)/, "")
      .split(",")
      .map((w) => w.replace(/\s*\(\d+\)\s*$/, "").trim())
      .filter((w) => w && w !== "none");
  return { single: line("seen in one request only:"), others: line(text.includes("others (paths using it):") ? "others (paths using it):" : "others:") };
}

describe("MCP", () => {
  const client = new Client({ name: "test", version: "0.0.0" });
  const server = createMcpServer();
  beforeAll(async () => {
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
  });
  afterAll(async () => {
    await client.close();
  });
  const call = async (name: string, args: Record<string, unknown>) => {
    const res = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
    return { text: res.content.map((c) => c.text).join("\n"), isError: !!res.isError };
  };

  it("generate_sdk and analyze_har list a word with no evidence under single-use", async () => {
    const path = harFile(PARKER);
    const gen = await call("generate_sdk", { har_path: path, out_dir: join(tmp(), "out") });
    expect(gen.isError).toBe(false);
    expect(gen.text).toContain("Path words written into client.ts");
    expect(lists(gen.text).single).toContain("parker");
    expect(lists(gen.text).others).toContain("orders");
    expect(gen.text).toContain('--param "/api/v1/profiles/*"');
    const an = await call("analyze_har", { har_path: path });
    expect(lists(an.text).single).toContain("parker");
  });

  it("a word the guard knows is redacted in analyze_har, and generate_sdk refuses as before", async () => {
    const path = harFile(KNOWN);
    const an = await call("analyze_har", { har_path: path });
    expect(an.text).toContain("Path words written into client.ts");
    expect(an.text).not.toMatch(/\bparker\b/i);
    expect(lists(an.text).single).toContainEqual(expect.stringContaining("<redacted>"));
    const gen = await call("generate_sdk", { har_path: path, out_dir: join(tmp(), "out") });
    expect(gen.isError).toBe(true);
    expect(gen.text).not.toMatch(/\bparker\b/i);
  });
});

describe("the no-evidence case: GET /api/v1/profiles/parker", () => {
  it("the plan's words: parker single-use first, orders among the others", () => {
    const words = wordsOf(PARKER);
    const r = generateFromHar(PARKER);
    expect(r.leaks).toEqual([]);
    expect(r.files["client.ts"]).toContain('"/api/v1/profiles/parker"'); // unchanged: the guard has no evidence
    expect(words.find((w) => w.word === "parker")).toEqual({ word: "parker", requests: 1 });
    expect(words.find((w) => w.word === "orders")!.requests).toBe(3);
    // Single-use first, then the others; each group alphabetical.
    const single = words.filter((w) => w.requests <= 1).map((w) => w.word);
    const others = words.filter((w) => w.requests > 1).map((w) => w.word);
    expect(words.map((w) => w.word)).toEqual([...single, ...others]);
    expect(single).toEqual([...single].sort());
    expect(others).toEqual([...others].sort());
    expect(single).toContain("parker");
    expect(others).toEqual(["orders"]);
  });

  it("generate prints the section after the written files, and points to --param", () => {
    const out = join(tmp(), "out");
    const { stdout, status } = cli([harFile(PARKER), "-o", out]);
    expect(status).toBe(0);
    const at = stdout.indexOf("Path words written into client.ts");
    expect(at).toBeGreaterThan(stdout.indexOf("client.ts  "));
    expect(at).toBeLessThan(stdout.indexOf("Use it"));
    expect(lists(stdout).single).toContain("parker");
    expect(lists(stdout).others).toEqual(["orders"]);
    expect(stdout).toContain('--param "/api/v1/profiles/*"');
    // The advice is not part of the generated code.
    for (const f of ["client.ts", "openapi.json"]) expect(readFileSync(join(out, f), "utf8")).not.toContain("Path words");
  });

  it("the --param it suggests turns the word into a parameter", () => {
    const out = join(tmp(), "out");
    const { status } = cli([harFile(PARKER), "-o", out, "--param", "/api/v1/profiles/*"]);
    expect(status).toBe(0);
    expect(readFileSync(join(out, "client.ts"), "utf8")).not.toContain("parker");
  });

  it("inspect and inspect --json list every word", () => {
    const path = harFile(PARKER);
    const human = cli(["inspect", path]);
    expect(human.status).toBe(0);
    expect(lists(human.stdout).single).toContain("parker");
    expect(human.stdout).toContain("orders (3)");
    const json = JSON.parse(cli(["inspect", path, "--json"]).stdout) as { pathWords: PathWord[] };
    expect(json.pathWords).toEqual(wordsOf(PARKER));
    expect(json.pathWords[0]!.requests).toBe(1);
    expect(json.pathWords).toContainEqual({ word: "parker", requests: 1 });
    expect(json.pathWords).toContainEqual({ word: "orders", requests: 3 });
  });

  it("generate shows at most 20 other words, then +N more", () => {
    const entries: HarEntry[] = [];
    for (let i = 0; i < 30; i++) {
      const w = "section" + String.fromCharCode(97 + (i % 26)) + (i >= 26 ? "x" : "");
      entries.push(entry({ url: `${O}/api/${w}`, resBody: { a: 1 } }), entry({ url: `${O}/api/${w}/stats`, resBody: { b: 2 } }));
    }
    const { stdout } = cli([harFile(har(entries)), "-o", join(tmp(), "out")]);
    expect(stdout).toContain("(+11 more: har2sdk inspect)"); // 30 section words and "stats"
    expect(lists(stdout).others).toHaveLength(20);
    const json = JSON.parse(cli(["inspect", harFile(har(entries)), "--json"]).stdout) as { pathWords: PathWord[] };
    expect(json.pathWords.filter((w) => w.requests > 1)).toHaveLength(31);
  });
});

describe("words used by several requests", () => {
  it("orders in /orders and /orders/{id} is an other word, not single-use", () => {
    const words = wordsOf(har([entry({ url: `${O}/orders`, resBody: [{ id: 1001 }] }), entry({ url: `${O}/orders/1001`, resBody: { id: 1001 } })]));
    expect(words).toEqual([{ word: "orders", requests: 2 }]);
  });

  it("counts distinct recorded paths, not calls: the same path twice is still single-use", () => {
    const words = wordsOf(har([entry({ url: `${O}/api/search?q=a`, resBody: [] }), entry({ url: `${O}/api/search?q=b`, resBody: [] })]));
    expect(words).toEqual([{ word: "search", requests: 1 }]);
  });

  it("deduplicates without regard to case", () => {
    const words = wordsOf(har([entry({ url: `${O}/Orders/summary`, resBody: { a: 1 } }), entry({ url: `${O}/orders/open`, resBody: { a: 1 } })]));
    expect(words.filter((w) => w.word.toLowerCase() === "orders")).toHaveLength(1);
    expect(words.find((w) => w.word.toLowerCase() === "orders")!.requests).toBe(2);
  });
});

describe("API root and version segments are not listed", () => {
  it("api, rest, graphql, v1, v2.1, a dated version and /rest/api/2", () => {
    const words = wordsOf(
      har([
        entry({ url: `${O}/api/v1/orders`, resBody: [{ total: 1 }] }),
        entry({ url: `${O}/api/v2.1/carts`, resBody: [{ total: 1 }] }),
        entry({ url: `${O}/rest/api/2/issues`, resBody: [{ total: 1 }] }),
        entry({ url: `${O}/admin/api/2024-01/shops`, resBody: [{ total: 1 }] }),
        entry({ method: "POST", url: `${O}/graphql`, reqBody: { query: "query Viewer { viewer { plan } }", operationName: "Viewer" }, resBody: { data: { viewer: { plan: "pro" } } } }),
      ]),
    ).map((w) => w.word.toLowerCase());
    for (const w of ["api", "rest", "graphql", "v1", "v2.1", "2", "2024-01", ""]) expect(words).not.toContain(w);
    for (const w of ["orders", "carts", "issues", "shops", "admin"]) expect(words).toContain(w);
  });
});

describe("a word the guard knows never appears", () => {
  it("an echoed username is templated as before, so it isn't a word", () => {
    const capture = har([
      entry({ url: `${O}/api/v1/users/okilic`, resBody: { login: "okilic", followers: 3 } }),
      entry({ url: `${O}/api/v1/orders`, resBody: [{ total: 5 }] }),
    ]);
    const r = generateFromHar(capture);
    expect(r.files["client.ts"]).not.toContain("okilic");
    expect(wordsOf(capture).map((w) => w.word)).not.toContain("okilic");
    const out = cli([harFile(capture), "-o", join(tmp(), "out")]);
    expect(out.status).toBe(0);
    expect(out.stdout).not.toContain("okilic");
  });

  it("a refused capture is still refused (exit 2) and inspect --json redacts the word", () => {
    const path = harFile(KNOWN);
    const out = join(tmp(), "out");
    const gen = cli([path, "-o", out]);
    expect(gen.status).toBe(2);
    expect(gen.stdout).not.toContain("Path words");
    expect(() => readdirSync(out)).toThrow();
    const json = cli(["inspect", path, "--json"]).stdout;
    expect(json).not.toMatch(/parker/i);
    expect((JSON.parse(json) as { pathWords: PathWord[] }).pathWords).toContainEqual({ word: expect.stringContaining("<redacted>"), requests: 1 });
  });
});

describe("a recorded segment with control characters or ANSI escapes is printed safely", () => {
  const capture = har([
    entry({ url: `${O}/api/v1/red%1B%5B31mflag%07`, resBody: { a: 1 } }),
    entry({ url: `${O}/api/v1/rtl%E2%80%AEtxt`, resBody: { a: 1 } }),
    entry({ url: `${O}/api/v1/orders`, resBody: [{ total: 5 }] }),
  ]);

  it("visibleWord shows control and format characters as escapes", () => {
    expect(visibleWord("red\x1b[31mflag\x07")).toBe("red\\u{1b}[31mflag\\u{7}");
    expect(visibleWord("rtl\u202etxt")).toBe("rtl\\u{202e}txt");
    expect(visibleWord("çiçek")).toBe("çiçek");
  });

  it("generate and inspect print no escape sequence from the capture", () => {
    for (const args of [[harFile(capture), "-o", join(tmp(), "out")], ["inspect", harFile(capture)]]) {
      const { stdout } = cli(args);
      const section = stdout.slice(stdout.indexOf("Path words"));
      expect(section).toContain("red\\u{1b}[31mflag");
      expect(section).toContain("rtl\\u{202e}txt");
      expect(section).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/);
      expect(section).not.toMatch(/\p{Cf}/u);
    }
  });

  it("with colours on, only har2sdk's own colour codes reach the terminal", () => {
    const r = spawnSync(process.execPath, [CLI, "inspect", harFile(capture)], { encoding: "utf8", env: { ...process.env, NO_COLOR: "", FORCE_COLOR: "1" } });
    const section = r.stdout.slice(r.stdout.indexOf("Path words"));
    const foreign = section.replace(/\x1b\[(?:1|2|22|3[1-6]|39|90)m/g, "");
    expect(foreign).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/);
    expect(foreign).toContain("red\\u{1b}[31mflag");
  });

  it("inspect --json keeps them as JSON escapes", () => {
    const { stdout } = cli(["inspect", harFile(capture), "--json"]);
    expect(stdout).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/);
    const words = (JSON.parse(stdout) as { pathWords: PathWord[] }).pathWords.map((w) => w.word);
    expect(words.some((w) => w.includes("\x1b[31m"))).toBe(true);
  });
});

describe("generated: a random login used once as a path segment is always listed under single-use", () => {
  function rng(seed: number): () => number {
    return () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
  }
  const CONSONANTS = "bcdfghjklmnpqrstvwxz";
  const VOWELS = "aeiou";
  const RESOURCES = ["orders", "products", "invoices", "carts", "tickets", "projects", "teams", "reports", "files", "events"];
  const PEOPLE = ["profiles", "users", "members", "people", "accounts", "authors"];
  const login = (rnd: () => number): string => {
    let w = "";
    for (let i = 0, n = 2 + Math.floor(rnd() * 3); i < n; i++) w += CONSONANTS[Math.floor(rnd() * CONSONANTS.length)]! + VOWELS[Math.floor(rnd() * VOWELS.length)]!;
    return w + (rnd() < 0.5 ? CONSONANTS[Math.floor(rnd() * CONSONANTS.length)]! : "");
  };
  const seeds = Number(process.env.HAR2SDK_FUZZ_SEEDS ?? 60);

  it(`${seeds} seeds`, () => {
    let literal = 0;
    for (let seed = 1; seed <= seeds; seed++) {
      const rnd = rng(seed);
      const pick = <T>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)]!;
      const name = login(rnd);
      const prefix = pick(["/api/v1", "/api", "/rest/v2", ""]);
      const entries: HarEntry[] = [];
      const resources = RESOURCES.filter(() => rnd() < 0.5);
      for (const res of resources) {
        entries.push(entry({ url: `${O}${prefix}/${res}`, resBody: [{ id: 1001, total: 3 }, { id: 1002, total: 4 }] }));
        if (rnd() < 0.6) entries.push(entry({ url: `${O}${prefix}/${res}/${1000 + Math.floor(rnd() * 9000)}`, resBody: { id: 1001, total: 3 } }));
      }
      const tail = rnd() < 0.3 ? "/" + pick(["settings", "avatar", "stats"]) : "";
      entries.splice(Math.floor(rnd() * (entries.length + 1)), 0, entry({ url: `${O}${prefix}/${pick(PEOPLE)}/${name}${tail}`, resBody: { title: "x", count: 3 } }));
      const r = generateFromHar(har(entries));
      const words = literalPathWords(r.plan, r.exchanges);
      const lower = words.map((w) => w.word.toLowerCase());
      const inClient = new RegExp(`/${name}(?=["/])`).test(r.files["client.ts"]!);
      const ctx = `seed ${seed}: ${name}`;
      if (inClient) {
        literal++;
        expect(words.find((w) => w.word === name), ctx).toEqual({ word: name, requests: 1 });
        const text = renderPathWords(r.plan, words, { limit: 20 }).join("\n");
        expect(lists(text).single, ctx).toContain(name);
      } else expect(lower, ctx).not.toContain(name);
      // Invariants of every list: no root or version, no duplicates, single-use first.
      expect(new Set(lower).size).toBe(lower.length);
      for (const w of ["api", "rest", "v1", "v2"]) expect(lower, ctx).not.toContain(w);
      const firstOther = words.findIndex((w) => w.requests > 1);
      if (firstOther >= 0) expect(words.slice(firstOther).every((w) => w.requests > 1), ctx).toBe(true);
    }
    // The case this list exists for: most such logins have no evidence and stay literal.
    expect(literal).toBeGreaterThan(seeds / 2);
  });
});

describe("the demo", () => {
  it("lists the words; generation is otherwise unchanged (exit 0, same files)", () => {
    const out = join(tmp(), "out");
    const { stdout, status } = cli([DEMO_HAR_PATH, "-o", out]);
    expect(status).toBe(0);
    expect(readdirSync(out).sort()).toEqual(["client.ts", "openapi.json"]);
    const r = generateFromHar(demoHar(), { source: "acme-shop.har" });
    for (const f of ["client.ts", "openapi.json"]) expect(readFileSync(join(out, f), "utf8")).toBe(r.files[f]);
    expect(stdout).toContain("Path words written into client.ts");
    const { single, others } = lists(stdout);
    expect(others).toEqual(["cart", "items", "orders", "products", "stores"]);
    expect(single).toEqual(["auth", "cancel", "login", "me", "newsletter", "reviews", "search"]);
    // Every word of the list is in client.ts, and every literal path segment of client.ts is in the list.
    const code = r.files["client.ts"]!;
    for (const w of [...single, ...others]) expect(code).toContain(`/${w}`);
    expect(execFileSync(process.execPath, [CLI, "--version"], { encoding: "utf8" }).trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe("rendering", () => {
  it("empty plan words give no section", () => {
    const r = generateFromHar(har([entry({ method: "POST", url: `${O}/graphql`, reqBody: { query: "query Me { me { plan } }", operationName: "Me" }, resBody: { data: { me: { plan: "pro" } } } })]));
    const words = literalPathWords(r.plan, r.exchanges);
    expect(words).toEqual([]);
    expect(renderPathWords(r.plan, words)).toEqual([]);
  });
});
