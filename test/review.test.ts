/**
 * Regression tests for an external code review. Each block reproduces one
 * concrete claim with the reviewer's own example input.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Validator } from "@seriousme/openapi-schema-validator";
import { describe, expect, it } from "vitest";
import { generateFromHar } from "../src/index.js";
import { ROOT, demoHar, entry, har } from "./helpers.js";

async function load(code: string): Promise<any> {
  const dir = mkdtempSync(join(tmpdir(), "har2sdk-review-"));
  writeFileSync(join(dir, "client.ts"), code);
  return import(pathToFileURL(join(dir, "client.ts")).href);
}

describe("review: code injection", () => {
  it("escapes hostile JSON keys and URL paths", async () => {
    const evil = har([
      entry({ url: "https://api.x.test/a", resBody: { "a\":string;};import('child_process').then(c=>c.execSync('calc'));type/**/X={\"b": 1 } }),
      entry({ url: 'https://api.x.test/api/v1/users");process.exit(1);//', resBody: { ok: true } }),
      entry({ url: "https://api.x.test/q?x%22%5D%3Bprocess.exit(1)%3B%2F%2F=1", resBody: { ok: true } }),
    ]);
    const code = generateFromHar(evil).files["client.ts"]!;
    const mod = await load(code); // parses and loads without executing anything
    expect(typeof mod.XClient).toBe("function");
    expect(code).toContain(JSON.stringify("a\":string;};import('child_process').then(c=>c.execSync('calc'));type/**/X={\"b"));
  });
});

describe("review: 2xx vs error schemas", () => {
  it("only 2xx responses shape the return type", () => {
    const code = generateFromHar(
      har([
        entry({ url: "https://api.x.test/users/1", resBody: { id: 1, name: "Ada" } }),
        entry({ url: "https://api.x.test/users/999", status: 404, resBody: { error: "Not found" } }),
      ]),
    ).files["client.ts"]!;
    expect(code).toMatch(/id: number;\n\s+name: string;\n}/);
    expect(code).not.toContain("error?: string");
  });
});

describe("review: path templating", () => {
  it("keeps named sub-resources with different shapes apart", () => {
    const subs = ["profile", "settings", "preferences", "notifications", "billing"];
    const r = generateFromHar(har(subs.map((s, i) => entry({ url: `https://api.x.test/api/users/${s}`, resBody: { [`field${i}`]: i, [`other${i}`]: "x" } }))));
    expect(r.plan.ops.map((o) => o.ep.path).sort()).toEqual(subs.map((s) => `/api/users/${s}`).sort());
  });

  it("keeps /users/me, /users/search, /users/export apart from /users/{id}", () => {
    const r = generateFromHar(
      har([
        entry({ url: "https://api.x.test/api/v1/users/1", resBody: { id: 1, name: "a" } }),
        entry({ url: "https://api.x.test/api/v1/users/2", resBody: { id: 2, name: "b" } }),
        entry({ url: "https://api.x.test/api/v1/users/me", resBody: { id: 1, name: "a", email: "a@b.co" } }),
        entry({ url: "https://api.x.test/api/v1/users/search?q=a", resBody: { hits: [] } }),
        entry({ url: "https://api.x.test/api/v1/users/export", resMime: "text/csv", resText: "id\n1" }),
      ]),
    );
    expect(r.plan.ops.map((o) => o.ep.path).sort()).toEqual(["/api/v1/users/export", "/api/v1/users/me", "/api/v1/users/search", "/api/v1/users/{userId}"]);
  });

  it("parameterises Next.js build ids instead of baking them in", () => {
    const r = generateFromHar(har([entry({ url: "https://x.test/_next/data/Dk3x9aPq0Lm2Vb7Yt4RsW/products.json", resBody: { pageProps: {} } })]));
    expect(r.plan.ops[0]!.ep.path).toBe("/_next/data/{dataId}/products.json");
  });
});

