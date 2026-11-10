/**
 * Twenty-third review (v0.6.17): an independent test conversation's list, fourteen items. The code findings are
 * here, each reproduced with the reviewer's input first. One describe block per finding.
 *
 * A1: an empty list or object merged with any type: `{"mode":[]}` and `{"mode":3.14}` became one type, `mode: number`.
 * A2: short sibling ids (`item-1` / `item-4`, `ord_1` / `ord_2`, `abc-1…3`) stayed separate literal endpoints.
 * A3: a recorded key named `$ref` made openapi.json fail openapi-schema-validator.
 * A4: an optional property named after an Object member (`toString`, `constructor`) rejected objects without it.
 * A5: the mock hung on recorded 1xx statuses; `mock --port 0` printed port 0.
 * B7: which origin becomes the client's address (a crafted capture can pick one) was a warning among others.
 * B8: `clientName: "then" | "arguments" | "string"` was accepted and broke the module.
 * B9: a type renamed to `string` broke client.ts, and to `enc` made the run fail.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { HarEntry } from "../src/har.js";
import { generateFromHar } from "../src/index.js";
import { createMcpServer } from "../src/mcp.js";
import { listenMock } from "../src/mock.js";
import { ROOT, entry, har } from "./helpers.js";

const O = "https://app.acme.test";
const CLI = join(ROOT, "dist/cli.js");

function rng(seed: number): () => number {
  return () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
}
const CONSONANTS = "bcdfghjklmnpqrstvwxz";
const VOWELS = "aeiou";
const word = (rnd: () => number, syllables = 3): string => {
  let w = "";
  for (let i = 0; i < syllables; i++) w += CONSONANTS[Math.floor(rnd() * CONSONANTS.length)]! + VOWELS[Math.floor(rnd() * VOWELS.length)]!;
  return w;
};
const tmp = () => mkdtempSync(join(tmpdir(), "har2sdk-r23-"));

/** Compile client.ts (plus extra files) with the project's strict settings; "" when it compiles. */
function compile(files: Record<string, string>): string {
  const dir = tmp();
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  writeFileSync(join(dir, "package.json"), '{ "type": "module" }');
  writeFileSync(
    join(dir, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        noEmit: true,
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        lib: ["ES2022", "DOM"],
        types: ["node"],
        typeRoots: [join(ROOT, "node_modules/@types")],
        exactOptionalPropertyTypes: true,
        erasableSyntaxOnly: true,
        skipLibCheck: true,
      },
      files: Object.keys(files),
    }),
  );
  const r = spawnSync(process.execPath, [join(ROOT, "node_modules/typescript/bin/tsc"), "-p", dir], { encoding: "utf8" });
  return (r.stdout + r.stderr).trim();
}

const lineOf = (code: string, re: RegExp) => code.split("\n").filter((l) => re.test(l));

// ── A1 ─────────────────────────────────────────────────────────────────────────

