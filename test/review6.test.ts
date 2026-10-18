/**
 * Sixth review (v0.6.0), a pre-release security audit. One describe block per
 * finding (A1–A6), with the auditor's input; test/privacy-fuzz.test.ts has
 * generated variants of A2–A4 and A6.
 */
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateFromHar, writeFiles } from "../src/index.js";
import { looksRandom, scanText, scrubText } from "../src/leak.js";
import { createMcpServer } from "../src/mcp.js";
import { listenMock } from "../src/mock.js";
import { buildPlan } from "../src/plan.js";
import { renderChatPrompt, renderEndpointDetail, renderEndpointList } from "../src/summary.js";
import { stripControl } from "../src/term.js";
import { DEMO_HAR_PATH, ROOT, entry, har } from "./helpers.js";

type Entry = ReturnType<typeof entry>;
const gen = (entries: Entry[], opts = {}) => generateFromHar(har(entries), opts);
const O = "https://api.acme.test";
const CLI = join(ROOT, "dist/cli.js");
const H = { authorization: "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.c2lnbmF0dXJlc2lnbmF0dXJl" };
const me = (origin = O) => entry({ url: origin + "/api/me", reqHeaders: H, resBody: { id: 1, fullName: "Zeynep Ak", email: "zeynep.ak@posteo.de" } });

/** Readable outputs: the chat prompt, what MCP shows, and `inspect --json`. */
function readable(entries: Entry[]): Record<string, string> {
  const r = gen(entries, { allowLeaks: true });
  const plan = buildPlan(structuredClone(r.model));
  const dir = mkdtempSync(join(tmpdir(), "har2sdk-r6-"));
  writeFileSync(join(dir, "c.har"), har(entries));
  return {
    prompt: renderChatPrompt(plan),
    list: renderEndpointList(plan),
    detail: plan.ops.map((o) => renderEndpointDetail(plan, o)).join("\n"),
    "inspect --json": execFileSync(process.execPath, [CLI, "inspect", join(dir, "c.har"), "--json"], { encoding: "utf8" }),
  };
}

async function mockAll(entries: Entry[]): Promise<string[]> {
  const r = gen(entries);
  const server = await listenMock(r.model, r.exchanges, { port: 0 });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const out: string[] = [];
    for (const en of entries) {
      const u = new URL(en.request.url);
      const pd = en.request.postData;
      const res = await fetch(base + u.pathname + u.search, { method: en.request.method, ...(pd ? { body: pd.text, headers: { "content-type": pd.mimeType ?? "application/json" } } : {}) });
      out.push(await res.text());
    }
    return out;
  } finally {
    server.close();
  }
}

// ── A1 ─────────────────────────────────────────────────────────────────────────

/** Symbolic links: a file link, or a directory link ("junction" on Windows, which needs no privileges). */
function link(target: string, path: string, dir = false): void {
  symlinkSync(target, path, dir ? "junction" : "file");
}

