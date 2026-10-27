/**
 * Seventh review (v0.6.1), an end-to-end "does it work" audit. One describe
 * block per finding (E1–E14), with the auditor's input where there was one;
 * test/privacy-fuzz.test.ts has the generated variant of E2.
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createConnection, createServer, type AddressInfo } from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { parseAnnotations } from "../src/annotations.js";
import { analyzeExchanges, generateFromHar, generateFromModel, loadHarFile } from "../src/index.js";
import { createMcpServer } from "../src/mcp.js";
import { listenMock } from "../src/mock.js";
import { DEMO_HAR_PATH, ROOT, entry, har } from "./helpers.js";

type Entry = ReturnType<typeof entry>;
const gen = (entries: Entry[], opts = {}) => generateFromHar(har(entries), opts);
const CLI = join(ROOT, "dist/cli.js");
const O = "https://api.acme.test";
const tmp = (p: string) => mkdtempSync(join(tmpdir(), `har2sdk-r7-${p}-`));
/** A text file of the repo, with \n line endings whatever the checkout did (Windows: CRLF). */
const repoText = (path: string) => readFileSync(join(ROOT, path), "utf8").replace(/\r\n/g, "\n");

/** Run the CLI; returns exit status and everything it printed. */
function cli(args: string[], env: Record<string, string> = {}): { status: number; out: string } {
  try {
    const out = execFileSync(process.execPath, [CLI, ...args], { encoding: "utf8", env: { ...process.env, NO_COLOR: "1", ...env }, stdio: ["ignore", "pipe", "pipe"] });
    return { status: 0, out };
  } catch (err) {
    const e = err as { status: number; stdout?: string; stderr?: string };
    return { status: e.status, out: (e.stdout ?? "") + (e.stderr ?? "") };
  }
}

