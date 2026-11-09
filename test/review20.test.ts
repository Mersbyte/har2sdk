/**
 * Twentieth review (v0.6.15): a full audit before launch. One describe block per finding, each reproduced with the
 * reviewer's input before it was fixed, plus a generated variant where one fits. IDs are the review's.
 *
 * C1-01: a redirect carried the API-key header, `headers` and the recorded default headers to another origin.
 * C1-02: `baseUrl` (the only origin that gets credentials) was the origin with the most endpoints, so a vendor
 *        with more endpoints got the token and the app's own API got none.
 * C2-01: a JSON request body that is an array of objects (also JSON Patch, `eth_call` params, tRPC batch input)
 *        declared its type name twice, so client.ts didn't compile, and the CLI still exited 0.
 * DJ-01/DJ-02 (and B2-01): `openapi.json` path keys kept quotes, backticks, `${…}` and braces from a recorded URL raw:
 *        swagger-typescript-api 13.12.1 and openapi-typescript-codegen pasted them into code that ran, and a recorded
 *        `{tenantId}` became a path template with no parameter.
 * DJ-04: operations on another origin inherited the document-wide `security`, so a client generated from the spec
 *        sent the main token to the third party. DJ-05: GraphQL / JSON-RPC / tRPC operations on another origin had
 *        no `servers`, and replaced the API's own operation on the same path without a warning.
 * FG-04: the default mock replayed a recorded login and token from a text body that starts with "[" or "{" but isn't
 *        JSON (an INI file, a log line): it was read as truncated JSON, where bare words are kept.
 * FG-05: the default mock replayed them from markup structure: tag and attribute names, `<?…?>` and `<!…>`.
 * A1-04: a person's one-word name (under `name`, `displayName`, `first_name`…) used after a people collection
 *        (`/users/dorukbey`) stayed a literal, so every such app was refused (exit 2); `username` worked.
 * A1-02: a known username after a prefix that isn't a plural word (`/u/…`, `/in/…`, `/api/v1/…/feed`) or behind a
 *        sigil (`/@dorukbey`, `/~dorukbey`) stayed a literal: refused (exit 2).
 * A2-08: `returnTo`, `redirect_to`, `sortedBy`, `poweredBy`, `importedFrom` (and GraphQL `from` / `to` / `by`
 *        arguments) were strong identity keys: an app word under them refused its own top-level endpoint.
 * A2-02 (part): a mailbox's local part (`orders@shop.example`) refused `/api/v1/orders/48213`, `/api/v1beta/orders`,
 *        `/admin/api/2024-01/orders.json`: only the last segment right after `api` or `v1` was exempt.
 * C1-03: a path parameter "..", "." or "" changed the path requested (`deleteUserSessions({ userId: ".." })`
 *        sent `DELETE /api/v1/sessions`).
 * C1-04: header names were merged case-sensitively: `headers: { Authorization }` was sent next to the token.
 * C1-05: an XML / CSV / SOAP request body was sent as `text/plain`, not the recorded media type.
 * E-04: MCP `generate_sdk` with no matching endpoint (a typo in `hosts`) replaced a working client.ts with an
 *        empty one and reported success.
 * H-04: reading `<meta name=… content=…>` pairs was quadratic on unclosed tags: seconds per 200 KB HTML body.
 * A1-01: a refused run's overview (exit 2), plain `inspect` and the CLI's warnings printed the value the guard knew
 *        (a dropped request's path, a literal path segment), next to "please report it".
 * FG-03: `mock --bind` with anything but loopback accepted every Host header, so a DNS-rebinding page could read
 *        the mock; the warning only mentioned the local network.
 * I-01: the README's MCP setup (`npx -y har2sdk mcp`) was unpinned: every editor start could run a newer release.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import * as httpModule from "node:http";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Validator } from "@seriousme/openapi-schema-validator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertUniqueDeclarations } from "../src/codegen.js";
import { generateFromHar } from "../src/index.js";
import { isJsonPrefix, namedValues } from "../src/leak.js";
import { createMcpServer } from "../src/mcp.js";
import { listenMock } from "../src/mock.js";
import { ROOT, entry, har } from "./helpers.js";

const O = "https://app.acme.test";
const CLI = join(ROOT, "dist/cli.js");
const THIRD = "https://rates.thirdparty.test";
const SLOW = { timeout: 120_000 };

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
const pick = <T,>(rnd: () => number, xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "har2sdk-r20-"));
}

async function load(code: string): Promise<any> {
  const dir = tmp();
  writeFileSync(join(dir, "client.ts"), code);
  return import(pathToFileURL(join(dir, "client.ts")).href);
}

/** Compile a generated client.ts with the project's strict settings (as test/e2e.test.ts does). */
function compile(code: string): string {
  const dir = tmp();
  writeFileSync(join(dir, "client.ts"), code);
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
      files: ["client.ts"],
    }),
  );
  const r = spawnSync(process.execPath, [join(ROOT, "node_modules/typescript/bin/tsc"), "-p", dir], { encoding: "utf8" });
  return (r.stdout + r.stderr).trim();
}

function generate(capture: string) {
  const r = generateFromHar(capture);
  expect(r.leaks).toEqual([]);
  return r;
}

interface Seen {
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
  body: string;
}
interface TestServer {
  url: string;
  seen: Seen[];
  close(): Promise<void>;
}
/** A server on 127.0.0.1 (each port is its own origin). `handle` may answer itself; otherwise 200 `{}`. */
async function serve(handle?: (req: IncomingMessage, res: ServerResponse) => boolean): Promise<TestServer> {
  const seen: Seen[] = [];
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ method: req.method!, url: req.url!, headers: req.headers, body });
      if (handle?.(req, res)) return;
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, seen, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

// ── C1-01 ──────────────────────────────────────────────────────────────────────