describe("A1 MCP generate_sdk never writes through a symbolic link", () => {
  const client = new Client({ name: "r6", version: "0" });
  const server = createMcpServer();
  beforeAll(async () => {
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
  });
  afterAll(async () => {
    await client.close();
  });
  const call = async (args: Record<string, unknown>) => {
    const res = (await client.callTool({ name: "generate_sdk", arguments: args })) as { content: { text: string }[]; isError?: boolean };
    return { text: res.content.map((c) => c.text).join("\n"), isError: !!res.isError };
  };
  /** A downloaded folder with a capture, next to a "home" folder with a file worth protecting. */
  const setup = () => {
    const root = mkdtempSync(join(tmpdir(), "har2sdk-a1-"));
    mkdirSync(join(root, "home"));
    const bashrc = join(root, "home", ".bashrc");
    writeFileSync(bashrc, "# my bashrc\nalias ll='ls -l'\n");
    const dl = join(root, "Downloads", "report");
    mkdirSync(join(dl, "har2sdk-out"), { recursive: true });
    writeFileSync(join(dl, "capture.har"), readFileSync(DEMO_HAR_PATH));
    return { root, bashrc, dl, har: join(dl, "capture.har") };
  };

  it("a linked har2sdk.annotations.json is refused, and the target is untouched", async () => {
    const { bashrc, dl, har: harPath } = setup();
    link(bashrc, join(dl, "har2sdk-out", "har2sdk.annotations.json"));
    const r = await call({ har_path: harPath, annotations: { endpoints: { "GET /api/v1/products": { description: "$(touch /tmp/PWNED) list products" } } } });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/symbolic link/);
    expect(readFileSync(bashrc, "utf8")).toBe("# my bashrc\nalias ll='ls -l'\n");
    expect(existsSync(join(dl, "har2sdk-out", "client.ts"))).toBe(false);
  });

  it("a linked client.ts is refused even when its target mentions har2sdk", async () => {
    const { root, dl, har: harPath } = setup();
    const pkg = join(root, "home", "package.json");
    writeFileSync(pkg, '{ "dependencies": { "har2sdk": "^0.6.0" } }\n');
    link(pkg, join(dl, "har2sdk-out", "client.ts"));
    const r = await call({ har_path: harPath });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/symbolic link/);
    expect(readFileSync(pkg, "utf8")).toContain('"har2sdk": "^0.6.0"');
  });

  it("a linked output folder is refused", async () => {
    const { root, dl, har: harPath } = setup();
    const other = join(root, "home", "project");
    mkdirSync(other);
    link(other, join(dl, "linked-out"), true);
    const r = await call({ har_path: harPath, out_dir: join(dl, "linked-out") });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/symbolic link/);
    expect(existsSync(join(other, "client.ts"))).toBe(false);
  });

  it("a folder inside a linked folder is refused too (the real path is checked)", async () => {
    const { root, dl, har: harPath } = setup();
    const other = join(root, "home", "project");
    mkdirSync(other);
    link(other, join(dl, "linked"), true);
    const r = await call({ har_path: harPath, out_dir: join(dl, "linked", "sub") });
    expect(r.isError).toBe(true);
    expect(existsSync(join(other, "sub"))).toBe(false);
  });

  it("an ordinary output folder still works", async () => {
    const { dl, har: harPath } = setup();
    const r = await call({ har_path: harPath });
    expect(r.isError).toBe(false);
    expect(lstatSync(join(dl, "har2sdk-out", "har2sdk.annotations.json")).isFile()).toBe(true);
    expect(readFileSync(join(dl, "har2sdk-out", "client.ts"), "utf8")).toContain("class AcmeShopClient");
  });

  it("the CLI's writer refuses links too", async () => {
    const { bashrc, dl } = setup();
    link(bashrc, join(dl, "har2sdk-out", "openapi.json"));
    await expect(writeFiles(join(dl, "har2sdk-out"), { "openapi.json": "{}" })).rejects.toThrow(/symbolic link/);
    expect(readFileSync(bashrc, "utf8")).toBe("# my bashrc\nalias ll='ls -l'\n");
    const realOut = realpathSync(join(dl, "har2sdk-out"));
    link(realOut, join(dl, "out-link"), true);
    await expect(writeFiles(join(dl, "out-link"), { "client.ts": "x" })).rejects.toThrow(/symbolic link/);
  });
});

// ── A2 ─────────────────────────────────────────────────────────────────────────