describe("A1 an empty list or object doesn't stand for another kind", () => {
  it("the reviewer's case: `mode: []` and `mode: 3.14` stay two types", () => {
    const r = generateFromHar(
      har([
        entry({ method: "PUT", url: `${O}/api/v1/settings`, reqBody: { opts: { mode: 3.14 }, n: 1 }, resBody: { ok: true } }),
        entry({ method: "PUT", url: `${O}/api/v1/settings`, reqBody: { opts: { mode: 3.14 }, n: 1 }, resBody: { ok: true } }),
        entry({ url: `${O}/api/v1/config`, resBody: { cfg: { mode: [] }, ok: true } }),
        entry({ url: `${O}/api/v1/config`, resBody: { cfg: { mode: [] }, ok: true } }),
      ]),
    );
    const code = r.files["client.ts"]!;
    expect(code).not.toMatch(/export type (Cfg|Opts) = (Cfg|Opts);/);
    expect(lineOf(code, /^\s+mode: /).sort()).toEqual(["  mode: number;", "  mode: unknown[];"]);
  });

  it("an empty list still merges with a list", () => {
    const r = generateFromHar(
      har([
        entry({ url: `${O}/api/v1/a`, resBody: { box: { tags: ["x"], n: 1 } } }),
        entry({ url: `${O}/api/v1/b`, resBody: { crate: { tags: [], n: 2 } } }),
      ]),
    );
    expect(r.files["client.ts"]).toMatch(/export type (Box|Crate) = (Box|Crate);/);
  });

  // Review 24 (#7): `{}` isn't a `Meta { k: number }`, whose field is required. It merges only with a dictionary.
  it("an empty object doesn't merge with a named type that has required fields", () => {
    const r = generateFromHar(
      har([
        entry({ url: `${O}/api/v1/a`, resBody: { box: { tags: ["x"], meta: { k: 1 } } } }),
        entry({ url: `${O}/api/v1/b`, resBody: { crate: { tags: [], meta: {} } } }),
      ]),
    );
    const code = r.files["client.ts"]!;
    expect(code).not.toMatch(/export type (Box|Crate) = (Box|Crate);/);
    expect(compile({ "client.ts": code + `\nconst crate: Crate = { tags: [], meta: {} };\nvoid crate;` })).toBe("");
  });

  it("null, numbers and strings were already kept apart", () => {
    for (const other of [null, "x", true]) {
      const r = generateFromHar(
        har([entry({ url: `${O}/api/v1/a`, resBody: { box: { mode: 3.14 } } }), entry({ url: `${O}/api/v1/b`, resBody: { crate: { mode: other } } })]),
      );
      expect(r.files["client.ts"], String(other)).not.toMatch(/export type (Box|Crate) = (Box|Crate);/);
    }
  });

  it("generated: an empty list never becomes a scalar type", () => {
    const rnd = rng(23_1);
    for (let i = 0; i < 30; i++) {
      const key = word(rnd, 2);
      const scalar = [3.14, 7, "text", false][Math.floor(rnd() * 4)];
      const r = generateFromHar(
        har([
          entry({ url: `${O}/api/v1/${word(rnd)}s`, resBody: { [word(rnd)]: { [key]: scalar } } }),
          entry({ url: `${O}/api/v1/${word(rnd)}s`, resBody: { [word(rnd)]: { [key]: [] } } }),
        ]),
      );
      const props = lineOf(r.files["client.ts"]!, new RegExp(`^\\s+${key}: `));
      expect(props.some((l) => l.includes("[]")), `${key}: ${props.join(" / ")}`).toBe(true);
    }
  });
});

// ── A2 ─────────────────────────────────────────────────────────────────────────