describe("C1-01 credentials and app headers never follow a redirect to another origin", () => {
  const STYLES = {
    bearer: { hdr: { authorization: "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJlLXNpZ25hdHVyZQ" }, opts: { token: "TOKEN-SECRET" } },
    basic: { hdr: { authorization: "Basic " + Buffer.from("demo:pw-synthetic").toString("base64") }, opts: { basicAuth: { username: "u", password: "BASIC-SECRET" } } },
    apiKeyHeader: { hdr: { "x-api-key": "k_live_3f9a8b7c6d5e4f3a" }, opts: { apiKey: "APIKEY-HDR-SECRET" } },
    apiKeyQuery: { q: "?api_key=k_live_3f9a8b7c6d5e4f3a", hdr: {}, opts: { apiKey: "APIKEY-QUERY-SECRET" } },
    cookie: { hdr: { cookie: "sid=s3ss10nvalue77" }, opts: { cookie: "sid=COOKIE-SECRET" } },
  } as const;
  type Style = keyof typeof STYLES;
  const SECRETS = ["TOKEN-SECRET", "BASIC-SECRET", Buffer.from("u:BASIC-SECRET").toString("base64"), "APIKEY-HDR-SECRET", "APIKEY-QUERY-SECRET", "COOKIE-SECRET", "HEADERS-OPT-SECRET", "3.4.1"];

  let a: TestServer;
  let b: TestServer;
  let code = 0;
  let target = "";
  beforeAll(async () => {
    b = await serve();
    a = await serve((req, res) => {
      const search = new URL(req.url!, "http://x").search;
      // "/hop…" is a same-origin first hop that then leaves for the other server.
      if (code && req.url!.startsWith("/hop")) res.writeHead(code, { location: `${b.url}/final${search}` });
      else if (!code || req.url!.startsWith("/final")) return false;
      else res.writeHead(code, { location: `${target}/final${search}` });
      res.end();
      return true;
    });
  });
  afterAll(async () => {
    await a.close();
    await b.close();
  });

  const capture = (style: Style, multi: boolean, third = THIRD) => {
    const s = STYLES[style];
    const q = "q" in s ? s.q : "";
    const hdr = { ...s.hdr, "x-client-version": "3.4.1" };
    const entries = [
      entry({ url: `${O}/api/v1/items${q}`, reqHeaders: hdr, resBody: [{ id: 1, price: 2 }] }),
      entry({ url: `${O}/api/v1/orders${q}`, reqHeaders: hdr, resBody: [{ id: 2, total: 5 }] }),
      entry({ method: "POST", url: `${O}/api/v1/orders${q}`, reqHeaders: hdr, reqBody: { sku: "abc", qty: 1 }, resBody: { id: 3 } }),
    ];
    if (multi) entries.push(entry({ url: `${third}/v1/rates`, resBody: { usd: 1 } }));
    return har(entries);
  };
  const leaked = (seen: Seen): string[] => SECRETS.filter((x) => JSON.stringify(seen.headers).includes(x) || seen.url.includes(x));

  it("the reviewer's matrix: no secret reaches the other origin, for any auth style or redirect code", SLOW, async () => {
    for (const multi of [false, true]) {
      for (const style of Object.keys(STYLES) as Style[]) {
        const r = generate(capture(style, multi));
        const mod = await load(r.files["client.ts"]!);
        for (const c of [301, 302, 303, 307, 308]) {
          b.seen.length = 0;
          code = c;
          target = b.url;
          const client = new mod[r.plan.clientName]({ ...STYLES[style].opts, baseUrl: a.url, headers: { "x-tenant": "HEADERS-OPT-SECRET" } });
          await client.listOrders();
          expect(b.seen.length, `${style} ${c}`).toBe(1);
          expect(leaked(b.seen[0]!), `${style} ${c} multi=${multi}`).toEqual([]);
        }
      }
    }
    code = 0;
  });

  it("a same-origin redirect (a trailing-slash fix) still carries the credentials", async () => {
    const r = generate(capture("apiKeyHeader", false));
    const mod = await load(r.files["client.ts"]!);
    a.seen.length = 0;
    code = 308;
    target = a.url;
    await new mod[r.plan.clientName]({ apiKey: "K1", baseUrl: a.url, headers: { "x-tenant": "t1" } }).listItems();
    code = 0;
    expect(a.seen.map((s) => s.url)).toEqual(["/api/v1/items", "/final"]);
    expect(a.seen[1]!.headers["x-api-key"]).toBe("K1");
    expect(a.seen[1]!.headers["x-tenant"]).toBe("t1");
  });

  it("a redirect to a trusted origin carries them; per-call headers go only to the origin the call was made to", async () => {
    const r = generate(capture("apiKeyHeader", true));
    const mod = await load(r.files["client.ts"]!);
    b.seen.length = 0;
    code = 307;
    target = b.url;
    const client = new mod[r.plan.clientName]({ apiKey: "K2", baseUrl: a.url, trustedOrigins: [b.url] });
    await client.listItems({ headers: { "x-call": "c1" } });
    code = 0;
    expect(b.seen[0]!.headers["x-api-key"]).toBe("K2");
    expect(b.seen[0]!.headers["x-call"]).toBeUndefined();
  });

  it("303, and 301/302 after a POST, become a GET without the body; 307/308 keep method and body", async () => {
    const r = generate(capture("apiKeyHeader", false));
    const mod = await load(r.files["client.ts"]!);
    for (const [c, method, body] of [
      [303, "GET", ""],
      [302, "GET", ""],
      [307, "POST", '{"sku":"x","qty":2}'],
    ] as const) {
      b.seen.length = 0;
      code = c;
      target = b.url;
      await new mod[r.plan.clientName]({ baseUrl: a.url }).createOrder({ sku: "x", qty: 2 });
      expect(b.seen[0]!.method).toBe(method);
      expect(b.seen[0]!.body).toBe(body);
      expect(b.seen[0]!.headers["content-type"]).toBe(body ? "application/json" : undefined);
    }
    code = 0;
  });

  it("a redirect loop stops with an error", async () => {
    const r = generate(capture("bearer", false));
    const mod = await load(r.files["client.ts"]!);
    code = 302;
    target = a.url + "/loop";
    // "/loop/final…" doesn't start with "/final", so it redirects again, forever.
    await expect(new mod[r.plan.clientName]({ baseUrl: a.url }).listItems()).rejects.toThrow(/too many redirects/);
    code = 0;
  });

  it("generated: random auth styles, codes, hops and hosts never hand a secret to another origin", SLOW, async () => {
    const rnd = rng(20_1);
    for (let i = 0; i < 14; i++) {
      const style = pick(rnd, Object.keys(STYLES) as Style[]);
      const multi = rnd() < 0.5;
      const r = generate(capture(style, multi, `https://${word(rnd)}.${word(rnd, 2)}.example`));
      const mod = await load(r.files["client.ts"]!);
      b.seen.length = 0;
      code = pick(rnd, [301, 302, 303, 307, 308]);
      // Sometimes hop on the same origin first, then leave it.
      target = rnd() < 0.5 ? b.url : `${a.url}/hop`;
      const client = new mod[r.plan.clientName]({ ...STYLES[style].opts, baseUrl: a.url, headers: { "x-tenant": "HEADERS-OPT-SECRET" } });
      await client[pick(rnd, ["listItems", "listOrders"])]();
      expect(b.seen.length).toBe(1);
      for (const s of b.seen) expect(leaked(s), `${style} ${code}`).toEqual([]);
    }
    code = 0;
  });
});

// ── C1-02 ──────────────────────────────────────────────────────────────────────

describe("C1-02 baseUrl is the origin the app sent its credentials to, not the biggest one", () => {
  const APP = "https://app.acme.test";
  const MAPS = "https://tiles.mapvendor.test";
  const JWT = "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJlLXNpZ25hdHVyZQ";
  const recorder = () => {
    const calls: { url: string; headers: Record<string, string> }[] = [];
    const fetch = async (url: URL, init: RequestInit) => {
      calls.push({ url: String(url), headers: { ...(init.headers as Record<string, string>) } });
      return new Response("{}", { headers: { "content-type": "application/json" } });
    };
    return { calls, fetch };
  };

  it("the reviewer's capture: 2 app endpoints with auth, 5 vendor endpoints without", async () => {
    const auth = { authorization: JWT, "x-api-key": "k_live_3f9a8b7c6d5e4f3a" };
    const r = generate(
      har([
        entry({ url: APP + "/api/v1/orders", reqHeaders: auth, resBody: [{ id: 1, total: 5 }] }),
        entry({ url: APP + "/api/v1/profile", reqHeaders: auth, resBody: { id: 1, plan: "pro" } }),
        ...["styles", "fonts", "sprites", "tilesets", "geocode"].map((p) => entry({ url: `${MAPS}/v4/${p}`, resBody: { ok: true } })),
      ]),
    );
    expect(r.plan.baseUrl).toBe(APP);
    const mod = await load(r.files["client.ts"]!);
    const { calls, fetch } = recorder();
    const c = new mod[r.plan.clientName]({ token: "USER-TOKEN", apiKey: "USER-KEY", fetch });
    for (const op of r.plan.ops) await c[op.ep.name]();
    for (const call of calls) expect(call.headers.authorization === "Bearer USER-TOKEN", call.url).toBe(new URL(call.url).origin === APP);
  });

  it("among origins with credentials the strongest wins, and the user is told about the other", () => {
    const r = generate(
      har([
        entry({ url: APP + "/api/v1/orders", reqHeaders: { authorization: JWT }, resBody: [{ id: 1, total: 5 }] }),
        ...["styles", "fonts", "sprites"].map((p) => entry({ url: `${MAPS}/v4/${p}?key=pk_3f9a8b7c6d5e4f3a`, resBody: { ok: true } })),
      ]),
    );
    expect(r.plan.baseUrl).toBe(APP);
    expect(r.model.warnings.join("\n")).toContain(`Credentials were also recorded on ${MAPS}`);
  });

  it("with no credentials anywhere, the origin with the most endpoints still wins", () => {
    const r = generate(
      har([
        entry({ url: APP + "/api/v1/orders", resBody: [{ id: 1, total: 5 }] }),
        ...["styles", "fonts"].map((p) => entry({ url: `${MAPS}/v4/${p}`, resBody: { ok: true } })),
      ]),
    );
    expect(r.plan.baseUrl).toBe(MAPS);
  });

  it("generated: the credentialed origin is baseUrl whatever the endpoint counts and auth style", SLOW, () => {
    const rnd = rng(20_2);
    const styles = [
      { authorization: JWT },
      { "x-api-key": "k_live_3f9a8b7c6d5e4f3a" },
      { cookie: "sessionid=s3ss10nvalue77" },
    ];
    for (let i = 0; i < 40; i++) {
      const app = `https://${word(rnd)}.example`;
      const vendor = `https://${word(rnd)}.${word(rnd, 2)}.test`;
      const hdr = pick(rnd, styles);
      const nApp = 1 + Math.floor(rnd() * 4);
      const nVendor = 1 + Math.floor(rnd() * 6);
      const entries = [];
      for (let k = 0; k < nApp; k++) entries.push(entry({ url: `${app}/api/v1/${word(rnd, 2)}s${k}`, reqHeaders: hdr, resBody: [{ id: 1, total: 5 }] }));
      for (let k = 0; k < nVendor; k++) entries.push(entry({ url: `${vendor}/v4/${word(rnd, 2)}s${k}`, resBody: { ok: true } }));
      const r = generateFromHar(har(entries));
      expect(r.plan.baseUrl, JSON.stringify({ hdr, nApp, nVendor })).toBe(app);
    }
  });
});

