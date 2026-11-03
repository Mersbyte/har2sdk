/**
 * Twentieth review (v0.6.15): a full audit before launch. One describe block per finding, each reproduced with the
 * reviewer's input before it was fixed, plus a generated variant where one fits. IDs are the review's.
 *
 * C1-01: a redirect carried the API-key header, `headers` and the recorded default headers to another origin.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateFromHar } from "../src/index.js";
import { entry, har } from "./helpers.js";

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