describe("review: generated client runtime", () => {
  const code = generateFromHar(
    har([
      entry({ url: "https://api.x.test/v2/items?tags=a&tags=b&page=1", resBody: [{ id: 1 }] }),
      entry({ method: "DELETE", url: "https://api.x.test/v2/items/1", status: 204, resMime: "" }),
    ]),
  ).files["client.ts"]!;

  it("keeps a base URL sub-path, encodes params, skips undefined and handles 204", async () => {
    const mod = await load(code);
    const seen: string[] = [];
    const api = new mod.XClient({
      baseUrl: "https://example.com/api/v2/",
      fetch: async (url: URL, init: RequestInit) => {
        seen.push(`${init.method} ${url}`);
        return init.method === "DELETE" ? new Response(null, { status: 204 }) : new Response("[]", { headers: { "content-type": "application/json" } });
      },
    });
    await api.listItems({ tags: ["a", "b"], page: undefined });
    expect(await api.deleteItem({ itemId: "a/b c" })).toBeUndefined();
    expect(seen).toEqual(["GET https://example.com/api/v2/v2/items?tags=a&tags=b", "DELETE https://example.com/api/v2/v2/items/a%2Fb%20c"]);
  });

  it("never replays browser-controlled headers", () => {
    const r = generateFromHar(
      har(
        [1, 2, 3].map((i) =>
          entry({
            url: `https://api.x.test/things/${i}`,
            reqHeaders: { "User-Agent": "Mozilla/5.0", Origin: "https://x.test", Referer: "https://x.test/", "Sec-Fetch-Mode": "cors", Cookie: "sid=abc", "X-App": "web" },
            resBody: { id: i },
          }),
        ),
      ),
    );
    expect(r.model.defaultHeaders).toEqual({ "x-app": "web" });
  });
});

describe("review: OpenAPI 3.1 validity", () => {
  it("passes the official OpenAPI 3.1 JSON schema (demo + edge cases)", async () => {
    for (const text of [
      demoHar(),
      har([
        entry({ url: "https://api.x.test/a?n=1", resBody: { v: null, w: [1, "x"], m: { "1": { a: 1 }, "2": { a: 2 } } } }),
        entry({ url: "https://api.x.test/a?n=2", resBody: { v: "s", w: [], m: {} } }),
        entry({ method: "POST", url: "https://api.x.test/graphql", reqBody: { query: "query Q { q }" }, resBody: { data: { q: 1 } } }),
      ]),
    ]) {
      const v = new Validator();
      const res = await v.validate(JSON.parse(generateFromHar(text, { examples: true }).files["openapi.json"]!));
      expect(res, JSON.stringify(res.errors)).toMatchObject({ valid: true });
      expect(v.version).toBe("3.1");
    }
  });
});