// ── C2-01 ──────────────────────────────────────────────────────────────────────

describe("C2-01 an array request body gets an alias and an item type, and the client compiles", () => {
  const post = (url: string, body: unknown, resBody: unknown = { ok: true }) => entry({ method: "POST", url, reqBody: body, resBody });

  it("the reviewer's capture: POST /api/v1/cart/items with [{sku, qty}, …]", () => {
    const A = "https://api.shop.example";
    const r = generate(har([0, 1, 2].map((i) => post(`${A}/api/v1/cart/items`, [{ sku: "SKU-1" + i, qty: i + 1 }, { sku: "SKU-2" + i, qty: 1 }]))));
    const code = r.files["client.ts"]!;
    expect(code).toContain("export type CreateCartItemBody = CreateCartItemBodyItem[];");
    expect(compile(code)).toBe("");
  }, SLOW.timeout);

  it("JSON Patch, eth_call positional params and a tRPC array input compile too", () => {
    const r = generate(
      har([
        ...[0, 1].map((i) => entry({ method: "PATCH", url: `https://api.shop.example/api/v1/products/${100 + i}`, reqMime: "application/json-patch+json", reqBody: [{ op: "replace", path: "/price", value: 5 + i }], resBody: { id: 100 + i } })),
        ...[1, 2, 3].map((i) => post("https://rpc.chain.example/", { jsonrpc: "2.0", id: i, method: "eth_call", params: [{ to: "0x" + "ab".repeat(20), data: "0x70a08231" }, "latest"] }, { jsonrpc: "2.0", id: i, result: "0x00" })),
        ...[0, 1, 2].map((i) => post("https://rpc.chain.example/api/trpc/items.bulkAdd", [{ sku: "A" + i }], { result: { data: { n: 1 } } })),
      ]),
    );
    expect(compile(r.files["client.ts"]!)).toBe("");
  }, SLOW.timeout);

  it("an array error body (`[{message}]`) doesn't clash with its alias either", () => {
    const r = generate(har([0, 1].map((i) => entry({ method: "POST", url: "https://api.shop.example/api/v1/orders", status: 422, reqBody: { qty: i }, resBody: [{ message: "qty too low", field: "qty" }] }))));
    expect(compile(r.files["client.ts"]!)).toBe("");
  }, SLOW.timeout);

  it("a top-level name declared twice fails the run instead of writing a broken client", () => {
    expect(() => assertUniqueDeclarations("export interface A {}\nexport type A = A[];\n")).toThrow(/declares `A` twice/);
    expect(() => assertUniqueDeclarations("export interface A {}\n  type A = 1;\n")).not.toThrow();
  });

  it("generated: random array, union and nested bodies all compile", SLOW, () => {
    const rnd = rng(20_3);
    const bodies: string[] = [];
    const ops: ReturnType<typeof entry>[] = [];
    for (let i = 0; i < 16; i++) {
      const res = `${word(rnd, 2)}s`;
      const item = () => ({ [word(rnd, 2)]: Math.floor(rnd() * 9), [word(rnd, 2)]: { [word(rnd, 2)]: true } });
      const body = pick(rnd, [() => [item(), item()], () => [[item()]], () => ({ list: [item()] }), () => [item(), null], () => [1, 2]])();
      bodies.push(JSON.stringify(body));
      ops.push(post(`https://api.shop.example/api/v1/${res}`, body), post(`https://api.shop.example/api/v1/${res}`, body));
    }
    const r = generate(har(ops));
    expect(compile(r.files["client.ts"]!), bodies.join("\n")).toBe("");
  });
});

// ── DJ-01 / DJ-02 ──────────────────────────────────────────────────────────────