describe("A2 readable outputs redact every form the scanner finds", () => {
  const cases: [string, Entry[]][] = [
    ["a bucket named after the person", [me(), entry({ url: "https://zeynep-ak.s3.amazonaws.com/manifest.json", resBody: { files: [{ key: "a", size: 1 }] } })]],
    ["a profile slug in a path", [me(), entry({ url: O + "/api/u/zeynep-ak/settings", reqHeaders: H, resBody: { theme: "dark" } })]],
    ["the API host named after the person", [me("https://zeynep-ak.myshopify.com"), entry({ url: "https://zeynep-ak.myshopify.com/api/products", reqHeaders: H, resBody: [{ id: 1, title: "x" }] })]],
  ];
  for (const [label, entries] of cases) {
    it(label, () => {
      const r = gen(entries);
      // The generator refuses these files…
      expect(r.leaks.length).toBeGreaterThan(0);
      // …and what is shown instead must not repeat the value.
      for (const [where, text] of Object.entries(readable(entries))) {
        expect({ where, hit: /zeynep/i.test(text) }).toEqual({ where, hit: false });
        expect({ where, found: scanText(text, r.model.taint, where) }).toEqual({ where, found: [] });
      }
    });
  }

  it("MCP analyze_har and inspect_endpoint", async () => {
    const dir = mkdtempSync(join(tmpdir(), "har2sdk-a2-"));
    const file = join(dir, "c.har");
    writeFileSync(file, har(cases[0]![1]));
    const server = createMcpServer();
    const client = new Client({ name: "r6", version: "0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
    const call = async (name: string, args: Record<string, unknown>) => ((await client.callTool({ name, arguments: args })) as { content: { text: string }[] }).content.map((c) => c.text).join("\n");
    const out = [await call("analyze_har", { har_path: file }), await call("inspect_endpoint", { har_path: file, endpoint_id: "nope" }), await call("generate_sdk", { har_path: file })];
    await client.close();
    expect(out.join("\n")).not.toMatch(/zeynep/i);
  });

  it("scrubText(x) leaves nothing for scanText(x) to find: values, slugs, hosts, encoded forms", () => {
    const r = gen([me(), entry({ url: O + "/api/members", reqHeaders: H, resBody: [{ id: 1, login: "ece_kaya", fullName: "Gülşen Öztürk" }] })]);
    const t = r.model.taint;
    const text = [
      "zeynep.ak@posteo.de",
      "/api/u/zeynep-ak/settings and /api/u/zeynep_ak and ZeynepAk and zeynepAkSettings",
      "https://zeynep-ak.s3.amazonaws.com/x https://ece.kaya.github.io",
      "/u/ece-kaya, remember_ece_kaya=1, /p/G%C3%BCl%C5%9Fen%20%C3%96zt%C3%BCrk/x",
    ].join("\n");
    expect(scanText(text, t, "x").length).toBeGreaterThanOrEqual(4);
    const scrubbed = scrubText(text, t);
    expect(scanText(scrubbed, t, "x")).toEqual([]);
    expect(scrubbed).toContain(".s3.amazonaws.com/x");
  });
});

// ── A3 ─────────────────────────────────────────────────────────────────────────

describe("A3 a word of a recorded name is never an enum member", () => {
  const tickets = (field: string) =>
    entry({ url: O + "/api/tickets", reqHeaders: H, resBody: Array.from({ length: 8 }, (_, i) => ({ id: i, status: i % 4 ? "open" : "closed", [field]: i % 2 ? "zeynep" : "general" })) });
  for (const field of ["type", "kind", "channel", "source"]) {
    it(`${field}: "zeynep" next to fullName "Zeynep Ak"`, async () => {
      const entries = [me(), tickets(field)];
      const r = gen(entries);
      const rx = gen(entries, { examples: true });
      const all = [r.files["client.ts"], r.files["openapi.json"], rx.files["openapi.json"], ...Object.values(readable(entries)), ...(await mockAll(entries))].join("\n");
      expect(all).not.toMatch(/zeynep/i);
      // Real vocabulary is still an enum.
      expect(r.files["client.ts"]).toContain('status: "closed" | "open" | (string & {})');
    });
  }

  it("the same word without a name to come from stays an enum", () => {
    const r = gen([tickets("channel")]);
    expect(r.files["client.ts"]).toContain('channel: "general" | "zeynep" | (string & {})');
  });
});

// ── A4 ─────────────────────────────────────────────────────────────────────────

describe("A4 random-looking tokens without digits are ids", () => {
  const tokens: [string, string][] = [
    ["/api/password-reset/KfTqLmZxRwPbNvYc/confirm", "KfTqLmZxRwPbNvYc"],
    ["/api/videos/dQwUvXyZaBc", "dQwUvXyZaBc"],
    ["/api/meet/xkq-bvzt-rmn", "xkq-bvzt-rmn"],
    ["/api/invite/qzxkvbtrplmw/accept", "qzxkvbtrplmw"],
  ];
  for (const [path, token] of tokens) {
    it(path, () => {
      const entries = [me(), entry({ method: path.endsWith("confirm") || path.endsWith("accept") ? "POST" : "GET", url: O + path, reqHeaders: H, resBody: { ok: true } })];
      const r = gen(entries);
      const words = token.split("-");
      const all = [r.files["client.ts"]!, r.files["openapi.json"]!, ...Object.values(readable(entries))].join("\n");
      for (const w of words) expect(all.toLowerCase()).not.toContain(w.toLowerCase());
      const [before, after] = path.split(token) as [string, string];
      expect(r.plan.ops.some((o) => o.ep.path.startsWith(before + "{") && o.ep.path.endsWith("}" + after))).toBe(true);
    });
  }

  it("words, acronyms and camel-case names are not random", () => {
    const real = [
      "settings", "strengths", "rhythms", "twelfths", "lengths", "dotfiles", "XMLHttpRequest", "getRecommendations", "batchGetItems",
      "listMyQRCodes", "iOSAppID", "getHTTPSUrl", "HTTPSProxy", "password-reset", "graphql", "oauth", "html", "crypt", "schwarzschild",
      "nymphs", "SKUs", "myths", "lynx", "pdf-html", "rss-feed", "subscriptions", "authorize", "Strengths", "WebAuthn", "geoJSON",
      "getIdOrSlug", "isHTMLOrXMLFile", "SearchByISBN", "PutObjectACL", "AssumeRoleWithSAML", "DescribeDBClusters", "getXMLHTTPObject",
      "siparisler", "kullanicilar", "bildirimler", "kardiyoloji", "bestellungen", "einstellungen", "schluessel", "usuarios", "utilisateurs",
      "Knowledgebase", "PostgreSQL", "DynamoDB", "WooCommerce", "getAllUserNotificationPreferencesByIdAndType",
    ];
    expect(real.filter(looksRandom)).toEqual([]);
  });
});

// ── A5 ─────────────────────────────────────────────────────────────────────────

describe("A5 control characters from a capture never reach the terminal", () => {
  const ESC = "\x1b]52;c;ZWNobyBwd25lZA==\x07\x1b[2K\x1b[1A";
  const entries = [
    entry({ method: "POST", url: "https://api.x.test/graphql", reqBody: { operationName: "Q" + ESC, query: "query Q { a }" }, resBody: { data: { a: 1 } } }),
    entry({ method: "POST", url: "https://api.x.test/rpc", reqBody: { jsonrpc: "2.0", id: 1, method: "m" + ESC, params: {} }, resBody: { jsonrpc: "2.0", id: 1, result: 1 } }),
    entry({ url: "https://api.x.test/api/v1/things", reqHeaders: { "x-a\x1b[31m": "1" }, resBody: { a: 1 } }),
  ];
  const dir = mkdtempSync(join(tmpdir(), "har2sdk-a5-"));
  writeFileSync(join(dir, "esc.har"), har(entries));
  const run = (args: string[], env: Record<string, string> = {}) => {
    try {
      return execFileSync(process.execPath, [CLI, ...args], { encoding: "utf8", env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string };
      return (e.stdout ?? "") + (e.stderr ?? "");
    }
  };
  for (const [label, args] of [
    ["inspect", ["inspect", join(dir, "esc.har")]],
    ["inspect --json", ["inspect", join(dir, "esc.har"), "--json"]],
    ["generate", [join(dir, "esc.har"), "-o", join(dir, "out")]],
    ["prompt", ["prompt", join(dir, "esc.har")]],
  ] as const) {
    it(label, () => {
      const plain = run([...args], { NO_COLOR: "1" });
      expect(plain).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/);
      // With colours on, only the CLI's own SGR sequences remain.
      const colored = run([...args], { FORCE_COLOR: "1" });
      expect(colored.replace(/\x1b\[\d+m/g, "")).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/);
    });
  }

  it("stripControl keeps newlines and tabs", () => {
    expect(stripControl("a\tb\nc\x1b]0;x\x07d\u009bq")).toBe("a\tb\nc]0;xdq");
  });

  it("MCP responses carry no control characters", async () => {
    const server = createMcpServer();
    const client = new Client({ name: "r6", version: "0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
    const res = (await client.callTool({ name: "analyze_har", arguments: { har_path: join(dir, "esc.har") } })) as { content: { text: string }[] };
    await client.close();
    expect(res.content.map((c) => c.text).join("\n")).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/);
  });
});

// ── A6 ─────────────────────────────────────────────────────────────────────────

describe("A6 prototype keys (__proto__, constructor) don't crash anything", () => {
  const raw = '{"constructor":{"a":1},"__proto__":{"b":2},"toString":"x","hasOwnProperty":{"c":3},"status":"ok"}';
  const entries = [
    entry({ url: O + "/api/a", resText: raw }),
    entry({ method: "POST", url: O + "/api/b?constructor=1&__proto__=2", reqBody: raw, resText: `[${raw},${raw}]` }),
    entry({ url: O + "/api/constructor/__proto__/prototype", reqHeaders: JSON.parse('{"constructor":"x","__proto__":"y"}') as Record<string, string>, resText: raw }),
    entry({ url: O + "/api/c", resMime: "application/xml", resText: "<constructor><__proto__>x</__proto__></constructor>" }),
  ];

  it("generates a client, an OpenAPI document and examples", () => {
    const r = gen(entries);
    expect(r.plan.ops.length).toBe(4);
    expect(r.files["client.ts"]).toMatch(/\b__proto__: \w+;/);
    expect(() => JSON.parse(gen(entries, { examples: true }).files["openapi.json"]!)).not.toThrow();
  });

  it("the mock keeps the keys as data", async () => {
    const [a] = await mockAll(entries);
    const body = JSON.parse(a!) as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(["constructor", "__proto__", "toString", "hasOwnProperty", "status"]);
    expect(Object.getPrototypeOf(body)).toBe(Object.prototype);
  });

  it("inspect --json and the prompt", () => {
    expect(() => readable(entries)).not.toThrow();
  });
});
