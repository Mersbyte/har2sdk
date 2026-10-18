/** Edge cases that real-world captures throw at us, in Chrome DevTools HAR format. */
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { generateFromHar, HarError, loadHar } from "../src/index.js";
import { ROOT, entry, har } from "./helpers.js";

const API_KEY = "AIzaSyD-9tSrke72PouQMnMX-a7eZSW0jkFMBWY";
const SECRET_HEADER = "sk_live_51Hx9aKJ2eZvKYlo2C8f3kQ";

const capture = har([
  // noise
  entry({ method: "OPTIONS", url: "https://api.x.test/v2/items", status: 204 }),
  entry({ url: "https://x.test/main.4f3a.js", resMime: "application/javascript", resText: "console.log(1)", resourceType: "script" }),
  entry({ url: "https://api.x.test/v2/broken", status: 0 }),
  // base64-encoded JSON, query arrays, odd param names, api key in query
  entry({
    url: `https://api.x.test/v2/items?tags=a&tags=b&page[size]=20&key=${API_KEY}`,
    resBody: { items: [{ id: 1, title: "A", price: 1.5 }], next: null },
    base64: true,
    reqHeaders: { "x-api-key": SECRET_HEADER },
  }),
  entry({
    url: `https://api.x.test/v2/items?tags=c&page[size]=10&key=${API_KEY}`,
    resBody: { items: [{ id: 2, title: "B", price: 3 }], next: "cursor_abc" },
    reqHeaders: { "x-api-key": SECRET_HEADER },
  }),
  // XSSI-protected JSON
  entry({ url: "https://api.x.test/v2/items/1", resText: `)]}'\n{"id":1,"title":"A","price":1.5,"owner":{"id":"u1"}}`, reqHeaders: { "x-api-key": SECRET_HEADER } }),
  entry({ method: "DELETE", url: "https://api.x.test/v2/items/1", status: 204, resMime: "", reqHeaders: { "x-api-key": SECRET_HEADER } }),
  // text/csv download
  entry({ url: "https://api.x.test/v2/items/export", resMime: "text/csv", resText: "id,title\n1,A\n", reqHeaders: { "x-api-key": SECRET_HEADER } }),
  // a search body with a `query` field is NOT GraphQL
  entry({ method: "POST", url: "https://api.x.test/v2/search", reqBody: { query: "red shoes", limit: 5 }, resBody: { hits: [{ id: 1 }] } }),
  // second origin
  entry({ method: "POST", url: "https://auth.x.test/oauth/token", reqMime: "application/x-www-form-urlencoded", reqBody: "grant_type=password&username=bob&password=pa55w0rd!", resBody: { access_token: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJib2IifQ.c2lnbmF0dXJlMTIz", token_type: "bearer", expires_in: 3600 } }),
  // batched GraphQL
  entry({
    method: "POST",
    url: "https://api.x.test/graphql",
    reqBody: [
      { operationName: "Viewer", query: "query Viewer { viewer { id login } }", variables: {} },
      { operationName: "Repo", query: "query Repo($name: String!) { repo(name: $name) { id stars } }", variables: { name: "har2sdk" } },
    ],
    resBody: [{ data: { viewer: { id: "u1", login: "bob" } } }, { data: { repo: { id: "r1", stars: 42 } } }],
  }),
  // Apollo persisted query over GET, no document
  entry({
    url:
      "https://api.x.test/graphql?operationName=Feed&variables=" +
      encodeURIComponent(JSON.stringify({ first: 10 })) +
      "&extensions=" +
      encodeURIComponent(JSON.stringify({ persistedQuery: { version: 1, sha256Hash: "ecf4edb46db40b5132295c0291d62fb65d6759a9eedfa4d5d612dd5ec54a6b38" } })),
    resBody: { data: { feed: { edges: [{ node: { id: "p1", text: "hi" } }] } } },
  }),
  // anonymous GraphQL query
  entry({ method: "POST", url: "https://api.x.test/graphql", reqBody: { query: "{ ping }" }, resBody: { data: { ping: "pong" } } }),
]);

describe("edge cases", () => {
  const r = generateFromHar(capture, { source: "edge.har" });
  const ids = r.plan.ops.map((o) => `${o.ep.id} → ${o.ep.name}`);

  it("handles noise, encodings and odd shapes", () => {
    expect(r.model.stats.dropped).toMatchObject({ preflight: 1, "static-asset": 1, failed: 1 });
    expect(ids).toEqual([
      "GET /graphql#Feed → feed",
      "POST /graphql#{ping} → queryPing",
      "POST /graphql#Repo → repo",
      "POST /graphql#Viewer → viewer",
      "POST auth.x.test/oauth/token → createToken",
      "GET /v2/items → listItems",
      "GET /v2/items/{itemId} → getItem",
      "DELETE /v2/items/{itemId} → deleteItem",
      "GET /v2/items/export → export",
      "POST /v2/search → search",
    ]);
  });

  it("types query arrays, bracketed names and nullable cursors", () => {
    const code = r.files["client.ts"]!;
    expect(code).toContain("tags?: string[] | undefined;");
    expect(code).toContain('"page[size]"?: number | undefined;');
    expect(code).toContain("next: string | null;");
    expect(code).toContain('"page[size]": params["page[size]"]');
    expect(code).toContain('responseType: "text"');
    expect(code).toContain('"ecf4edb46db40b5132295c0291d62fb65d6759a9eedfa4d5d612dd5ec54a6b38", variables, true');
    expect(code).toContain('origin: this.options.origins?.["https://auth.x.test"] ?? "https://auth.x.test"');
    expect(r.model.auth.apiKeyHeaders).toEqual(["x-api-key"]);
    expect(r.model.auth.apiKeyQuery).toEqual(["key"]);
  });

  it("does not leak keys, passwords or tokens", () => {
    for (const text of Object.values(r.files)) {
      for (const s of [API_KEY, SECRET_HEADER, "pa55w0rd!", "c2lnbmF0dXJlMTIz"]) expect(text).not.toContain(s);
    }
  });

  it("type-checks under --strict", () => {
    const dir = mkdtempSync(join(tmpdir(), "har2sdk-edge-"));
    writeFileSync(join(dir, "client.ts"), r.files["client.ts"]!);
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
          lib: ["ES2022"],
          types: ["node"],
          typeRoots: [join(ROOT, "node_modules/@types")],
          exactOptionalPropertyTypes: true,
          erasableSyntaxOnly: true,
          skipLibCheck: true,
        },
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

  it("gives a helpful error for files that are not HAR", () => {
    expect(() => loadHar("not json")).toThrow(HarError);
    expect(() => loadHar('{"hello": 1}')).toThrow(/log\.entries/);
  });
});

describe("privacy hardening", () => {
  const people = ["Ayse", "Mehmet", "Ayse", "Mehmet", "Ayse", "Mehmet"];
  const capture2 = har([
    ...people.map((name, i) =>
      entry({
        url: `https://api.y.test/orders/${i + 1}`,
        reqHeaders: { "x-device-id": "8c5f0d1e-3b7a-4c2e-9f6d-1a2b3c4d5e6f", "x-app-build": "771" },
        resBody: { id: i + 1, customerName: name, status: i % 2 ? "paid" : "open", city: i % 2 ? "izmir" : "ankara" },
      }),
    ),
    entry({
      method: "POST",
      url: "https://api.y.test/graphql",
      reqBody: { query: 'query Lookup { user(email: "ayse@example.org", token: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl") { id } }' },
      resBody: { data: { user: { id: "1" } } },
    }),
  ]);
  const r = generateFromHar(capture2);
  const code = r.files["client.ts"]!;

  it("keeps personal values out of enum unions", () => {
    expect(code).toContain("customerName: string;");
    expect(code).toContain("city: string;");
    expect(code).toContain('status: "open" | "paid" | (string & {});');
    expect(code).not.toContain("Mehmet");
  });

  it("does not bake per-device ids into default headers", () => {
    expect(r.model.defaultHeaders).toEqual({ "x-app-build": "771" });
    expect(code).not.toContain("8c5f0d1e");
  });

  it("turns data-carrying literals in recorded GraphQL documents into variables", () => {
    expect(code).not.toContain("ayse@example.org");
    expect(code).not.toContain("c2lnbmF0dXJl");
    expect(code).toContain("user(email: $email, token: $token)");
    expect(code).toMatch(/\(\$email: String!, \$token: String!\)/);
  });
});

describe("hostile input", () => {
  it("cannot inject code into the generated client", () => {
    const evil = har([
      entry({
        url: "https://api.z.test/things/1",
        reqHeaders: { cookie: "a*/console.log('pwned')/*=1", "x-csrf-token": "x" },
        resBody: { "*/ bad": 1, "a\"b": "c", ok: true },
      }),
      entry({ method: "POST", url: "https://api.z.test/graphql", reqBody: { query: "query Request { x }", operationName: "Request" }, resBody: { data: { x: 1 } } }),
      entry({ method: "POST", url: "https://api.z.test/graphql", reqBody: { query: "query Doc { y # `${process.exit}`\n }", operationName: "Doc" }, resBody: { data: { y: 1 } } }),
    ]);
    const r = generateFromHar(evil, { source: "x*/y.har" });
    const code = r.files["client.ts"]!;
    // every block comment opened is closed exactly where we intended
    const stripped = code.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(stripped).not.toContain("console.log('pwned')");
    expect(code).toContain("async postRequest(");
    expect(code).toContain("\\${process.exit}");
  });

  it("still produces a module that parses and loads", async () => {
    const evil = har([entry({ url: "https://api.z.test/things/1", reqHeaders: { cookie: "a*/x/*=1" }, resBody: { "*/ bad": 1 } })]);
    const dir = mkdtempSync(join(tmpdir(), "har2sdk-evil-"));
    writeFileSync(join(dir, "client.ts"), generateFromHar(evil, { source: "x*/y.har" }).files["client.ts"]!);
    const mod = await import(pathToFileURL(join(dir, "client.ts")).href);
    expect(typeof mod.ZClient).toBe("function");
  });
});