async function mcp() {
  const server = createMcpServer();
  const client = new Client({ name: "r7", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown>) => {
    const res = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
    return { text: res.content.map((c) => c.text).join("\n"), isError: !!res.isError };
  };
  return { call, close: () => client.close() };
}

// ── E1 ─────────────────────────────────────────────────────────────────────────

describe("E1 204 and 304 responses recorded by Playwright are not dropped as noise", () => {
  // A real Playwright 1.56.1 recording (test/fixtures/playwright/record-notes-204.mjs): the page
  // reads the 204 bodies, so they are stored as `text: "", encoding: "base64"`, and there is
  // no `_resourceType` anywhere.
  const FIXTURE = join(ROOT, "test/fixtures/playwright/notes-204.har");

  it("the fixture has the shape the audit described", () => {
    const entries = JSON.parse(readFileSync(FIXTURE, "utf8")).log.entries as { response: { status: number; content: { text?: string; encoding?: string } }; _resourceType?: string }[];
    const with204 = entries.filter((e) => e.response.status === 204);
    expect(with204.length).toBe(3);
    for (const e of with204) expect(e.response.content).toMatchObject({ text: "", encoding: "base64" });
    expect(entries.every((e) => e._resourceType === undefined)).toBe(true);
  });

  it("PUT, DELETE and GET answered with 204 become SDK methods", async () => {
    const exchanges = await loadHarFile(FIXTURE);
    const r = generateFromModel(analyzeExchanges(exchanges), exchanges);
    const ids = r.plan.ops.map((o) => o.ep.id).sort();
    expect(ids).toEqual(["DELETE /api/notes/{noteId}", "GET /api/notes", "GET /api/session/ping", "PUT /api/notes/{noteId}/pin"]);
    expect(r.model.stats.dropped["not-api"] ?? 0).toBe(0);
    expect(r.files["client.ts"]).toMatch(/async deleteNote\(params: DeleteNoteParams, options\?: RequestOptions\): Promise<DeleteNoteResponse>/);
    expect(r.files["client.ts"]).toContain("export type DeleteNoteResponse = void;");
  });

  it("a 304 revalidation of a known endpoint joins it", async () => {
    const exchanges = await loadHarFile(FIXTURE);
    const r = generateFromModel(analyzeExchanges(exchanges), exchanges);
    const list = r.plan.ops.find((o) => o.ep.id === "GET /api/notes")!;
    expect(list.ep.count).toBe(2);
  });

  it("an empty, untyped response that is still skipped is named in a warning", () => {
    const r = gen([
      entry({ url: O + "/api/items", resBody: [{ id: 1 }] }),
      // 200 with an empty body, no content type, no resource type: can't tell what it is.
      { ...entry({ url: O + "/api/heartbeat", resText: "", base64: true, resMime: "" }), _resourceType: undefined } as unknown as Entry,
    ]);
    expect(r.plan.ops.map((o) => o.ep.id)).toEqual(["GET /api/items"]);
    expect(r.warnings.join("\n")).toMatch(/content type is unknown.*GET \/api\/heartbeat/);
    expect(r.warnings.join("\n")).toContain("--include-path");
  });
});

// ── E2 ─────────────────────────────────────────────────────────────────────────

describe("E2 a username in the file name of a URL is faked", () => {
  const entries = [
    entry({
      url: O + "/api/me",
      resBody: {
        id: 1,
        login: "mehmet.yilmaz",
        fullName: "Mehmet Yılmaz",
        avatar: "https://cdn.acme.test/avatars/mehmet.yilmaz.png",
        photo: "https://cdn.acme.test/u/mehmet.yilmaz_avatar.jpg",
        cover: "https://cdn.acme.test/c/mehmet-yilmaz-cover.webp",
        status: "active",
      },
    }),
    entry({ url: O + "/api/team", resBody: [{ id: 2, login: "mehmet.yilmaz" }] }),
  ];

  it("the default mock", async () => {
    const r = gen(entries);
    const server = await listenMock(r.model, r.exchanges, { port: 0 });
    try {
      const body = await (await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/me`)).json();
      const urls = [body.avatar, body.photo, body.cover].join(" ");
      expect(urls).not.toMatch(/mehmet|yilmaz/i);
      // Same shape: host, folders and extensions stay; the suffix after the name stays.
      expect(body.avatar).toMatch(/^https:\/\/cdn\.acme\.test\/avatars\/[a-z]+\.[a-z]+\.png$/);
      expect(body.photo).toMatch(/^https:\/\/cdn\.acme\.test\/u\/[a-z]+\.[a-z]+_avatar\.jpg$/);
      expect(body.cover).toMatch(/^https:\/\/cdn\.acme\.test\/c\/[a-z]+-[a-z]+-cover\.webp$/);
    } finally {
      server.close();
    }
  });

  it("a one-word username as the whole file name (fuzz found it)", async () => {
    const r = gen([entry({ url: O + "/api/profile", resBody: { id: 1, login: "harukik", picture: "https://cdn.acme.test/avatars/harukik.png" } })]);
    const server = await listenMock(r.model, r.exchanges, { port: 0 });
    try {
      const body = await (await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/profile`)).json();
      expect(body.picture).toMatch(/^https:\/\/cdn\.acme\.test\/avatars\/[a-z]+\.png$/);
      expect(body.picture).not.toContain("harukik");
    } finally {
      server.close();
    }
  });

  it("--examples", () => {
    const r = gen(entries, { examples: true });
    expect(r.files["openapi.json"]).not.toMatch(/mehmet|yilmaz/i);
    expect(r.files["openapi.json"]).toContain("https://cdn.acme.test/avatars/");
    expect(r.leaks).toEqual([]);
  });

  it("the leak guard reads --examples again (only timestamps are exempt)", () => {
    // The demo's examples keep one recorded date on purpose; that is not reported.
    const r = generateFromHar(readFileSync(DEMO_HAR_PATH, "utf8"), { examples: true });
    expect(r.leaks).toEqual([]);
  });
});

// ── E3 ─────────────────────────────────────────────────────────────────────────