describe("A2 short ids of one family are one parameter", () => {
  const paths = (urls: string[]) => generateFromHar(har(urls.map((u) => entry({ url: O + u, resBody: { id: 1, title: "x" } })))).model.endpoints.map((e) => e.path).sort();

  it("the reviewer's cases: item-1 / item-4, ord_1 / ord_2, abc-1…3", () => {
    expect(paths(["/api/v1/items/item-1", "/api/v1/items/item-4"])).toEqual(["/api/v1/items/{itemId}"]);
    expect(paths(["/api/v1/orders/ord_1", "/api/v1/orders/ord_2"])).toEqual(["/api/v1/orders/{orderId}"]);
    expect(paths(["/api/v1/x/abc-1", "/api/v1/x/abc-2", "/api/v1/x/abc-3"])).toHaveLength(1);
  });

  it("different words stay apart: /users/me, /users/list; and two bare-number words (step1, step2)", () => {
    expect(paths(["/api/v1/users/me", "/api/v1/users/list"])).toEqual(["/api/v1/users/list", "/api/v1/users/me"]);
    expect(paths(["/api/v1/wizard/step1", "/api/v1/wizard/step2"])).toHaveLength(2);
    expect(paths(["/api/v1/items/item-1", "/api/v1/items/order-2"])).toHaveLength(2);
  });

  it("different payloads stay apart", () => {
    const r = generateFromHar(
      har([
        entry({ url: `${O}/api/v1/reports/r-1`, resBody: { a: 1, b: 2, c: 3 } }),
        entry({ url: `${O}/api/v1/reports/r-2`, resBody: { x: 1, y: 2, z: 3 } }),
      ]),
    );
    expect(r.model.endpoints).toHaveLength(2);
  });

  it("generated: a random prefix with 2–5 numbered members is one endpoint", () => {
    const rnd = rng(23_2);
    for (let i = 0; i < 30; i++) {
      const prefix = word(rnd, 1 + Math.floor(rnd() * 2));
      const sep = ["-", "_", "."][Math.floor(rnd() * 3)]!;
      const n = 2 + Math.floor(rnd() * 4);
      const urls = Array.from({ length: n }, (_, j) => `/api/v1/${word(rnd)}s/${prefix}${sep}${j * 3 + 1}`.replace(/\/[^/]+s\//, "/things/"));
      expect(paths(urls), urls.join(" ")).toHaveLength(1);
    }
  });
});

// ── A3 ─────────────────────────────────────────────────────────────────────────

/** Every object in a JSON value that has a `$ref` key (references and nothing else may). */
function refHolders(v: unknown, out: object[] = []): object[] {
  if (v && typeof v === "object") {
    if (!Array.isArray(v) && Object.prototype.hasOwnProperty.call(v, "$ref")) out.push(v);
    for (const x of Object.values(v)) refHolders(x, out);
  }
  return out;
}

describe("A3 a recorded `$ref` key isn't written where a reference would be", () => {
  it("the reviewer's case: a response with a `$ref` key", () => {
    const r = generateFromHar(har([entry({ url: `${O}/api/v1/schema`, resBody: { $ref: "#/definitions/x", a: 1 } })]));
    const spec = JSON.parse(r.files["openapi.json"]!);
    for (const h of refHolders(spec)) expect(typeof (h as { $ref: unknown }).$ref, JSON.stringify(h)).toBe("string");
    const schema = Object.values(spec.components.schemas)[0] as { patternProperties: Record<string, unknown>; required: string[] };
    expect(Object.keys(schema.patternProperties)).toEqual(["^\\$ref$"]);
    expect(schema.required).toContain("$ref");
    // client.ts keeps the key as is.
    expect(r.files["client.ts"]).toContain("  $ref: string;");
  });

  it("generated: `$ref` / `$dynamicRef` keys at any depth never hold a schema", () => {
    const rnd = rng(23_3);
    for (let i = 0; i < 20; i++) {
      const key = rnd() < 0.5 ? "$ref" : "$dynamicRef";
      let body: Record<string, unknown> = { [key]: rnd() < 0.5 ? "x" : { inner: 1 }, [word(rnd)]: 1 };
      for (let d = Math.floor(rnd() * 3); d > 0; d--) body = { [word(rnd)]: body };
      const spec = JSON.parse(generateFromHar(har([entry({ url: `${O}/api/v1/${word(rnd)}`, resBody: body })])).files["openapi.json"]!);
      for (const h of refHolders(spec)) expect(typeof (h as { $ref: unknown }).$ref).toBe("string");
      expect(JSON.stringify(spec)).not.toContain(`"$dynamicRef":{`);
    }
  });
});

// ── A4 ─────────────────────────────────────────────────────────────────────────

describe("A4 Object member names as optional properties accept the recorded objects", () => {
  it("the reviewer's keys: every recorded object is assignable, under strict settings", () => {
    const samples = [{ constructor: "x", toString: 1, valueOf: true, hasOwnProperty: "y", ok: 1 }, { ok: 2 }, { constructor: { a: 1 }, ok: 3 }];
    const r = generateFromHar(har([entry({ url: `${O}/api/v1/proto`, resBody: samples })]));
    const type = r.plan.ops[0]!.response.typeName;
    const errors = compile({ "client.ts": r.files["client.ts"]!, "use.ts": `import type { ${type} as T } from "./client.js";\nexport const x: T = ${JSON.stringify(samples)};\n` });
    expect(errors).toBe("");
  });
});

// ── A5 ─────────────────────────────────────────────────────────────────────────

describe("A5 the mock answers recorded 1xx / 0 statuses, and prints the port it got", () => {
  const status = (s: number): HarEntry => {
    const e = entry({ url: `${O}/api/v1/thing`, resBody: { a: 1 } });
    e.response.status = s;
    return e;
  };

  it("the reviewer's statuses 100, 101, 103, 199 and 0: a final answer within a second", async () => {
    for (const s of [100, 101, 103, 199, 0]) {
      const r = generateFromHar(har([status(s), entry({ url: `${O}/api/v1/other`, resBody: [{ id: 1 }] })]), { keepFailed: true } as never);
      const server = await listenMock(r.model, r.exchanges, { port: 0 });
      try {
        const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/thing`, { signal: AbortSignal.timeout(1000) });
        expect(res.status, String(s)).toBeGreaterThanOrEqual(200);
        await res.text();
      } finally {
        server.closeAllConnections();
        server.close();
      }
    }
  });

  it("`mock --port 0` prints the port the system picked", async () => {
    const dir = tmp();
    writeFileSync(join(dir, "c.har"), har([entry({ url: `${O}/api/v1/items`, resBody: [{ id: 1 }] })]));
    const child = spawn(process.execPath, [CLI, "mock", join(dir, "c.har"), "--port", "0"], { env: { ...process.env, NO_COLOR: "1" } });
    let out = "";
    const port = await new Promise<number>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("no port printed: " + out)), 15_000);
      child.stdout.on("data", (d) => {
        out += String(d);
        const m = /http:\/\/localhost:(\d+)/.exec(out);
        if (m) {
          clearTimeout(t);
          resolve(Number(m[1]));
        }
      });
    });
    try {
      expect(port).toBeGreaterThan(0);
      const res = await fetch(`http://127.0.0.1:${port}/api/v1/items`);
      expect(res.status).toBe(200);
    } finally {
      child.kill();
    }
  });
});

// ── B7 ─────────────────────────────────────────────────────────────────────────

describe("B7 which origin gets the credentials is said first", () => {
  const crafted = har([
    entry({ url: "https://collect.attacker.example/api/a", reqHeaders: { authorization: "Bearer opaque-token-7f3k9q2m" }, resBody: { ok: 1 } }),
    entry({ url: `${O}/api/v1/items`, resBody: [{ id: 1 }] }),
    entry({ url: `${O}/api/v1/orders`, resBody: [{ id: 2 }] }),
  ]);
  const client = new Client({ name: "test", version: "0.0.0" });
  const server = createMcpServer();
  beforeAll(async () => {
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
  });
  afterAll(async () => {
    await client.close();
  });

  it("MCP analyze_har starts with a primaryOriginWarning field", async () => {
    const dir = tmp();
    writeFileSync(join(dir, "c.har"), crafted);
    const res = (await client.callTool({ name: "analyze_har", arguments: { har_path: join(dir, "c.har") } })) as { content: { text: string }[] };
    const text = res.content.map((c) => c.text).join("\n");
    expect(text.startsWith("primaryOriginWarning: The client's default address (baseUrl) is https://collect.attacker.example")).toBe(true);
  });

  it("the CLI prints it last after generating, and inspect --json has the field", () => {
    const dir = tmp();
    writeFileSync(join(dir, "c.har"), crafted);
    const gen = spawnSync(process.execPath, [CLI, join(dir, "c.har"), "-o", join(dir, "out")], { encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });
    expect(gen.stdout.trimEnd().split("\n").slice(-12).join("\n")).toMatch(/default address \(baseUrl\) is https:\/\/collect\.attacker\.example/);
    const insp = spawnSync(process.execPath, [CLI, "inspect", join(dir, "c.har"), "--json"], { encoding: "utf8" });
    expect(JSON.parse(insp.stdout).primaryOriginWarning).toMatch(/collect\.attacker\.example/);
  });

  it("a single-origin capture has no such warning", () => {
    expect(generateFromHar(har([entry({ url: `${O}/api/v1/items`, resBody: [{ id: 1 }] })])).model.primaryOriginWarning).toBeUndefined();
  });
});

// ── B8 / B9 ────────────────────────────────────────────────────────────────────

describe("B8 / B9 reserved client and type names are refused with a warning", () => {
  const capture = har([
    entry({ url: `${O}/api/v1/items/7`, resBody: { id: 7, price: { amount: 1, currency: "EUR" } } }),
    entry({ url: `${O}/api/v1/items/8`, resBody: { id: 8, price: { amount: 1, currency: "EUR" } } }),
  ]);

  it("the reviewer's client names: then, arguments, string (and other TypeScript type names)", () => {
    for (const clientName of ["then", "arguments", "eval", "string", "number", "unknown", "never", "undefined"]) {
      const r = generateFromHar(capture, { annotations: { clientName } });
      expect(r.plan.clientName, clientName).not.toBe(clientName);
      expect(r.warnings.join("\n"), clientName).toMatch(/can't be a class name/);
    }
  });

  it("type renames to string, enc, then or a keyword: a warning, and client.ts still compiles", () => {
    const type = generateFromHar(capture).plan.registry.types.find((t) => t.props.some((p) => p.name === "currency"))!.name;
    for (const to of ["string", "enc", "then", "class", "number", "ApiError"]) {
      const r = generateFromHar(capture, { annotations: { types: { [type]: to } } });
      expect(r.warnings.join("\n"), to).toMatch(new RegExp(`Can't rename type "${type}"`));
      expect(compile({ "client.ts": r.files["client.ts"]! }), to).toBe("");
    }
  });

  it("generated: random valid names are still accepted", () => {
    const rnd = rng(23_9);
    for (let i = 0; i < 20; i++) {
      const name = word(rnd).replace(/^./, (c) => c.toUpperCase()) + "Client";
      expect(generateFromHar(capture, { annotations: { clientName: name } }).plan.clientName).toBe(name);
    }
  });
});