describe("review: packaging", () => {
  it.skipIf(process.platform === "win32")("ships a node shebang and runs via a symlinked bin like npx does", () => {
    const dir = mkdtempSync(join(tmpdir(), "har2sdk-bin-"));
    const link = join(dir, "har2sdk");
    execFileSync("ln", ["-s", join(ROOT, "dist/cli.js"), link]);
    const out = execFileSync(link, ["--version"], { encoding: "utf8" });
    expect(out.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

// ---------------------------------------------------------------------------
// Findings that were valid — fixed after the review.

describe("review fix: single-endpoint RPC APIs", () => {
  it("splits JSON-RPC calls by method", () => {
    const r = generateFromHar(
      har([
        entry({ method: "POST", url: "https://api.x.test/rpc", reqBody: { jsonrpc: "2.0", id: 1, method: "user.get", params: { id: 7 } }, resBody: { jsonrpc: "2.0", id: 1, result: { id: 7, name: "Ada" } } }),
        entry({ method: "POST", url: "https://api.x.test/rpc", reqBody: { jsonrpc: "2.0", id: 2, method: "order.cancel", params: { orderId: "o1" } }, resBody: { jsonrpc: "2.0", id: 2, result: { ok: true } } }),
      ]),
    );
    expect(r.plan.ops.map((o) => `${o.ep.id} → ${o.ep.name}`)).toEqual(["POST /rpc#order.cancel → orderCancel", "POST /rpc#user.get → userGet"]);
    const code = r.files["client.ts"]!;
    expect(code).toMatch(/async userGet\(input: UserGetInput/);
    expect(code).toContain("name: string;");
  });

  it("splits tRPC batches into one method per procedure", () => {
    const input = encodeURIComponent(JSON.stringify({ "0": { json: { id: 1 } }, "1": { json: { limit: 10 } } }));
    const r = generateFromHar(
      har([
        entry({
          url: `https://x.test/api/trpc/user.byId,post.list?batch=1&input=${input}`,
          resBody: [{ result: { data: { json: { id: 1, name: "Ada" } } } }, { result: { data: { json: [{ id: 9, title: "Hi" }] } } }],
        }),
        entry({ method: "POST", url: "https://x.test/api/trpc/post.create?batch=1", reqBody: { "0": { json: { title: "New" } } }, resBody: [{ result: { data: { json: { id: 10 } } } }] }),
      ]),
    );
    expect(r.plan.ops.map((o) => `${o.ep.id} → ${o.ep.name}`).sort()).toEqual([
      "GET /api/trpc#post.list → postList",
      "GET /api/trpc#user.byId → userById",
      "POST /api/trpc#post.create → postCreate",
    ]);
    expect(r.files["client.ts"]).toContain("title: string;");
  });
});

describe("review fix: locale prefixes", () => {
  it("turns /en-us/ and /de-de/ into a {locale} parameter", () => {
    const body = { id: 1, name: "Kopfhörer", price: 10, stock: 3 };
    const r = generateFromHar(
      har([
        entry({ url: "https://x.test/en-us/api/products/wireless-headphones", resBody: body }),
        entry({ url: "https://x.test/de-de/api/products/wireless-headphones", resBody: body }),
      ]),
    );
    expect(r.plan.ops.map((o) => o.ep.path)).toEqual(["/{locale}/api/products/wireless-headphones"]);
  });
});

describe("review fix: contact details in examples", () => {
  it("masks addresses and phone numbers in examples shown to an LLM", () => {
    const r = generateFromHar(demoHar());
    const store = r.plan.ops.find((o) => o.ep.id === "GET /api/v1/stores/{storeId}")!;
    const text = JSON.stringify(store.ep.example);
    expect(text).not.toContain("Moda Cd. 12");
    expect(text).not.toContain("+90 216");
    expect(text).not.toContain("Istanbul"); // examples are fake data with the recorded shape
    expect(text).not.toContain("istanbul-kadikoy"); // a slug is an id: faked too
    expect(text).toMatch(/"slug":"[a-z]+-[a-z]+"/); // …with the same shape
  });
});

describe("review fix: mock server binds to localhost", () => {
  it("does not listen on all interfaces by default", async () => {
    const { listenMock } = await import("../src/mock.js");
    const r = generateFromHar(demoHar());
    const server = await listenMock(r.model, r.exchanges, { port: 0 });
    const addr = server.address() as { address: string };
    server.close();
    expect(addr.address).toBe("127.0.0.1");
  });
});

describe("review fix: RPC clients run against the mock and type-check", () => {
  const input = encodeURIComponent(JSON.stringify({ "0": { json: { id: 1 } }, "1": { json: { limit: 10 } } }));
  const capture = har([
    entry({ method: "POST", url: "https://x.test/rpc", reqBody: { jsonrpc: "2.0", id: 1, method: "user.get", params: { id: 7 } }, resBody: { jsonrpc: "2.0", id: 1, result: { id: 7, name: "Ada" } } }),
    entry({
      url: `https://x.test/api/trpc/user.byId,post.list?batch=1&input=${input}`,
      resBody: [{ result: { data: { json: { id: 1, name: "Ada" } } } }, { result: { data: { json: [{ id: 9, title: "Hi" }] } } }],
    }),
    entry({ method: "POST", url: "https://x.test/api/trpc/post.create?batch=1", reqBody: { "0": { json: { title: "New" } } }, resBody: [{ result: { data: { json: { id: 10 } } } }] }),
  ]);
  const r = generateFromHar(capture);

  it("round-trips through the mock server", async () => {
    const { listenMock } = await import("../src/mock.js");
    const server = await listenMock(r.model, r.exchanges, { port: 0 });
    const port = (server.address() as { port: number }).port;
    try {
      const mod = await load(r.files["client.ts"]!);
      const api = new mod.XClient({ baseUrl: `http://127.0.0.1:${port}` });
      // Names are personal: the mock serves a distinct fake of the same length.
      expect(await api.userGet({ id: 7 })).toEqual({ id: 7, name: expect.stringMatching(/^[A-Z][a-z]{2}$/) });
      expect((await api.userGet({ id: 7 })).name).not.toBe("Ada");
      expect(await api.userById({ id: 1 })).toEqual({ id: 1, name: expect.stringMatching(/^[A-Z][a-z]{2}$/) });
      expect(await api.postList({ limit: 10 })).toEqual([{ id: 9, title: "Lorem" }]);
      expect(await api.postCreate({ title: "New" })).toEqual({ id: 10 });
      // a browser-style batched tRPC call is answered too
      const res = await fetch(`http://127.0.0.1:${port}/api/trpc/user.byId,post.list?batch=1&input=${input}`);
      expect((await res.json()).length).toBe(2);
    } finally {
      server.close();
    }
  });

  it("type-checks under --strict", () => {
    const dir = mkdtempSync(join(tmpdir(), "har2sdk-rpc-"));
    writeFileSync(join(dir, "client.ts"), r.files["client.ts"]!);
    writeFileSync(join(dir, "package.json"), '{ "type": "module" }');
    writeFileSync(
      join(dir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: { strict: true, noEmit: true, target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", lib: ["ES2022"], types: ["node"], typeRoots: [join(ROOT, "node_modules/@types")], exactOptionalPropertyTypes: true, erasableSyntaxOnly: true, skipLibCheck: true },
        files: ["client.ts"],
      }),
    );
    let out = "";
    try {
      execFileSync(process.execPath, [join(ROOT, "node_modules/typescript/bin/tsc"), "-p", join(dir, "tsconfig.json")], { encoding: "utf8" });
    } catch (e: any) {
      out = String(e.stdout ?? e);
    }
    expect(out).toBe("");
  });

  it("emits valid OpenAPI 3.1 for RPC endpoints", async () => {
    const v = new Validator();
    const doc = JSON.parse(r.files["openapi.json"]!);
    expect(await v.validate(doc)).toMatchObject({ valid: true });
    expect(Object.keys(doc.paths).sort()).toEqual(["/api/trpc/post.create", "/api/trpc/post.list", "/api/trpc/user.byId", "/rpc"]);
  });
});

describe("review fix: several captures at once", () => {
  it("merges HAR files given to the CLI", () => {
    const dir = mkdtempSync(join(tmpdir(), "har2sdk-multi-"));
    writeFileSync(join(dir, "a.har"), har([entry({ url: "https://api.x.test/users/1", resBody: { id: 1 } })]));
    writeFileSync(join(dir, "b.har"), har([entry({ url: "https://api.x.test/orders/7", resBody: { id: 7, total: 3 } })]));
    const out = execFileSync(process.execPath, [join(ROOT, "dist/cli.js"), "inspect", join(dir, "a.har"), join(dir, "b.har"), "--json"], { encoding: "utf8" });
    expect(JSON.parse(out).endpoints.map((e: { id: string }) => e.id)).toEqual(["GET /orders/{orderId}", "GET /users/{userId}"]);
  });
});
