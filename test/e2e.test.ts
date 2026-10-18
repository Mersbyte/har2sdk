/**
 * End-to-end: a HAR recorded by a real Chromium from examples/demo-shop.
 * The generated SDK is type-checked with `tsc --strict` and then executed
 * against the mock server built from the very same capture.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMockServer, generateFromHar, renderChatPrompt } from "../src/index.js";
import { DEMO_SECRETS, ROOT, demoHar } from "./helpers.js";

const result = generateFromHar(demoHar(), { source: "acme-shop.har", examples: true });
const client = result.files["client.ts"]!;
const openapi = result.files["openapi.json"]!;

describe("demo shop capture", () => {
  it("finds the API and ignores page noise", () => {
    expect(result.model.stats.entries).toBe(33);
    expect(result.model.stats.dropped).toMatchObject({ tracker: 2, "static-asset": 2, document: 1 });
    expect(result.model.auth.bearer).toBe(true);
    expect(result.model.auth.bearerIsJwt).toBe(true);
    expect(result.model.defaultHeaders).toEqual({ "x-app-version": "3.4.1", "x-client": "web" });
  });

  it("produces the expected endpoints and names", () => {
    const names = Object.fromEntries(result.plan.ops.map((o) => [o.ep.id, o.ep.name]));
    expect(names).toEqual({
      "POST /api/v1/auth/login": "login",
      "GET /api/v1/cart": "getCart",
      "POST /api/v1/cart/items": "createCartItem",
      "PATCH /api/v1/cart/items/{itemId}": "updateCartItem",
      "DELETE /api/v1/cart/items/{itemId}": "deleteCartItem",
      "GET /api/v1/me": "getMe",
      "POST /api/v1/newsletter": "createNewsletter",
      "GET /api/v1/orders": "listOrders",
      "GET /api/v1/orders/{orderId}": "getOrder",
      "POST /api/v1/orders/{orderId}/cancel": "cancelOrder",
      "GET /api/v1/products": "listProducts",
      "GET /api/v1/products/{productId}": "getProduct",
      "GET /api/v1/products/{productId}/reviews": "listProductReviews",
      "GET /api/v1/search": "search",
      "GET /api/v1/stores": "listStores",
      "GET /api/v1/stores/{storeId}": "getStore",
      "POST /graphql#AddToWishlist": "addToWishlist",
      "POST /graphql#GetRecommendations": "getRecommendations",
    });
  });

  it("infers useful types", () => {
    expect(client).toContain('status: "delivered" | "processing" | "shipped" | (string & {});');
    expect(client).toContain("export interface Cart {");
    expect(client).toContain("items: CartItem[];");
    expect(client).toContain("export type CreateCartItemResponse = Cart;");
    expect(client).toContain("discount?: Discount;");
    expect(client).toContain("title: string | null;");
    expect(client).toMatch(/productId: number;/);
    expect(client).toContain("export type ListProductReviewsResponse = Review[];");
  });

  it("never leaks secrets or personal data into any output", () => {
    const outputs = { client, openapi, prompt: renderChatPrompt(result.plan) };
    for (const [name, text] of Object.entries(outputs)) {
      for (const secret of DEMO_SECRETS) expect(text, `${name} leaks ${secret}`).not.toContain(secret);
      expect(text, `${name} leaks the user's email`).not.toContain("demo@acme-shop.test");
    }
  });

  it("emits a valid-looking OpenAPI 3.1 document", () => {
    const doc = JSON.parse(openapi);
    expect(doc.openapi).toBe("3.1.0");
    expect(Object.keys(doc.paths)).toContain("/api/v1/products/{productId}");
    expect(doc.paths["/api/v1/products/{productId}"].get.parameters[0]).toMatchObject({ name: "productId", in: "path", required: true, schema: { type: "integer" } });
    expect(doc.paths["/graphql"].post["x-graphql-operations"]).toHaveLength(2);
    expect(doc.components.securitySchemes.bearerAuth).toEqual({ type: "http", scheme: "bearer", bearerFormat: "JWT" });
    // every $ref resolves
    const refs = [...openapi.matchAll(/"\$ref": "#\/components\/schemas\/([^"]+)"/g)].map((m) => m[1]!);
    for (const r of refs) expect(doc.components.schemas[r], r).toBeDefined();
  });
});

describe("generated SDK", () => {
  let dir: string;
  let server: ReturnType<typeof createMockServer>;
  let baseUrl: string;
  let sdk: any;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "har2sdk-e2e-"));
    writeFileSync(join(dir, "client.ts"), client);
    sdk = await import(pathToFileURL(join(dir, "client.ts")).href);
    server = createMockServer(result.model, result.exchanges);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => server?.close());

  it.each([
    ["node types only", ["ES2022"]],
    ["browser (DOM) types", ["ES2022", "DOM"]],
  ])("type-checks under --strict with %s", (_label, lib) => {
    const usage = `import { AcmeShopClient, ApiError } from "./client.js";
const api = new AcmeShopClient({ token: () => "t" });
async function main() {
  const page = await api.listProducts({ category: "shoes", page: 1, limit: 4 });
  const first: number = page.items[0]!.price.amount;
  const p = await api.getProduct({ productId: 101 });
  const name: string = p.name;
  const recs = await api.getRecommendations({ userId: "u", limit: 3 });
  const reason: string = recs.recommendations.reason;
  await api.deleteCartItem({ itemId: "ci_1" });
  try { await api.getProduct({ productId: 999 }); } catch (e) { if (e instanceof ApiError) console.log(e.status); }
  return [first, name, reason];
}
void main;
`;
    writeFileSync(join(dir, "usage.ts"), usage);
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
          lib,
          types: ["node"],
          typeRoots: [join(ROOT, "node_modules/@types")],
          noUnusedLocals: true,
          exactOptionalPropertyTypes: true,
          erasableSyntaxOnly: true,
          verbatimModuleSyntax: true,
          skipLibCheck: true,
        },
        files: ["client.ts", "usage.ts"],
      }),
    );
    const tsc = join(ROOT, "node_modules/typescript/bin/tsc");
    let output = "";
    try {
      execFileSync(process.execPath, [tsc, "-p", join(dir, "tsconfig.json")], { encoding: "utf8" });
    } catch (err: any) {
      output = String(err.stdout ?? err);
    }
    expect(output).toBe("");
  });

  it("talks to the mock server", async () => {
    const api = new sdk.AcmeShopClient({ baseUrl, token: "anything" });
    const page = await api.listProducts({ category: "shoes", page: 2, limit: 4 });
    expect(page.page).toBe(2);
    expect(page.items.map((p: any) => p.id)).toEqual([105]);

    const product = await api.getProduct({ productId: 102 });
    // The mock serves fake data with the recorded shape: names become placeholder text.
    expect(product.name).toBe("Lorem Ipsum");

    const store = await api.getStore({ storeId: "izmir-alsancak" });
    expect(store.city).not.toBe("Izmir");
    expect(typeof store.city).toBe("string");

    const cart = await api.createCartItem({ productId: 101, quantity: 1 });
    expect(cart.items[0].name).toBe("Lorem Ipsum");
    expect(await api.deleteCartItem({ itemId: "ci_8f3kq2" })).toBeUndefined();

    const recs = await api.getRecommendations({ userId: "u_1042", limit: 3 });
    expect(recs.recommendations.products).toHaveLength(3);
    const wish = await api.addToWishlist({ productId: "104" });
    expect(wish.addToWishlist.ok).toBe(true);

    expect((await api.createNewsletter({ email: "a@b.co", consent: true })).subscribed).toBe(true);
    expect((await api.cancelOrder({ orderId: "ord_2Ns57vBc" })).status).toBe("cancelled");
  });

  it("throws ApiError with the parsed body on HTTP errors", async () => {
    const api = new sdk.AcmeShopClient({ baseUrl });
    // /products/999 was recorded as a 404 in the capture.
    const err = await api.getProduct({ productId: 999 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(sdk.ApiError);
    expect(err.status).toBe(404);
    expect(err.body).toEqual({ error: "product_not_found", message: "Lorem ipsum dolor sit amet" });
    expect(sdk.isGetProductError(err)).toBe(true);
    // Unseen ids replay a recorded success, unknown paths are a 404.
    expect((await api.getProduct({ productId: 104 })).id).toBeTypeOf("number");
    expect((await fetch(baseUrl + "/api/v1/nope")).status).toBe(404);
    const custom = new sdk.AcmeShopClient({ baseUrl, fetch: async () => new Response(JSON.stringify({ error: "nope" }), { status: 418, headers: { "content-type": "application/json" } }) });
    const e2 = await custom.getMe().catch((e: unknown) => e);
    expect(e2).toBeInstanceOf(sdk.ApiError);
    expect(e2.status).toBe(418);
    expect(e2.body).toEqual({ error: "nope" });
  });

  it("sends auth, default headers, query params and bodies correctly", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const api = new sdk.AcmeShopClient({
      token: async () => "tok",
      headers: { "x-extra": "1" },
      fetch: async (url: URL, init: RequestInit) => {
        seen.push({ url: String(url), init });
        return new Response("{}", { headers: { "content-type": "application/json" } });
      },
    });
    await api.listOrders({ status: "delivered" });
    await api.createNewsletter({ email: "a@b.co", consent: true });
    await api.updateCartItem({ itemId: "ci 1/2" }, { quantity: 3 });
    const [a, b, c] = seen;
    expect(a!.url).toBe("http://acme-shop.test/api/v1/orders?status=delivered");
    const h = a!.init.headers as Record<string, string>;
    expect(h.authorization).toBe("Bearer tok");
    expect(h["x-app-version"]).toBe("3.4.1");
    expect(h["x-extra"]).toBe("1");
    expect(String(b!.init.body)).toBe("email=a%40b.co&consent=true");
    expect(c!.url).toBe("http://acme-shop.test/api/v1/cart/items/ci%201%2F2");
    expect(c!.init.method).toBe("PATCH");
    expect(c!.init.body).toBe('{"quantity":3}');
  });
});

describe("CLI", () => {
  it("generates files and prints a summary", () => {
    const out = mkdtempSync(join(tmpdir(), "har2sdk-cli-"));
    const stdout = execFileSync(process.execPath, [join(ROOT, "dist/cli.js"), join(ROOT, "examples/demo-shop/acme-shop.har"), "-o", out], {
      encoding: "utf8",
      env: { ...process.env, NO_COLOR: "1" },
    });
    expect(stdout).toContain("18 endpoints");
    expect(stdout).toContain("AcmeShopClient · 18 methods");
    expect(readFileSync(join(out, "client.ts"), "utf8")).toBe(client);
    expect(JSON.parse(readFileSync(join(out, "openapi.json"), "utf8")).openapi).toBe("3.1.0");
  });

  it("applies an annotations file", () => {
    const out = mkdtempSync(join(tmpdir(), "har2sdk-cli-"));
    writeFileSync(
      join(out, "har2sdk.annotations.json"),
      JSON.stringify({
        clientName: "AcmeShop",
        endpoints: {
          "POST /api/v1/newsletter": { name: "subscribeToNewsletter", description: "Subscribe an email address to the newsletter." },
          "GET /api/v1/stores/{storeId}": { params: { storeId: "slug" } },
        },
        types: { Price: "Money" },
      }),
    );
    execFileSync(process.execPath, [join(ROOT, "dist/cli.js"), join(ROOT, "examples/demo-shop/acme-shop.har"), "-o", out], { encoding: "utf8" });
    const code = readFileSync(join(out, "client.ts"), "utf8");
    expect(code).toContain("export class AcmeShop {");
    expect(code).toContain("async subscribeToNewsletter(body: SubscribeToNewsletterBody");
    expect(code).toContain("Subscribe an email address to the newsletter.");
    expect(code).toContain("/api/v1/stores/${enc(params.slug)}");
    expect(code).toContain("export interface Money {");
    expect(code).not.toMatch(/\bPrice\b/);
  });

  it("prints a chat prompt with no secrets", () => {
    const stdout = execFileSync(process.execPath, [join(ROOT, "dist/cli.js"), "prompt", join(ROOT, "examples/demo-shop/acme-shop.har")], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    expect(stdout).toContain("reply with ONLY a JSON object");
    for (const s of DEMO_SECRETS) expect(stdout).not.toContain(s);
  });
});