describe("E3 a multipart upload whose body the browser didn't record", () => {
  const upload = entry({
    method: "POST",
    url: O + "/api/uploads",
    reqHeaders: { "content-type": "multipart/form-data; boundary=----WebKitFormBoundary7MA4YWxkTrZu0gW", "content-length": "48213" },
    resBody: { id: "up_8f3k2l9x", size: 48213 },
  });

  it("still gets a FormData body parameter", () => {
    const r = gen([upload]);
    expect(r.files["client.ts"]).toMatch(/async createUpload\(body: CreateUploadBody, options\?: RequestOptions\)/);
    expect(r.files["client.ts"]).toContain("export type CreateUploadBody = FormData;");
  });

  it("and a warning, like a missing response body", () => {
    const r = gen([upload]);
    expect(r.warnings.join("\n")).toMatch(/POST \/api\/uploads: the request body was not recorded/);
  });

  it("a JSON request whose body is missing gets a warning too", () => {
    const r = gen([entry({ method: "POST", url: O + "/api/things", reqHeaders: { "content-type": "application/json", "content-length": "57" }, resBody: { id: 7 } })]);
    expect(r.warnings.join("\n")).toMatch(/POST \/api\/things: the request body was not recorded/);
  });
});

// ── E4 ─────────────────────────────────────────────────────────────────────────

describe("E4 annotations of the wrong type are an error, not a crash", () => {
  const bad: [string, string][] = [
    ['{"endpoints":{"GET /api/v1/products":{"name":123}}}', 'endpoints["GET /api/v1/products"].name'],
    ['{"clientName": 5}', "clientName"],
    ['{"types": {"Order": 7}}', 'types.Order'],
    ['{"endpoints":{"GET /api/v1/products":{"params":{"page": null}}}}', "params"],
    ['{"endpoints": []}', "endpoints"],
  ];
  for (const [json, where] of bad) {
    it(json, () => {
      expect(() => parseAnnotations(json)).toThrow(where);
    });
  }

  it("the CLI says which field is wrong and exits 1", () => {
    const dir = tmp("ann");
    writeFileSync(join(dir, "ann.json"), bad[0]![0]);
    const r = cli([DEMO_HAR_PATH, "-o", join(dir, "out"), "--annotations", join(dir, "ann.json")]);
    expect(r.status).toBe(1);
    expect(r.out).toContain('endpoints["GET /api/v1/products"].name');
    expect(r.out).not.toMatch(/is not a function/);
    expect(existsSync(join(dir, "out", "client.ts"))).toBe(false);
  });

  it("a valid file still works", () => {
    expect(parseAnnotations('{"clientName":"Shop","endpoints":{"GET /x":{"name":"getX","params":{"a":"b"}}},"types":{"A":"B"}}').clientName).toBe("Shop");
  });
});

// ── E5 / E8 ────────────────────────────────────────────────────────────────────

describe("E5/E8 the README's example compiles under NodeNext and its type comments are true", () => {
  const readme = repoText("README.md");
  const code = readme.match(/```ts\n(import \{[\s\S]*?)```/)![1]!;

  it("the client is imported with an extension NodeNext accepts", () => {
    expect(code).toMatch(/from "\.\/har2sdk-out\/client\.js"/);
  });

  it("type-checks against the demo's client, with every `// type` comment checked", () => {
    const dir = tmp("readme");
    mkdirSync(join(dir, "har2sdk-out"));
    const r = generateFromHar(readFileSync(DEMO_HAR_PATH, "utf8"));
    writeFileSync(join(dir, "har2sdk-out", "client.ts"), r.files["client.ts"]!);
    // `expr; // T` becomes an exact type-equality check.
    let n = 0;
    const checked = code.replace(/^(.+?);\s+\/\/ (.+)$/gm, (_, expr: string, type: string) => {
      n++;
      return `const value${n} = ${expr.trim()};\nexport const check${n}: Equals<typeof value${n}, ${type.trim()}> = true;`;
    });
    expect(n).toBeGreaterThanOrEqual(2);
    writeFileSync(
      join(dir, "main.ts"),
      `type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;\ndeclare const process: { env: Record<string, string | undefined> };\n${checked}`,
    );
    writeFileSync(join(dir, "package.json"), '{ "type": "module" }');
    writeFileSync(
      join(dir, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { module: "nodenext", moduleResolution: "nodenext", target: "es2022", strict: true, exactOptionalPropertyTypes: true, noEmit: true, lib: ["es2022", "dom"], skipLibCheck: true }, files: ["main.ts"] }),
    );
    const tsc = join(ROOT, "node_modules/typescript/bin/tsc");
    let out = "";
    try {
      execFileSync(process.execPath, [tsc, "-p", join(dir, "tsconfig.json")], { encoding: "utf8" });
    } catch (err) {
      out = String((err as { stdout?: string }).stdout ?? err);
    }
    expect(out).toBe("");
  });

  it("the annotation example names the class the code example imports", () => {
    const imported = code.match(/import \{ (\w+) \}/)![1];
    const json = readme.match(/<summary>Annotation format<\/summary>\s*```json\n([\s\S]*?)```/)![1]!;
    expect(parseAnnotations(json).clientName).toBe(imported);
  });

  it("the CLI's and the MCP server's usage hints import with .js too", () => {
    const dir = tmp("hint");
    const r = cli([DEMO_HAR_PATH, "-o", join(dir, "out")]);
    expect(r.out).toMatch(/from "\.\/.*\/client\.js"/);
  });
});

