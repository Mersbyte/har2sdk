/**
 * Twentieth review (v0.6.15): a full audit before launch. One describe block per finding, each reproduced with the
 * reviewer's input before it was fixed, plus a generated variant where one fits. IDs are the review's.
 *
 * C1-01: a redirect carried the API-key header, `headers` and the recorded default headers to another origin.
 * C1-02: `baseUrl` (the only origin that gets credentials) was the origin with the most endpoints, so a vendor
 *        with more endpoints got the token and the app's own API got none.
 * C2-01: a JSON request body that is an array of objects (also JSON Patch, `eth_call` params, tRPC batch input)
 *        declared its type name twice, so client.ts didn't compile, and the CLI still exited 0.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertUniqueDeclarations } from "../src/codegen.js";
import { generateFromHar } from "../src/index.js";
import { ROOT, entry, har } from "./helpers.js";

const O = "https://app.acme.test";
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