describe("DJ-01/DJ-02 openapi.json path keys are encoded: no quote, backtick, brace or comment end from the capture", () => {
  const A = "https://api.evil.test";
  /** A path key holds only URL characters that can't end a string or a comment, and every {template} is a declared parameter. */
  const checkSpec = async (spec: any) => {
    for (const [key, item] of Object.entries<any>(spec.paths)) {
      expect(key, key).not.toMatch(/["'`\\<>^|\s]|\*\/|\$\{/);
      const declared = new Set<string>();
      for (const op of Object.values<any>(item)) for (const p of op.parameters ?? []) if (p.in === "path") declared.add(p.name);
      for (const op of Object.values<any>(item)) if (op.summary) expect(op.summary).not.toMatch(/["'`\\]|\*\/|\$\{/);
      for (const m of key.matchAll(/\{([^}]*)\}/g)) expect(declared.has(m[1]!), `${key}: {${m[1]}}`).toBe(true);
    }
    expect(await new Validator().validate(spec)).toMatchObject({ valid: true });
  };

  it("the reviewer's capture: quotes, a backtick, ${…} and an unexpanded {tenantId}", async () => {
    const segs = ["'+process.exit(7)+'", "`+process.exit(8)+`", "${process.exit(9)}", '"+process.exit(10)+"', "{tenantId}", "{{id}}", "a*"];
    const entries = segs.flatMap((seg, i) => [0, 1, 2].map(() => entry({ url: `${A}/v1/x${i}/${encodeURIComponent(seg)}/list`, resBody: [{ id: 1 }] })));
    const r = generateFromHar(har(entries));
    const spec = JSON.parse(r.files["openapi.json"]!);
    await checkSpec(spec);
    expect(Object.keys(spec.paths)).toContain("/v1/x4/%7BtenantId%7D/list");
    expect(r.files["openapi.json"]).not.toContain("process.exit(7)+'");
  });

  it("/odata/$metadata keeps its $", () => {
    const r = generateFromHar(har([entry({ url: `${A}/odata/$metadata`, resBody: { a: 1 } })]));
    expect(Object.keys(JSON.parse(r.files["openapi.json"]!).paths)).toEqual(["/odata/$metadata"]);
  });

  it("generated: random hostile literal segments never reach a path key or summary raw", SLOW, async () => {
    const rnd = rng(20_4);
    const alphabet = "'\"`${}()\\+;*/!<>^| ab";
    for (let i = 0; i < 12; i++) {
      const entries = [];
      for (let k = 0; k < 4; k++) {
        let seg = "";
        for (let j = 0; j < 3 + Math.floor(rnd() * 8); j++) seg += alphabet[Math.floor(rnd() * alphabet.length)];
        for (let n = 0; n < 3; n++) entries.push(entry({ url: `${A}/v1/r${k}/${encodeURIComponent(seg)}/list`, resBody: [{ id: 1 }] }));
      }
      const r = generateFromHar(har(entries));
      await checkSpec(JSON.parse(r.files["openapi.json"]!));
    }
  });
});

// ── DJ-04 / DJ-05 ──────────────────────────────────────────────────────────────

describe("DJ-04/DJ-05 operations on another origin need no credentials and never replace the API's own", () => {
  const API = "https://api.shop.test";
  const JWT = "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJlLXNpZ25hdHVyZQ";
  const ops = (spec: any) =>
    Object.entries<any>(spec.paths).flatMap(([path, item]) => Object.entries<any>(item).map(([method, op]) => ({ path, method, op })));

  it("the reviewer's capture: an unauthenticated CDN config call carries `security: []` and its own server", async () => {
    const auth = { authorization: JWT };
    const r = generate(
      har([
        entry({ url: `${API}/v1/orders`, reqHeaders: auth, resBody: [{ id: 1, total: 2 }] }),
        entry({ url: `${API}/v1/me`, reqHeaders: auth, resBody: { id: 1, plan: "pro" } }),
        entry({ url: "https://cdn.other.test/v1/config", resBody: { theme: "dark" } }),
        entry({ url: "https://cdn.other.test/v1/products", resBody: [{ id: 1, sku: "a" }] }),
      ]),
    );
    const spec = JSON.parse(r.files["openapi.json"]!);
    expect(spec.security).toEqual([{ bearerAuth: [] }]);
    const config = spec.paths["/v1/config"].get;
    expect(config.servers).toEqual([{ url: "https://cdn.other.test" }]);
    expect(config.security).toEqual([]);
    expect(spec.paths["/v1/orders"].get.security).toBeUndefined();
    expect(await new Validator().validate(spec)).toMatchObject({ valid: true });
  });

  it("GraphQL and JSON-RPC on a partner origin get its server, and the API's own operation on the same path stays", () => {
    const rpc = (url: string, method: string, reqHeaders: Record<string, string> = {}) =>
      entry({ method: "POST", url, reqHeaders, reqBody: { jsonrpc: "2.0", id: 1, method }, resBody: { jsonrpc: "2.0", id: 1, result: { ok: true } } });
    const gql = (url: string, name: string, reqHeaders: Record<string, string> = {}) =>
      entry({ method: "POST", url, reqHeaders, reqBody: { operationName: name, query: `query ${name} { ${name.toLowerCase()} { id } }`, variables: {} }, resBody: { data: { [name.toLowerCase()]: { id: 1 } } } });
    const auth = { authorization: JWT };
    for (const order of [0, 1]) {
      const own = [rpc(`${API}/rpc`, "getStatus", auth), gql(`${API}/graphql`, "Me", auth)];
      const partner = [rpc("https://rpc.partner.test/rpc", "getInfo"), gql("https://gql.partner.test/graphql", "Rates")];
      const r = generate(har(order ? [...partner, ...own] : [...own, ...partner]));
      const spec = JSON.parse(r.files["openapi.json"]!);
      expect(spec.paths["/rpc"].post["x-jsonrpc-methods"].map((m: any) => m.method)).toEqual(["getStatus"]);
      expect(JSON.stringify(spec.paths["/graphql"].post)).toContain("Me");
      expect(spec.paths["/rpc"].post.servers).toBeUndefined();
      expect(r.plan.warnings.join("\n")).toContain(`openapi.json keeps the one on ${API}`);
    }
  });

  it("generated: every operation on another origin has `security: []` whatever the auth style", SLOW, () => {
    const rnd = rng(20_5);
    const styles = [{ authorization: JWT }, { authorization: "Basic " + Buffer.from("demo:pw-synthetic").toString("base64") }, { "x-api-key": "k_live_3f9a8b7c6d5e4f3a" }, { cookie: "sessionid=s3ss10nvalue77" }];
    for (let i = 0; i < 20; i++) {
      const hdr = pick(rnd, styles);
      const third = `https://${word(rnd)}.${word(rnd, 2)}.test`;
      const r = generateFromHar(
        har([
          entry({ url: `${API}/v1/${word(rnd, 2)}s`, reqHeaders: hdr, resBody: [{ id: 1, total: 2 }] }),
          entry({ url: `${API}/v1/${word(rnd, 2)}s`, reqHeaders: hdr, resBody: [{ id: 1, total: 2 }] }),
          entry({ url: `${third}/v2/${word(rnd, 2)}`, resBody: { ok: true } }),
        ]),
      );
      const spec = JSON.parse(r.files["openapi.json"]!);
      for (const { path, op } of ops(spec)) {
        const foreign = op.servers && op.servers[0].url !== spec.servers[0].url;
        expect(op.security, path).toEqual(foreign ? [] : undefined);
      }
    }
  });
});

// ── FG-04 / FG-05 ──────────────────────────────────────────────────────────────

describe("FG-04/FG-05 the default mock scrubs bracket-prefixed text and markup structure", () => {
  const O2 = "https://api.t.test";
  const mockTexts = async (login: string, token: string, texts: Record<string, string>, mime = "text/plain") => {
    const me = entry({ url: `${O2}/api/me`, reqHeaders: { authorization: `Bearer ${token}` }, resBody: { login, email: "zeynep.kaya@corp.example" } });
    const r = generateFromHar(har([me, ...Object.entries(texts).map(([k, t]) => entry({ url: `${O2}/api/t/${k}`, resMime: mime, resText: t }))]));
    const server = await listenMock(r.model, r.exchanges, { port: 0 });
    try {
      const out: Record<string, string> = {};
      for (const k of Object.keys(texts)) out[k] = await (await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/t/${k}`)).text();
      return out;
    } finally {
      server.close();
    }
  };

  it("the reviewer's bodies: INI, log lines, a broken brace", async () => {
    const [login, token] = ["zkaya77", "tok_9QfZx2LmP4rT8vWc"];
    const out = await mockTexts(login, token, {
      ini: `[user]\nlogin = ${login}\ntoken = ${token}\n`,
      bracketLine: `[1] ${login} logged in with ${token}`,
      brace: `{ broken ${login} ${token}`,
      arrayish: `[x] ${login}`,
      logline: `[2026-11-02 10:00:00] INFO user=${login} token=${token}`,
    });
    for (const [k, t] of Object.entries(out)) expect([k, t.includes(login) || t.includes(token)]).toEqual([k, false]);
  });

  it("truncated JSON is still read by key; isJsonPrefix tells the two apart", () => {
    expect(isJsonPrefix('{"login":"zkaya77","n":12,"ok":tr')).toBe(true);
    expect(isJsonPrefix('[{"a":[1,2,null,false]},{"b":"x\\"y"')).toBe(true);
    expect(isJsonPrefix("[user]\nlogin = zkaya77")).toBe(false);
    expect(isJsonPrefix("{ broken zkaya77")).toBe(false);
    expect(isJsonPrefix("[2026-11-02 10:00:00] INFO")).toBe(false);
  });

  it("the reviewer's markup: IRC-style lines, a processing instruction, entities, tag and attribute names", async () => {
    const [login, token] = ["zkaya77", "tok_9QfZx2LmP4rT8vWc"];
    const out = await mockTexts(
      login,
      token,
      {
        irc: `<${login}> lorem ipsum\n<bot> hi`,
        pi: `<?xml version="1.0"?><?user ${login} ${token}?><r/>`,
        doctype: `<!DOCTYPE r [<!ENTITY u "${login}"><!ENTITY t "${token}">]><r>&u;</r>`,
        tagname: `<users><${login}>1</${login}></users>`,
        attrname: `<u ${login}="1"/>`,
      },
      "application/xml",
    );
    for (const [k, t] of Object.entries(out)) expect([k, t.includes(login) || t.includes(token)]).toEqual([k, false]);
    expect(out.pi).toMatch(/^<\?xml version="1.0"\?>/);
    // The open and close tag get the same fake.
    expect(out.tagname).toMatch(/^<users><([\w.-]+)>\d+<\/\1><\/users>$/);
  });

  it("generated: random logins and tokens behind random openers and in random markup positions never come back", SLOW, async () => {
    const rnd = rng(20_6);
    for (let i = 0; i < 10; i++) {
      const login = word(rnd, 3) + Math.floor(10 + rnd() * 89);
      const token = "sk_" + Array.from({ length: 20 }, () => "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789"[Math.floor(rnd() * 55)]).join("");
      const opener = pick(rnd, ["[", "{", "[INFO] ", "{ts} ", `[${word(rnd, 2)}]\n`]);
      const key = pick(rnd, ["user", "login", "who", "owner"]);
      const text = await mockTexts(login, token, { a: `${opener}${key}=${login} token=${token}`, b: `${opener} ${login} ${token}` });
      const markup = await mockTexts(
        login,
        token,
        { c: pick(rnd, [`<${login}>x</${login}>`, `<r ${login}="1"/>`, `<?pi ${login} ${token}?><r/>`, `<!ENTITY e "${token}"><r/>`]) },
        "application/xml",
      );
      for (const t of [...Object.values(text), ...Object.values(markup)]) {
        expect(t.includes(login), t).toBe(false);
        expect(t.includes(token), t).toBe(false);
      }
    }
  });
});

// ── A1-04 ──────────────────────────────────────────────────────────────────────

describe("A1-04 a person's one-word name after a people collection is a path parameter, not a refusal", () => {
  const capture = (host: string, key: string, v: string, path: string) =>
    har([
      entry({ url: `${host}/api/v1/me`, resBody: { id: 7, [key]: v, email: "x7@posta.example" } }),
      entry({ url: `${host}/api/v1/orders`, resBody: [{ id: 1, status: "shipped" }] }),
      entry({ url: `${host}${path}`, resBody: { bio: "hi there", followers: 3 } }),
    ]);

  it("the reviewer's capture: /users/dorukbey and /profiles/dorukbey/posts, for each name key", () => {
    for (const key of ["name", "displayName", "screen_name", "first_name", "fullName", "username"]) {
      for (const [path, tpl] of [
        ["/api/v1/users/dorukbey", "/api/v1/users/{userId}"],
        ["/api/v1/profiles/dorukbey/posts", "/api/v1/profiles/{profileId}/posts"],
      ]) {
        const r = generateFromHar(capture("https://api.t.test", key, "dorukbey", path!));
        expect(r.leaks, `${key} ${path}`).toEqual([]);
        expect(r.model.endpoints.map((e) => e.path)).toContain(tpl);
        for (const f of Object.values(r.files)) expect(f.toLowerCase()).not.toContain("dorukbey");
      }
    }
  });

  it("a plain word after a people collection with no evidence is unchanged (stays a literal)", () => {
    const r = generateFromHar(
      har([
        entry({ url: "https://api.t.test/api/v1/me", resBody: { id: 7, name: "dorukbey", email: "x7@posta.example" } }),
        entry({ url: "https://api.t.test/api/v1/users/search", resBody: [{ id: 1 }] }),
      ]),
    );
    expect(r.model.endpoints.map((e) => e.path)).toContain("/api/v1/users/search");
  });

  it("generated: random names, name keys in five languages and people paths are templated, never refused or written", SLOW, () => {
    const rnd = rng(20_7);
    const keys = ["name", "displayName", "display_name", "screen_name", "fullName", "first_name", "givenName", "vorname", "isim", "nombre", "realName"];
    const paths = [(v: string) => `/api/v1/users/${v}`, (v: string) => `/api/people/${v}`, (v: string) => `/api/v1/profiles/${v}/posts`, (v: string) => `/api/v2/members/${v}`];
    for (let i = 0; i < 30; i++) {
      const v = word(rnd, 3) + pick(rnd, ["", "n", "r", "l"]);
      const r = generateFromHar(capture(`https://api${i}.example`, pick(rnd, keys), v, pick(rnd, paths)(v)));
      expect(r.leaks, v).toEqual([]);
      for (const f of Object.values(r.files)) expect(f.toLowerCase().includes(v), v).toBe(false);
    }
  });
});

// ── A1-02 ──────────────────────────────────────────────────────────────────────

describe("A1-02 a known username is a parameter after any prefix, and behind @ or ~", () => {
  const API = "https://api.shop.example";
  const capture = (u: string, path: string) =>
    har([
      entry({ url: `${API}/api/v1/orders`, resBody: [{ id: 1, status: "shipped" }] }),
      entry({ url: `${API}${path}`, resBody: { items: [], total: 0 } }),
      entry({ url: `${API}/api/v1/me`, resBody: { username: u } }),
    ]);
  const SHAPES = ["/@U", "/@U/posts", "/~U", "/u/U", "/u/U/posts", "/in/U", "/api/v1/U/feed", "/api/channel/U/videos", "/api/v1/avatar/U.png", "/r/U"];

  it("the reviewer's shapes: templated, never refused, never written", () => {
    for (const shape of SHAPES) {
      const r = generateFromHar(capture("dorukbey", shape.replace("U", "dorukbey")));
      expect(r.leaks, shape).toEqual([]);
      for (const f of Object.values(r.files)) expect(f.includes("dorukbey"), shape).toBe(false);
    }
    const r = generateFromHar(capture("dorukbey", "/@dorukbey/posts"));
    expect(r.model.endpoints.map((e) => e.path)).toContain("/@{handle}/posts");
    expect(Object.keys(JSON.parse(r.files["openapi.json"]!).paths)).toContain("/@{handle}/posts");
  });

  it("the client keeps the sigil: listPosts({ handle: 'x' }) requests /@x/posts, and it compiles", async () => {
    const r = generate(capture("dorukbey", "/@dorukbey/posts"));
    const code = r.files["client.ts"]!;
    expect(compile(code)).toBe("");
    const mod = await load(code);
    const urls: string[] = [];
    const fetch = async (url: URL) => {
      urls.push(String(url));
      return new Response("{}", { headers: { "content-type": "application/json" } });
    };
    const client = new mod[r.plan.clientName]({ fetch });
    const op = r.plan.ops.find((o) => o.ep.path === "/@{handle}/posts")!;
    await client[op.ep.name]({ handle: "x y" });
    expect(urls).toEqual([`${API}/@x%20y/posts`]);
  }, SLOW.timeout);

  it("a word that is no one's name stays a literal after /u/ and @", () => {
    const r = generateFromHar(capture("dorukbey", "/u/settings"));
    expect(r.model.endpoints.map((e) => e.path)).toContain("/u/settings");
  });

  it("generated: random usernames in random prefix shapes are templated and never written", SLOW, () => {
    const rnd = rng(20_8);
    for (let i = 0; i < 40; i++) {
      const u = word(rnd, 3) + pick(rnd, ["", "x", "42"]);
      const r = generateFromHar(capture(u, pick(rnd, SHAPES).replace("U", u)));
      expect(r.leaks, u).toEqual([]);
      for (const f of Object.values(r.files)) expect(f.toLowerCase().includes(u), u).toBe(false);
    }
  });
});

// ── A2-08 / A2-02 ──────────────────────────────────────────────────────────────

describe("A2-08/A2-02 weak identity evidence doesn't refuse the app's own endpoints", () => {
  const API = "https://api.shop.example";
  const leaksOf = (entries: ReturnType<typeof entry>[]) => generateFromHar(har(entries)).leaks.length;

  it("the reviewer's input: {returnTo: 'cart'} next to GET /api/v1/cart", () => {
    for (const key of ["returnTo", "redirect_to", "sortedBy", "powered_by", "importedFrom", "navigateTo"]) {
      expect([key, leaksOf([entry({ url: `${API}/api/v1/state`, resBody: { [key]: "cart" } }), entry({ url: `${API}/api/v1/cart`, resBody: { items: [] } })])]).toEqual([key, 0]);
    }
  });

  /** A strong identity: never written (refused, or since A1-02 a path parameter). */
  const strong = (key: string, w: string) => {
    const r = generateFromHar(har([entry({ url: `${API}/api/v1/tasks`, resBody: [{ id: 1, [key]: w }] }), entry({ url: `${API}/api/v1/${w}`, resBody: { a: 1 } })]));
    const written = r.leaks.length === 0 && Object.values(r.files).some((f) => f.includes(w));
    return r.model.taint.identities.has(w) && !r.model.taint.weakIdentities.has(w) && !written;
  };

  it("a person's action keeps the key strong: {assignedTo: 'okilic'} names a person, never written", () => {
    for (const key of ["assignedTo", "createdBy", "sentFrom", "reviewed_by"]) expect([key, strong(key, "okilic")]).toEqual([key, true]);
  });

  it("GraphQL from / to / by arguments are weak too", () => {
    const gql = entry({ method: "POST", url: `${API}/graphql`, reqBody: { query: 'query Stats { stats(from: "week", to: "today", by: "channel") { n } }' }, resBody: { data: { stats: { n: 1 } } } });
    expect(leaksOf([gql, entry({ url: `${API}/api/v1/today`, resBody: { a: 1 } })])).toBe(0);
  });

  it("a mailbox word as a collection: followed by an id, after v1beta, a dated version or with .json", () => {
    const config = entry({ url: `${API}/api/v1/config`, resBody: { storeName: "Acme", supportEmail: "orders@acme-shop.example" } });
    for (const path of ["/api/v1/orders/48213", "/api/v1beta/orders", "/admin/api/2024-01/orders.json", "/en-us/orders"]) {
      expect([path, leaksOf([config, entry({ url: API + path, resBody: { id: 1 } })])]).toEqual([path, 0]);
    }
  });

  it("but a mailbox word followed by another word is still a username: /api/v1/okilic/projects is refused", () => {
    const config = entry({ url: `${API}/api/v1/config`, resBody: { supportEmail: "okilic@corp.example" } });
    expect(leaksOf([config, entry({ url: `${API}/api/v1/okilic/projects`, resBody: [{ id: 1 }] })])).toBeGreaterThan(0);
  });

  it("generated: <verb>To/By/From over a random app word never refuses its top-level endpoint; a person's action does", SLOW, () => {
    const rnd = rng(20_9);
    for (let i = 0; i < 30; i++) {
      const w = word(rnd, 3);
      const nav = pick(rnd, ["returnTo", "redirectTo", "backTo", "sortedBy", "groupedBy", "poweredBy", "importedFrom", "copiedFrom"]);
      const person = pick(rnd, ["assignedTo", "createdBy", "updatedBy", "sentFrom", "invitedBy"]);
      const endpoint = entry({ url: `${API}/api/v1/${w}`, resBody: { a: 1 } });
      expect([nav, w, leaksOf([entry({ url: `${API}/api/v1/state`, resBody: { [nav]: w } }), endpoint])]).toEqual([nav, w, 0]);
      expect([person, w, strong(person, w)]).toEqual([person, w, true]);
    }
  });
});

// ── C1-03 / C1-04 / C1-05 ──────────────────────────────────────────────────────

describe("C1-03/C1-04/C1-05 path parameters, header names and text media types", () => {
  const API = "https://api.shop.example";
  const JWT = "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJlLXNpZ25hdHVyZQ";
  const recorder = () => {
    const calls: { url: string; method: string; headers: Record<string, string> }[] = [];
    const fetch = async (url: URL, init: RequestInit) => {
      calls.push({ url: String(url), method: String(init.method), headers: { ...(init.headers as Record<string, string>) } });
      return new Response("{}", { headers: { "content-type": "application/json" } });
    };
    return { calls, fetch };
  };

  it("C1-03: '..', '.' and '' are refused as path parameters; '../x' is encoded", async () => {
    const r = generate(har([1001, 1002].map((id) => entry({ method: "DELETE", url: `${API}/api/v1/users/${id}/sessions`, reqHeaders: { authorization: JWT }, resBody: {} }))));
    const mod = await load(r.files["client.ts"]!);
    const { calls, fetch } = recorder();
    const client = new mod[r.plan.clientName]({ token: "t", fetch });
    const name = r.plan.ops[0]!.ep.name;
    const param = r.plan.ops[0]!.pathParams[0]!.name;
    for (const bad of ["..", ".", ""]) await expect(client[name]({ [param]: bad })).rejects.toThrow(/path parameter/);
    await client[name]({ [param]: "../x" });
    expect(calls.map((c) => c.url)).toEqual([`${API}/api/v1/users/..%2Fx/sessions`]);
  });

  it("C1-04: an Authorization in `headers` or per call replaces the token instead of joining it", async () => {
    const r = generate(har([entry({ url: `${API}/api/v1/items`, reqHeaders: { authorization: JWT, "x-app-version": "3.4.1" }, resBody: [{ id: 1 }] })]));
    const mod = await load(r.files["client.ts"]!);
    const { calls, fetch } = recorder();
    await new mod[r.plan.clientName]({ token: "T", headers: { "X-App-Version": "9" }, fetch }).listItems({ headers: { Authorization: "Bearer OTHER" } });
    const h = calls[0]!.headers;
    expect(Object.keys(h).filter((k) => k.toLowerCase() === "authorization")).toEqual(["authorization"]);
    expect(h.authorization).toBe("Bearer OTHER");
    expect(Object.keys(h).filter((k) => k.toLowerCase() === "x-app-version")).toEqual(["x-app-version"]);
    expect(h["x-app-version"]).toBe("9");
  });

  it("C1-05: XML, CSV and SOAP bodies are sent with the recorded media type (charset kept, other parameters dropped)", async () => {
    for (const [mime, expected] of [
      ["application/xml; charset=utf-8", "application/xml; charset=utf-8"],
      ["text/csv", "text/csv"],
      ['application/soap+xml; charset=utf-8; action="urn:Secret-77"', "application/soap+xml; charset=utf-8"],
    ] as const) {
      const r = generate(har([entry({ method: "POST", url: `${API}/api/v1/import`, reqMime: mime, reqBody: "<a>1</a>", resBody: { ok: true } })]));
      const mod = await load(r.files["client.ts"]!);
      const { calls, fetch } = recorder();
      await new mod[r.plan.clientName]({ fetch })[r.plan.ops[0]!.ep.name]("<b>2</b>");
      expect(calls[0]!.headers["content-type"]).toBe(expected);
    }
  });

  it("generated: random header-name casings never send a header twice", SLOW, async () => {
    const rnd = rng(20_10);
    const r = generate(har([entry({ url: `${API}/api/v1/items`, reqHeaders: { authorization: JWT, "x-app-version": "3.4.1" }, resBody: [{ id: 1 }] })]));
    const mod = await load(r.files["client.ts"]!);
    for (let i = 0; i < 20; i++) {
      const casing = (h: string) => [...h].map((c) => (rnd() < 0.5 ? c.toUpperCase() : c)).join("");
      const { calls, fetch } = recorder();
      await new mod[r.plan.clientName]({ token: "T", headers: { [casing("x-app-version")]: "1", [casing("accept")]: "text/csv" }, fetch }).listItems({ headers: { [casing("authorization")]: "Bearer X" } });
      const keys = Object.keys(calls[0]!.headers).map((k) => k.toLowerCase());
      expect(new Set(keys).size).toBe(keys.length);
    }
  });
});

// ── E-04 ───────────────────────────────────────────────────────────────────────

describe("E-04 generate_sdk with no matching endpoint fails and keeps the existing client", () => {
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

  it("the reviewer's case: a typo in hosts after a good run", async () => {
    const dir = tmp();
    const path = join(dir, "capture.har");
    writeFileSync(path, har([entry({ url: "https://api.acme-shop.test/api/v1/items", resBody: [{ id: 1, price: 2 }] })]));
    const out = join(dir, "out");
    expect((await call("generate_sdk", { har_path: path, out_dir: out })).isError).toBe(false);
    const before = readFileSync(join(out, "client.ts"), "utf8");
    const res = await call("generate_sdk", { har_path: path, out_dir: out, hosts: ["api.acme-shop.tset"] });
    expect(res.isError).toBe(true);
    expect(res.text).toContain("None of the 1 requests is on api.acme-shop.tset");
    expect(readFileSync(join(out, "client.ts"), "utf8")).toBe(before);
  });

  it("generated: random host lists write iff at least one endpoint matches", SLOW, async () => {
    const rnd = rng(20_11);
    const hosts = ["api.acme-shop.test", "rates.partner.test"];
    const dir = tmp();
    const path = join(dir, "capture.har");
    writeFileSync(path, har([entry({ url: `https://${hosts[0]}/api/v1/items`, resBody: [{ id: 1 }] }), entry({ url: `https://${hosts[1]}/v1/rates`, resBody: { usd: 1 } })]));
    for (let i = 0; i < 8; i++) {
      const list = [rnd() < 0.5 ? hosts[0]! : `${word(rnd)}.test`, ...(rnd() < 0.5 ? [hosts[1]!] : [])];
      const res = await call("generate_sdk", { har_path: path, out_dir: join(dir, `out${i}`), hosts: list });
      expect(res.isError, list.join()).toBe(!list.some((h) => hosts.includes(h)));
    }
  });
});

// ── H-04 ───────────────────────────────────────────────────────────────────────

describe("H-04 named values in markup are read in linear time, with the same result", () => {
  /** The 0.6.15 reading, for comparison. */
  const reference = (markup: string): [string, string][] => {
    const out: [string, string][] = [];
    for (const m of markup.matchAll(/<(?:meta|input|param|data|option|button|textarea|output|select)\b[^>]*>/gi)) {
      const attrs = new Map<string, string>();
      for (const a of m[0].matchAll(/(?<![\w:.-])([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g)) attrs.set(a[1]!.toLowerCase(), a[2] ?? a[3] ?? a[4] ?? "");
      const name = attrs.get("name") ?? attrs.get("property") ?? attrs.get("itemprop");
      const value = attrs.get("content") ?? attrs.get("value");
      if (name && value) out.push([name, value]);
    }
    return out;
  };

  it("the reviewer's body: 200 KB of unclosed <meta takes milliseconds", () => {
    const t = performance.now();
    expect(namedValues("<html>" + "<meta ".repeat(33_334))).toEqual([]);
    const tail = '<input a=b '.repeat(18_000) + '<meta name="user-login" content="okilic">';
    const got = namedValues(tail);
    expect(performance.now() - t).toBeLessThan(500);
    expect(got).toEqual(reference(tail));
  });

  it("generated: random tag soup gives the same pairs as the old regex", () => {
    const rnd = rng(20_12);
    const parts = ["<meta", "<input", "<option", " name=", ' name="user-login"', " content=", ' value="okilic"', " a=b", " ", ">", '"', "'", "<p>", "x"];
    for (let i = 0; i < 300; i++) {
      let m = "";
      for (let j = 0; j < 40; j++) m += pick(rnd, parts);
      expect(namedValues(m), m).toEqual(reference(m));
    }
  });
});

// ── A1-01 ──────────────────────────────────────────────────────────────────────

describe("A1-01 the CLI never prints a value the leak guard knows", () => {
  const API = "https://api.shop.example";
  const run = (capture: string, inspect: boolean) => {
    const dir = tmp();
    writeFileSync(join(dir, "cap.har"), capture);
    const args = inspect ? ["inspect", join(dir, "cap.har")] : [join(dir, "cap.har"), "-o", join(dir, "out")];
    const r = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });
    return { status: r.status, out: r.stdout + r.stderr };
  };
  const capture = (u: string) =>
    har([
      entry({ url: `${API}/api/v1/me`, resBody: { username: u, email: `${u}@posta.example` } }),
      entry({ url: `${API}/api/v1/orders`, resBody: [{ id: 1, status: "shipped" }] }),
      entry({ url: `${API}/${u}/posts`, resBody: [{ id: 1 }] }),
      entry({ method: "POST", url: `${API}/rum/${u}`, reqBody: { t: 1 }, resBody: { ok: true } }),
    ]);

  it("the reviewer's capture: a refused run and plain inspect show <redacted>", SLOW, () => {
    const gen = run(capture("dorukbey"), false);
    expect(gen.status).toBe(2);
    expect(gen.out).not.toMatch(/dorukbey/i);
    expect(gen.out).toContain("<redacted>");
    const ins = run(capture("dorukbey"), true);
    expect(ins.status).toBe(0);
    expect(ins.out).not.toMatch(/dorukbey/i);
  });

  it("generated: random usernames never reach the CLI output", SLOW, () => {
    const rnd = rng(20_13);
    for (let i = 0; i < 4; i++) {
      const u = word(rnd, 3) + pick(rnd, ["", "x", "42"]);
      for (const inspect of [false, true]) expect(run(capture(u), inspect).out.toLowerCase().includes(u), u).toBe(false);
    }
  });
});

// ── FG-03 ──────────────────────────────────────────────────────────────────────

describe("FG-03 mock --bind keeps the Host check: a rebound name gets 403", () => {
  const start = async (args: string[]) => {
    const dir = tmp();
    writeFileSync(join(dir, "cap.har"), har([entry({ url: "https://api.b.test/api/me", resBody: { id: "u_1", plan: "pro" } })]));
    const port = 41_000 + Math.floor(Math.random() * 9000);
    const child = spawn(process.execPath, [CLI, "mock", join(dir, "cap.har"), "--port", String(port), ...args], { env: { ...process.env, NO_COLOR: "1" } });
    let out = "";
    await new Promise<void>((resolve, reject) => {
      child.stdout.on("data", (d) => {
        out += d;
        if (out.includes("har2sdk mock")) resolve();
      });
      child.on("exit", () => reject(new Error(out)));
    });
    const get = (host: string) =>
      new Promise<number>((resolve) => {
        const req = httpModule.request({ host: "127.0.0.1", port, path: "/api/me", headers: { host: `${host}:${port}` } }, (res: IncomingMessage) => {
          res.resume();
          resolve(res.statusCode!);
        });
        req.end();
      });
    return { get, out: () => out, stop: () => child.kill() };
  };

  it("the reviewer's case: --bind 0.0.0.0 answers 127.0.0.1 and refuses rebind.evil.example", SLOW, async () => {
    const m = await start(["--bind", "0.0.0.0"]);
    try {
      expect(await m.get("127.0.0.1")).toBe(200);
      expect(await m.get("rebind.evil.example")).toBe(403);
      expect(m.out()).toContain("--allow-host");
    } finally {
      m.stop();
    }
  });

  it("--allow-host adds a name", SLOW, async () => {
    const m = await start(["--bind", "0.0.0.0", "--allow-host", "mybox.test"]);
    try {
      expect(await m.get("mybox.test")).toBe(200);
      expect(await m.get("other.test")).toBe(403);
    } finally {
      m.stop();
    }
  });
});

// ── I-01 ───────────────────────────────────────────────────────────────────────

describe("I-01 the README's MCP setup pins the released version", () => {
  it("every npx har2sdk … mcp line and config names har2sdk@<package.json version>", () => {
    const readme = readFileSync(join(ROOT, "README.md"), "utf8");
    const version = (JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version: string }).version;
    const shell = [...readme.matchAll(/npx -y (har2sdk(?:@[\w.-]+)?) mcp/g)].map((m) => m[1]);
    const json = [...readme.matchAll(/"(har2sdk(?:@[\w.-]+)?)", "mcp"/g)].map((m) => m[1]);
    expect(shell.length).toBeGreaterThan(0);
    expect(json.length).toBeGreaterThan(1);
    for (const spec of [...shell, ...json]) expect(spec).toBe(`har2sdk@${version}`);
  });
});

// ── C2-10 ──────────────────────────────────────────────────────────────────────

describe("C2-10 a parameter learned on a parent path is the same parameter in its child paths", () => {
  const G = "https://api.gitlike.test";
  const pathsOf = (r: ReturnType<typeof generateFromHar>) => r.model.endpoints.map((e) => e.path).sort();
  const writes = (r: ReturnType<typeof generateFromHar>, v: string) => Object.values(r.files).some((f) => f.toLowerCase().includes(v.toLowerCase()));
  const repo = (owner: string, name: string) => entry({ url: `${G}/repos/${owner}/${name}`, resBody: { id: 1, name, owner: { login: owner } } });
  const issues = (owner: string, name: string, body: unknown = [{ number: 1, title: "bug" }]) => entry({ url: `${G}/repos/${owner}/${name}/issues`, resBody: body });

  it("the reported capture: /repos/zkaya/dotfiles and /repos/zkaya/dotfiles/issues", () => {
    const r = generateFromHar(har([repo("zkaya", "dotfiles"), issues("zkaya", "dotfiles")]));
    expect(r.leaks).toEqual([]);
    expect(pathsOf(r)).toEqual(["/repos/{owner}/{repo}", "/repos/{owner}/{repo}/issues"]);
    for (const v of ["zkaya", "dotfiles"]) expect(writes(r, v), v).toBe(false);
  });

  it("the reported capture with three repos answering only full_name: one parent and one issues endpoint", () => {
    const repos = ["dotfiles", "blog", "website"];
    const r = generateFromHar(
      har(repos.flatMap((n) => [entry({ url: `${G}/repos/zkaya/${n}`, resBody: { full_name: `zkaya/${n}` } }), issues("zkaya", n)])),
    );
    expect(r.leaks).toEqual([]);
    expect(r.model.endpoints).toHaveLength(2);
    const [parent, child] = [...r.model.endpoints].sort((a, b) => a.path.length - b.path.length);
    // The same parameter, at the same position, in both.
    expect(parent!.tokens[2]).toMatchObject({ kind: "param" });
    expect(child!.tokens[2]).toEqual(parent!.tokens[2]);
    expect(child!.tokens[3]).toEqual({ kind: "literal", value: "issues" });
    for (const v of repos) expect(writes(r, v), v).toBe(false);
  });

  it("deeper children follow: issues/{n}/comments and pulls", () => {
    const r = generateFromHar(
      har([
        repo("zkaya", "dotfiles"),
        entry({ url: `${G}/repos/zkaya/dotfiles/issues/12/comments`, resBody: [{ id: 5, body: "x" }] }),
        entry({ url: `${G}/repos/zkaya/dotfiles/pulls`, resBody: [{ number: 3 }] }),
      ]),
    );
    expect(r.leaks).toEqual([]);
    expect(pathsOf(r)).toEqual(["/repos/{owner}/{repo}", "/repos/{owner}/{repo}/issues/{issueId}/comments", "/repos/{owner}/{repo}/pulls"]);
  });

  it("a word with digits follows too when that very value was templated (was a known issue: widget9)", () => {
    const r = generateFromHar(har([repo("zkaya", "widget9"), issues("zkaya", "widget9")]));
    expect(pathsOf(r)).toEqual(["/repos/{owner}/{repo}", "/repos/{owner}/{repo}/issues"]);
    // Words with digits that no parent templated stay literal (review 4, R2).
    const vocab = generateFromHar(har([repo("zkaya", "widget9"), entry({ url: `${G}/repos/zkaya/oauth2/token`, resBody: { ok: true } })]));
    expect(pathsOf(vocab)).toContain("/repos/{owner}/oauth2/token");
  });

  it("siblings under one prefix that differ only in that segment merge, also one with no parent of its own", () => {
    const two = generateFromHar(har([repo("zkaya", "dotfiles"), repo("zkaya", "blog"), issues("zkaya", "dotfiles"), issues("zkaya", "blog", [{ number: 4, title: "typo" }])]));
    expect(pathsOf(two)).toEqual(["/repos/{owner}/{repo}", "/repos/{owner}/{repo}/issues"]);
    expect(two.model.endpoints.find((e) => e.path.endsWith("/issues"))!.count).toBe(2);
    const orphan = generateFromHar(har([repo("zkaya", "dotfiles"), issues("zkaya", "dotfiles"), issues("zkaya", "blog", [{ number: 4, title: "typo" }])]));
    expect(orphan.leaks).toEqual([]);
    expect(pathsOf(orphan)).toEqual(["/repos/{owner}/{repo}", "/repos/{owner}/{repo}/issues"]);
  });

  it("a sibling whose response has another shape stays a literal", () => {
    const r = generateFromHar(har([repo("zkaya", "dotfiles"), issues("zkaya", "dotfiles"), issues("zkaya", "trending", { total: 3, updatedAt: "2026-01-01" })]));
    expect(pathsOf(r)).toEqual(["/repos/{owner}/trending/issues", "/repos/{owner}/{repo}", "/repos/{owner}/{repo}/issues"]);
  });

  it("/users/me and /users/{id} stay apart, also in their child paths", () => {
    const r = generateFromHar(
      har([
        entry({ url: `${G}/users/123`, resBody: { id: 123, bio: "a" } }),
        entry({ url: `${G}/users/456`, resBody: { id: 456, bio: "b" } }),
        entry({ url: `${G}/users/me`, resBody: { id: 123, bio: "a" } }),
        entry({ url: `${G}/users/123/orders`, resBody: [{ id: 1 }] }),
        entry({ url: `${G}/users/me/orders`, resBody: [{ id: 1 }] }),
      ]),
    );
    expect(pathsOf(r)).toEqual(["/users/me", "/users/me/orders", "/users/{userId}", "/users/{userId}/orders"]);
    // Also when the users are named by login (a position that holds names, not ids).
    const named = generateFromHar(
      har([
        entry({ url: `${G}/users/alice`, resBody: { login: "alice", bio: "a" } }),
        entry({ url: `${G}/users/bob`, resBody: { login: "bob", bio: "b" } }),
        entry({ url: `${G}/users/alice/repos`, resBody: [{ id: 1, name: "x" }] }),
        entry({ url: `${G}/users/me/repos`, resBody: [{ id: 1, name: "x" }] }),
      ]),
    );
    expect(pathsOf(named)).toContain("/users/me/repos");
    expect(pathsOf(named)).toContain("/users/{userId}/repos");
  });

  it("/api/v1 and /api/v2 stay apart, with a parameter learned under each", () => {
    const r = generateFromHar(
      har([
        entry({ url: `${G}/api/v1/users/1`, resBody: { id: 1 } }),
        entry({ url: `${G}/api/v2/users/2`, resBody: { id: 2 } }),
        entry({ url: `${G}/api/v1/users/1/orders`, resBody: [{ id: 1 }] }),
        entry({ url: `${G}/api/v2/users/2/orders`, resBody: [{ id: 1 }] }),
      ]),
    );
    expect(pathsOf(r)).toEqual(["/api/v1/users/{userId}", "/api/v1/users/{userId}/orders", "/api/v2/users/{userId}", "/api/v2/users/{userId}/orders"]);
  });

  it("a word next to ids stays a literal: /products/featured/reviews next to /products/{productId}/reviews", () => {
    const r = generateFromHar(
      har([
        entry({ url: `${G}/products/101`, resBody: { id: 101, title: "a" } }),
        entry({ url: `${G}/products/102`, resBody: { id: 102, title: "b" } }),
        entry({ url: `${G}/products/101/reviews`, resBody: [{ id: 1, stars: 5 }] }),
        entry({ url: `${G}/products/featured/reviews`, resBody: [{ id: 1, stars: 5 }] }),
      ]),
    );
    expect(pathsOf(r)).toEqual(["/products/featured/reviews", "/products/{productId}", "/products/{productId}/reviews"]);
  });

  it("the client compiles and requests each repo's own URL", async () => {
    const r = generate(har([repo("zkaya", "dotfiles"), repo("zkaya", "blog"), issues("zkaya", "dotfiles"), issues("zkaya", "blog")]));
    const code = r.files["client.ts"]!;
    expect(compile(code)).toBe("");
    const mod = await load(code);
    const urls: string[] = [];
    const fetch = async (url: URL) => {
      urls.push(String(url));
      return new Response("[]", { headers: { "content-type": "application/json" } });
    };
    const client = new mod[r.plan.clientName]({ fetch });
    const op = r.plan.ops.find((o) => o.ep.path === "/repos/{owner}/{repo}/issues")!;
    await client[op.ep.name]({ owner: "x", repo: "a b" });
    expect(urls).toEqual([`${G}/repos/x/a%20b/issues`]);
  }, SLOW.timeout);

  it("refused: the CLI names the --param patterns, without the value, and they fix it", () => {
    // One repo answering only full_name: no second repo to learn from, and "owner/name" is in the path.
    const capture = har([entry({ url: `${G}/repos/zkaya/dotfiles`, resBody: { full_name: "zkaya/dotfiles" } }), issues("zkaya", "dotfiles")]);
    const r = generateFromHar(capture);
    expect(r.leaks.length).toBeGreaterThan(0);
    expect(r.paramPatterns).toEqual(["/repos/zkaya/*", "/repos/zkaya/*/issues"]);
    expect(generateFromHar(capture, { params: r.paramPatterns }).leaks).toEqual([]);

    const dir = tmp();
    writeFileSync(join(dir, "c.har"), capture);
    const refused = spawnSync(process.execPath, [CLI, join(dir, "c.har"), "-o", join(dir, "out")], { encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });
    expect(refused.status).toBe(2);
    expect(refused.stderr).toContain(`--param "/repos/zkaya/*/issues"`);
    expect(refused.stdout + refused.stderr).not.toContain("dotfiles");
    const fixed = spawnSync(process.execPath, [CLI, join(dir, "c.har"), "-o", join(dir, "out"), "--param", "/repos/zkaya/*", "--param", "/repos/zkaya/*/issues"], {
      encoding: "utf8",
    });
    expect(fixed.status).toBe(0);
  }, SLOW.timeout);

  it("no pattern when nothing is refused, and patterns keep other literals encoded for a shell", () => {
    expect(generateFromHar(har([repo("zkaya", "dotfiles"), issues("zkaya", "dotfiles")])).paramPatterns).toEqual([]);
    const capture = har([
      entry({ url: `${G}/a!b/repos/zkaya/dotfiles`, resBody: { full_name: "zkaya/dotfiles" } }),
      entry({ url: `${G}/a!b/repos/zkaya/dotfiles/x$(id)`, resBody: { ok: true } }),
    ]);
    const r = generateFromHar(capture);
    for (const p of r.paramPatterns) expect(p).not.toMatch(/[!$()"'`\\]/);
    expect(r.paramPatterns).toContain("/a%21b/repos/zkaya/*/x%24%28id%29");
    expect(generateFromHar(capture, { params: r.paramPatterns }).leaks).toEqual([]);
  });

  it("generated: random owners, repo names and child paths become one template per child, never refused or written", SLOW, () => {
    const rnd = rng(20_10);
    const CHILDREN = ["issues", "pulls", "commits", "branches", "releases", "labels"];
    for (let i = 0; i < 40; i++) {
      const owner = word(rnd, 3) + pick(rnd, ["", "x", "42"]);
      const names = [...new Set(Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => word(rnd, 3)))];
      const children = [...new Set(Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => pick(rnd, CHILDREN)))];
      const entries = names.flatMap((n) => [
        // Some repos answer with name and owner, some with full_name only; a repo may have no parent recorded.
        ...(rnd() < 0.85 || n === names[0] ? [entry({ url: `${G}/repos/${owner}/${n}`, resBody: rnd() < 0.5 ? { id: 1, name: n, owner: { login: owner } } : { id: 1, name: n, full_name: `${owner}/${n}`, owner: { login: owner } } })] : []),
        ...children.map((c) => entry({ url: `${G}/repos/${owner}/${n}/${c}`, resBody: [{ number: Math.floor(rnd() * 900) + 1, title: "t" }] })),
      ]);
      const r = generateFromHar(har(entries));
      const ctx = `${owner} ${names.join(",")} ${children.join(",")}`;
      expect(r.leaks, ctx).toEqual([]);
      expect(pathsOf(r), ctx).toEqual(["/repos/{owner}/{repo}", ...children.map((c) => `/repos/{owner}/{repo}/${c}`)].sort());
      for (const v of [owner, ...names]) expect(writes(r, v), `${ctx}: ${v}`).toBe(false);
    }
  });
});