// ── E6 ─────────────────────────────────────────────────────────────────────────

describe("E6 the security guarantees that had no test", () => {
  it("MCP generate_sdk doesn't overwrite a client.ts it didn't write", async () => {
    const dir = tmp("foreign");
    writeFileSync(join(dir, "c.har"), readFileSync(DEMO_HAR_PATH));
    mkdirSync(join(dir, "out"));
    writeFileSync(join(dir, "out", "client.ts"), "export const mine = 1;\n");
    const { call, close } = await mcp();
    const r = await call("generate_sdk", { har_path: join(dir, "c.har"), out_dir: join(dir, "out") });
    await close();
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/wasn't generated by har2sdk/);
    expect(readFileSync(join(dir, "out", "client.ts"), "utf8")).toBe("export const mine = 1;\n");
    expect(existsSync(join(dir, "out", "openapi.json"))).toBe(false);
  });

  it("MCP generate_sdk refuses to write when the leak guard finds a value, unless allow_leaks", async () => {
    const dir = tmp("leak");
    // An email in a GraphQL comment stays in the document: the guard refuses it.
    writeFileSync(join(dir, "c.har"), har([entry({ method: "POST", url: O + "/graphql", reqBody: { query: "# asked by zeynep.ak@posteo.de\nquery Dash { dash { id } }" }, resBody: { data: { dash: { id: 1 } } } })]));
    const { call, close } = await mcp();
    const refused = await call("generate_sdk", { har_path: join(dir, "c.har"), out_dir: join(dir, "out") });
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/Nothing written/);
    expect(refused.text).not.toContain("zeynep");
    expect(existsSync(join(dir, "out", "client.ts"))).toBe(false);
    const allowed = await call("generate_sdk", { har_path: join(dir, "c.har"), out_dir: join(dir, "out"), allow_leaks: true });
    await close();
    expect(allowed.isError).toBe(false);
    expect(existsSync(join(dir, "out", "client.ts"))).toBe(true);
  });

  it("listenMock binds to 127.0.0.1 by default", async () => {
    const r = generateFromHar(readFileSync(DEMO_HAR_PATH, "utf8"));
    const server = await listenMock(r.model, r.exchanges, { port: 0 });
    try {
      expect((server.address() as AddressInfo).address).toBe("127.0.0.1");
    } finally {
      server.close();
    }
  });

  it("`har2sdk mock` listens on loopback only", async () => {
    const free = await freePort();
    const child = spawn(process.execPath, [CLI, "mock", DEMO_HAR_PATH, "--port", String(free)], { env: { ...process.env, NO_COLOR: "1" } });
    try {
      await new Promise<void>((res, rej) => {
        child.stdout.on("data", (d: Buffer) => d.toString().includes("har2sdk mock") && res());
        child.on("exit", () => rej(new Error("mock exited")));
      });
      expect(await canConnect("127.0.0.1", free)).toBe(true);
      const external = Object.values(networkInterfaces())
        .flat()
        .find((i) => i && i.family === "IPv4" && !i.internal)?.address;
      if (external) expect(await canConnect(external, free)).toBe(false);
    } finally {
      child.kill();
    }
  });
});

/** A port nothing listens on. */
function freePort(): Promise<number> {
  return new Promise((res) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as AddressInfo).port;
      s.close(() => res(port));
    });
  });
}

