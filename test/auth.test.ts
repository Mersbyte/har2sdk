/**
 * The README's "Auth" section, as tests: where the token comes from, when a
 * token function is called, what a 401 does, and the refresh recipe.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { generateFromHar } from "../src/index.js";
import { listenMock } from "../src/mock.js";
import { entry, har } from "./helpers.js";

const O = "https://api.acme.test";
const RECORDED = "Bearer opaque-recorded-token-7f3k9q2m";

async function load(code: string): Promise<any> {
  const dir = mkdtempSync(join(tmpdir(), "har2sdk-auth-"));
  writeFileSync(join(dir, "client.ts"), code);
  return import(pathToFileURL(join(dir, "client.ts")).href);
}

const r = generateFromHar(
  har([
    entry({ url: `${O}/api/me`, reqHeaders: { authorization: RECORDED }, resBody: { id: 1, plan: "pro" } }),
    entry({ url: `${O}/api/orders`, reqHeaders: { authorization: RECORDED }, resBody: [{ id: 7, status: "shipped" }] }),
  ]),
);
const code = r.files["client.ts"]!;

/** A fetch that answers 401 unless the token is in `valid`, and records every call. */
function server(valid: Set<string>) {
  const calls: string[] = [];
  const fetch = async (_url: URL, init: RequestInit) => {
    const auth = (init.headers as Record<string, string>).authorization ?? "";
    calls.push(auth);
    const ok = valid.has(auth.replace(/^Bearer /, ""));
    return new Response(JSON.stringify(ok ? { id: 1, plan: "pro" } : { error: "unauthorized" }), {
      status: ok ? 200 : 401,
      headers: { "content-type": "application/json" },
    });
  };
  return { calls, fetch };
}

describe("the token does not come from the capture", () => {
  it("keeps the recorded token out of client.ts and offers a token option instead", () => {
    expect(r.leaks).toEqual([]);
    expect(code).not.toContain("opaque-recorded-token");
    expect(code).toContain("token?: string | (() => string | Promise<string>) | undefined;");
  });

  it("sends no authorization header when no token is given", async () => {
    const mod = await load(code);
    const s = server(new Set());
    await new mod.AcmeClient({ fetch: s.fetch }).getMe().catch(() => {});
    expect(s.calls).toEqual([""]);
  });
});

describe("which auth options a client gets", () => {
  const opts = (reqHeaders: Record<string, string>, url = `${O}/api/me`) => {
    const c = generateFromHar(har([entry({ url, reqHeaders, resBody: { id: 1 } })])).files["client.ts"]!;
    return [...c.match(/export interface ClientOptions \{[\s\S]*?\n\}/)![0].matchAll(/^ {2}(\w+)\?:/gm)].map((m) => m[1]);
  };
  it.each([
    ["no auth", {}, undefined, ["token"]],
    ["Basic", { authorization: "Basic dXNlcjpwYXNz" }, undefined, ["basicAuth"]],
    ["an API-key header", { "x-api-key": "k_9f8a7c6b5d4e3f2a" }, undefined, ["apiKey"]],
    ["an API-key query parameter", {}, `${O}/api/me?api_key=k_9f8a7c6b5d4e3f2a`, ["apiKey"]],
    ["a session cookie", { cookie: "sid=abc123def456ghi789" }, undefined, ["cookie"]],
  ])("%s", (_label, headers, url, expected) => {
    const got = opts(headers, url).filter((o) => ["token", "basicAuth", "apiKey", "cookie"].includes(o!));
    expect(got).toEqual(expected);
  });
});

describe("the token is sent with the scheme the app used", () => {
  /** The `Authorization` header a client sends for `token: "xyz"`, after recording `recorded`. */
  async function sent(recorded: string | undefined): Promise<string | undefined> {
    const reqHeaders: Record<string, string> = recorded === undefined ? {} : { authorization: recorded };
    const mod = await load(generateFromHar(har([entry({ url: `${O}/api/me`, reqHeaders, resBody: { id: 1 } })])).files["client.ts"]!);
    let auth: string | undefined;
    const api = new mod.AcmeClient({ token: "xyz", fetch: async (_u: URL, init: RequestInit) => ((auth = (init.headers as Record<string, string>).authorization), new Response("{}")) });
    await api.getMe();
    return auth;
  }

  it.each([
    ["Bearer", "Bearer opaque-recorded-token-7f3k9q2m", "Bearer xyz"],
    ["Token", "Token opaque-recorded-token-7f3k9q2m", "Token xyz"],
    ["no scheme (bare)", "opaque-recorded-token-7f3k9q2m", "xyz"],
    ["no auth seen", undefined, "Bearer xyz"],
  ])("%s", async (_label, recorded, expected) => {
    expect(await sent(recorded)).toBe(expected);
  });
});

describe("a token function", () => {
  it("is called once per request, so it can return a fresh token each time", async () => {
    const mod = await load(code);
    let n = 0;
    const s = server(new Set(["t1", "t2", "t3"]));
    const api = new mod.AcmeClient({ token: async () => `t${++n}`, fetch: s.fetch });
    await api.getMe();
    await api.listOrders();
    await api.getMe();
    expect(n).toBe(3);
    expect(s.calls).toEqual(["Bearer t1", "Bearer t2", "Bearer t3"]);
  });
});

describe("a 401", () => {
  it("throws ApiError once: no retry and no second token call", async () => {
    const mod = await load(code);
    let n = 0;
    const s = server(new Set());
    const api = new mod.AcmeClient({ token: () => (n++, "expired"), fetch: s.fetch });
    const err = await api.getMe().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(mod.ApiError);
    expect(err.status).toBe(401);
    expect(err.body).toEqual({ error: "unauthorized" });
    expect(err.operation).toBe("getMe");
    expect(n).toBe(1);
    expect(s.calls).toHaveLength(1);
  });

  it("can be handled by the caller with the README's refresh recipe", async () => {
    const mod = await load(code);
    const { ApiError } = mod;
    const s = server(new Set(["fresh"]));
    const refresh = async () => "fresh";

    // ── README recipe ──
    let token = "expired";
    const api = new mod.AcmeClient({ token: () => token, fetch: s.fetch });

    async function withRefresh<T>(call: () => Promise<T>): Promise<T> {
      try {
        return await call();
      } catch (err) {
        if (!(err instanceof ApiError) || err.status !== 401) throw err;
        token = await refresh();
        return call();
      }
    }

    const me = await withRefresh(() => api.getMe());
    // ── end ──
    expect(me).toEqual({ id: 1, plan: "pro" });
    expect(s.calls).toEqual(["Bearer expired", "Bearer fresh"]);
  });
});

describe("the mock server", () => {
  it("does not check auth: no token, a wrong token and a right one get the same answer", async () => {
    const server = await listenMock(r.model, r.exchanges, { port: 0 });
    try {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/me`;
      const none = await fetch(url);
      const wrong = await fetch(url, { headers: { authorization: "Bearer nope" } });
      const right = await fetch(url, { headers: { authorization: RECORDED } });
      expect([none.status, wrong.status, right.status]).toEqual([200, 200, 200]);
      const bodies = [await none.json(), await wrong.json(), await right.json()];
      expect(bodies[1]).toEqual(bodies[0]);
      expect(bodies[2]).toEqual(bodies[0]);
    } finally {
      server.close();
    }
  });
});