function canConnect(host: string, port: number): Promise<boolean> {
  return new Promise((res) => {
    const sock = createConnection({ host, port });
    sock.setTimeout(1500);
    sock.on("connect", () => {
      sock.destroy();
      res(true);
    });
    sock.on("error", () => res(false));
    sock.on("timeout", () => {
      sock.destroy();
      res(false);
    });
  });
}

// ── E7 ─────────────────────────────────────────────────────────────────────────

describe("E7 the numbers in README and LAUNCH.md match the repo", () => {
  const fuzz = repoText("test/privacy-fuzz.test.ts");
  const sites = fuzz.slice(fuzz.indexOf("const sites: Record<string, () => void> = {"), fuzz.indexOf("const chosen = r.shuffle(Object.keys(sites))"));
  // The sites, plus the three places every capture has: the profile, the members list and the headers.
  const kinds = [...sites.matchAll(/^ {4}[a-zA-Z]+: \(\) => \{/gm)].length + 3;
  const rounds = readdirSync(join(ROOT, "test")).filter((f) => /^review\d*\.test\.ts$/.test(f)).length;
  const words = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen"];

  for (const file of ["README.md", "docs/LAUNCH.md"]) {
    it(file, () => {
      const text = repoText(file);
      for (const m of text.matchAll(/(\d+) kinds of (?:places|placements)/g)) expect(Number(m[1])).toBe(kinds);
      for (const m of text.matchAll(/\b(\w+) review rounds/gi)) expect(m[1]!.toLowerCase()).toBe(words[rounds]);
      expect(text).not.toMatch(/3,000/);
      expect(text).toMatch(/\d+ kinds of (places|placements)/);
    });
  }
});

// ── E9 ─────────────────────────────────────────────────────────────────────────

describe("E9 --base-url is checked before anything is generated", () => {
  it('"not a url" is an error', () => {
    const dir = tmp("base");
    const r = cli([DEMO_HAR_PATH, "-o", join(dir, "out"), "--base-url", "not a url"]);
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/--base-url/);
    expect(existsSync(join(dir, "out", "client.ts"))).toBe(false);
  });
  it("the library refuses it too", () => {
    expect(() => generateFromHar(readFileSync(DEMO_HAR_PATH, "utf8"), { baseUrl: "ftp://x" })).toThrow(/base URL/i);
  });
  it("a real URL still works", () => {
    expect(generateFromHar(readFileSync(DEMO_HAR_PATH, "utf8"), { baseUrl: "https://shop.example.com/api" }).files["client.ts"]).toContain('"https://shop.example.com/api"');
  });
});

// ── E10 ────────────────────────────────────────────────────────────────────────

describe("E10 deeply nested JSON doesn't overflow the stack", () => {
  const deep = "[".repeat(5000) + "]".repeat(5000);
  it("a response body", () => {
    const r = gen([entry({ url: O + "/api/deep", resText: deep }), entry({ url: O + "/api/ok", resBody: { a: 1 } })]);
    expect(r.plan.ops.map((o) => o.ep.id).sort()).toEqual(["GET /api/deep", "GET /api/ok"]);
    expect(r.warnings.join("\n")).toMatch(/GET \/api\/deep/);
  });
  it("a request body, a tRPC input and GraphQL variables in the query string", () => {
    const r = gen([
      entry({ method: "POST", url: O + "/api/deep", reqBody: deep, resBody: { ok: true } }),
      entry({ url: O + "/api/trpc/item.get?input=" + encodeURIComponent(deep), resBody: { result: { data: 1 } } }),
      entry({ url: O + "/graphql?query=" + encodeURIComponent("query Q { a }") + "&variables=" + encodeURIComponent(deep), resBody: { data: { a: 1 } } }),
    ]);
    expect(r.plan.ops.length).toBe(3);
  });
  it("the CLI", () => {
    const dir = tmp("deep");
    writeFileSync(join(dir, "d.har"), har([entry({ url: O + "/api/deep", resText: deep })]));
    const r = cli(["inspect", join(dir, "d.har")]);
    expect(r.out).not.toMatch(/call stack/);
    expect(r.status).toBe(0);
  });
});

// ── E11 ────────────────────────────────────────────────────────────────────────

describe("E11 error messages say what is wrong and what to do", () => {
  const dir = tmp("msgs");
  const file = (name: string, text: string) => {
    writeFileSync(join(dir, name), text);
    return join(dir, name);
  };

  it("an array of numbers is not a HAR", () => {
    const r = cli(["inspect", file("arr.har", "[1,2,3]")]);
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/None of the 3 entries is a request/);
    expect(r.out).not.toMatch(/filtered as noise/);
  });

  it("entries without a URL", () => {
    const r = cli(["inspect", file("nourl.har", '{"log":{"entries":[{"request":{"method":"GET"},"response":{"status":200}}]}}')]);
    expect(r.out).toMatch(/None of the 1 entries is a request/);
  });

  it("an empty capture", () => {
    const r = cli(["inspect", file("empty.har", '{"log":{"entries":[]}}')]);
    expect(r.out).toMatch(/has no requests/);
    expect(r.out).not.toMatch(/filtered as noise/);
  });

  it("--host that matches nothing names the hosts there are, and doesn't suggest --host", () => {
    const r = cli(["inspect", DEMO_HAR_PATH, "--host", "nope.test"]);
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/None of the 33 requests is on nope\.test/);
    expect(r.out).toContain("acme-shop.test");
    expect(r.out).not.toMatch(/Use --host/);
  });

  it("all noise without --host still suggests it", () => {
    const r = cli(["inspect", file("noise.har", har([entry({ url: "https://www.google-analytics.com/g/collect?v=2&tid=G-1", resourceType: "ping" })]))]);
    expect(r.out).toMatch(/filtered as noise/);
    expect(r.out).toMatch(/--host/);
  });

  it("a truncated file says it is truncated", () => {
    const text = readFileSync(DEMO_HAR_PATH, "utf8");
    for (const cut of [200, Math.floor(text.length / 2), text.length - 40]) {
      const r = cli(["inspect", file(`cut${cut}.har`, text.slice(0, cut))]);
      expect(r.status).toBe(1);
      expect(r.out).toMatch(/cut off/);
      expect(r.out).not.toMatch(/No "log.entries"/);
    }
  });

  it("a folder", () => {
    mkdirSync(join(dir, "folder.har"), { recursive: true });
    const r = cli(["inspect", join(dir, "folder.har")]);
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/is a folder/);
    expect(r.out).not.toMatch(/EISDIR/);
  });

  it("a bad --port", () => {
    const r = cli(["mock", DEMO_HAR_PATH, "--port", "abc"]);
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/--port must be a whole number from 0 to 65535/);
    expect(r.out).not.toMatch(/options\.port/);
  });

  it("MCP: a folder is a clear error too", async () => {
    const { call, close } = await mcp();
    const r = await call("analyze_har", { har_path: join(dir, "folder.har") });
    await close();
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/is a folder/);
  });
});

// ── E12 ────────────────────────────────────────────────────────────────────────

describe("E12 inspect warns about a --param that matched nothing, as generate does", () => {
  it("inspect", () => {
    const r = cli(["inspect", DEMO_HAR_PATH, "--param", "/nomatch/*"]);
    expect(r.out).toContain('--param "/nomatch/*" matched no recorded path');
  });
  it("generate", () => {
    const r = cli([DEMO_HAR_PATH, "-o", join(tmp("param"), "out"), "--param", "/nomatch/*"]);
    expect(r.out).toContain('--param "/nomatch/*" matched no recorded path');
  });
});

// ── E13 ────────────────────────────────────────────────────────────────────────

describe("E13 the fuzz test checks MCP and inspect --json on every seed", () => {
  it("no seed-number condition guards them", () => {
    const fuzz = repoText("test/privacy-fuzz.test.ts");
    expect(fuzz).not.toMatch(/if \(seed < FROM \+ \d\)/);
    expect(fuzz).toMatch(/"inspect --json"/);
    expect(fuzz).toMatch(/"MCP session"/);
  });
});

// ── E14 ────────────────────────────────────────────────────────────────────────

describe("E14 dead code is gone", () => {
  it("templateToRegExp, isEmptyShape, topLevelKeys", () => {
    const src = ["template.ts", "infer.ts"].map((f) => repoText(`src/${f}`)).join("\n");
    for (const name of ["templateToRegExp", "isEmptyShape", "topLevelKeys"]) expect(src).not.toContain(`function ${name}`);
  });
});
