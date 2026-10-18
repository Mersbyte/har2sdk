import { describe, expect, it } from "vitest";
import { classify } from "../src/filter.js";
import { loadHar } from "../src/har.js";
import { emptyShape, observe, stringEnum, stringFormat } from "../src/infer.js";
import { isSecretValue, isSensitiveName, redactJson, redactScalar } from "../src/redact.js";
import { isValueSegment, templatePaths } from "../src/template.js";
import { TypeRegistry, printTs, printTsInterface } from "../src/types.js";
import { camel, pascal, singular } from "../src/words.js";
import { entry, har } from "./helpers.js";

describe("words", () => {
  it("singularises resource names", () => {
    expect(["users", "categories", "addresses", "boxes", "status", "people", "orders", "cookies"].map(singular)).toEqual([
      "user",
      "category",
      "address",
      "box",
      "status",
      "person",
      "order",
      "cookie",
    ]);
  });
  it("converts case", () => {
    expect(camel("line-items")).toBe("lineItems");
    expect(pascal("user_id")).toBe("UserId");
    expect(pascal("XMLHttpRequest")).toBe("XmlHttpRequest");
  });
});

describe("path segments", () => {
  it.each(["42", "550e8400-e29b-41d4-a716-446655440000", "507f1f77bcf86cd799439011", "ord_7Hx92kLm", "cus_9s6XKzkNRiz8i3", "2026-10-17", "01ARZ3NDEKTSV4RRFFQ69G5FAV"])(
    "%s is a value",
    (s) => expect(isValueSegment(s)).toBe(true),
  );
  it.each(["users", "v1", "v2.1", "line-items", "me", "graphql", "api"])("%s is a literal", (s) => expect(isValueSegment(s)).toBe(false));
});

describe("templatePaths", () => {
  const sample = (pathname: string, keys: string[], echoed: string[] = []) => ({ origin: "https://x.test", pathname, keyPaths: new Set(keys), hasJson: true, echoed: new Set(echoed) });

  it("templates ids and names params after their resource", () => {
    const t = templatePaths([sample("/api/users/42/orders/ord_9f8a7c2k", ["id"])]);
    expect(t.get("https://x.test/api/users/42/orders/ord_9f8a7c2k")?.template).toBe("/api/users/{userId}/orders/{orderId}");
    expect(t.get("https://x.test/api/users/42/orders/ord_9f8a7c2k")?.values).toEqual({ userId: "42", orderId: "ord_9f8a7c2k" });
  });

  it("merges sibling slugs that return the same shape", () => {
    const keys = ["slug", "city", "address", "phone", "location", "location.lat"];
    const t = templatePaths([
      sample("/stores/istanbul-kadikoy", keys, ["istanbul-kadikoy"]),
      sample("/stores/ankara-cankaya", keys, ["ankara-cankaya"]),
      sample("/stores/izmir-alsancak", keys, ["izmir-alsancak"]),
    ]);
    expect(t.get("https://x.test/stores/ankara-cankaya")?.template).toBe("/stores/{storeId}");
  });

  it("keeps named sub-collections that share a shape but aren't echoed", () => {
    const keys = ["[].id", "[].name", "[].price", "[].rating"];
    const t = templatePaths([sample("/products/featured", keys), sample("/products/trending", keys), sample("/products/new", keys)]);
    expect(t.get("https://x.test/products/trending")?.template).toBe("/products/trending");
    const two = templatePaths([sample("/v3/feed", ["id", "name", "items", "items.[].k"]), sample("/v3/search", ["id", "name", "items", "items.[].k"])]);
    expect(two.get("https://x.test/v3/search")?.template).toBe("/v3/search");
  });

  it("merges usernames when the server echoes them", () => {
    const keys = ["login", "id", "avatarUrl", "bio"];
    const t = templatePaths([sample("/users/alice", keys, ["alice"]), sample("/users/bob", keys, ["bob"])]);
    expect(t.get("https://x.test/users/bob")?.template).toBe("/users/{userId}");
  });

  it("does not merge different resources even with the same envelope", () => {
    const env = ["items", "total", "page"];
    const t = templatePaths([
      sample("/api/users", [...env, "items.[].id", "items.[].email"]),
      sample("/api/orders", [...env, "items.[].id", "items.[].status"]),
      sample("/api/products", [...env, "items.[].id", "items.[].price"]),
    ]);
    expect(t.get("https://x.test/api/users")?.template).toBe("/api/users");
    expect(t.get("https://x.test/api/orders")?.template).toBe("/api/orders");
  });

  it("never merges API versions", () => {
    const k = ["a", "b", "c", "d"];
    const t = templatePaths([sample("/api/v1/users", k), sample("/api/v2/users", k)]);
    expect(t.get("https://x.test/api/v2/users")?.template).toBe("/api/v2/users");
  });

  it("keeps special literals next to an id template", () => {
    const t = templatePaths([sample("/users/1", ["id"]), sample("/users/2", ["id"]), sample("/users/me", ["id", "email"])]);
    expect(t.get("https://x.test/users/me")?.template).toBe("/users/me");
    expect(t.get("https://x.test/users/2")?.template).toBe("/users/{userId}");
  });
});

describe("inference", () => {
  it("marks missing fields optional, null as nullable and detects formats", () => {
    const s = emptyShape();
    observe(s, { id: 1, name: "a", nick: null, at: "2026-01-01T00:00:00Z", web: "https://a.test" });
    observe(s, { id: 2, name: "b", nick: "bee", extra: true, at: "2026-01-02T00:00:00Z", web: "https://b.test" });
    const reg = new TypeRegistry();
    const t = reg.fromShape(s, ["User"]);
    expect(printTs(t)).toBe("User");
    const out = printTsInterface(reg.types[0]!);
    expect(out).toContain("id: number;");
    expect(out).toContain("nick: string | null;");
    expect(out).toContain("extra?: boolean;");
    expect(out).toContain("@format date-time");
    expect(out).toContain("@format uri");
  });

  it("produces open enum unions only with enough evidence", () => {
    const s = emptyShape();
    for (const v of ["shipped", "delivered", "shipped", "processing", "delivered", "delivered"]) observe(s, v);
    expect(stringEnum(s.string!)).toEqual(["delivered", "processing", "shipped"]);
    const few = emptyShape();
    for (const v of ["a", "b"]) observe(few, v);
    expect(stringEnum(few.string!)).toBeUndefined();
    const reg = new TypeRegistry();
    expect(printTs(reg.fromShape(s, ["X"], undefined, "status"))).toBe('"delivered" | "processing" | "shipped" | (string & {})');
    expect(printTs(reg.fromShape(s, ["X"], undefined, "createdBy"))).toBe("string");
  });

  it("never records literal values of sensitive fields", () => {
    const s = emptyShape();
    for (let i = 0; i < 10; i++) observe(s, { token: "same-token-value" });
    expect(s.object!.props.get("token")!.string!.distinct).toBeNull();
  });

  it("treats id-keyed objects as maps", () => {
    const s = emptyShape();
    observe(s, { "1042": { qty: 1 }, "1043": { qty: 2 } });
    const reg = new TypeRegistry();
    expect(printTs(reg.fromShape(s, ["Stock"]))).toBe("Record<string, Stock>");
  });

  it("dedupes identical structures and unifies an empty array with a typed one", () => {
    const a = emptyShape();
    observe(a, { id: "c1", items: [] });
    const b = emptyShape();
    observe(b, { id: "c1", items: [{ sku: "x", qty: 1 }] });
    const reg = new TypeRegistry();
    const ta = reg.fromShape(a, ["Cart"]);
    const tb = reg.fromShape(b, ["CreateCartItemResponse"]);
    expect(ta).toEqual(tb);
    expect(printTsInterface(reg.get("Cart")!)).toContain("items: Item[];");
  });

  it("detects string formats", () => {
    const s = emptyShape();
    observe(s, "550e8400-e29b-41d4-a716-446655440000");
    expect(stringFormat(s.string!)).toBe("uuid");
  });
});

describe("redaction", () => {
  it.each(["password", "accessToken", "refresh_token", "x-api-key", "Authorization", "client_secret", "cardNumber", "sessionId", "csrfToken"])(
    "%s is sensitive",
    (n) => expect(isSensitiveName(n)).toBe(true),
  );
  it.each(["author", "authorName", "keyboard", "passenger", "id", "title", "tokenizer_version_label"])("%s is not sensitive", (n) => {
    // "tokenizer" is a single word, not "token".
    expect(isSensitiveName(n)).toBe(false);
  });
  it("detects secret-looking values but keeps ids", () => {
    expect(isSecretValue("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl")).toBe(true);
    expect(isSecretValue("sk_live_51Hx9aKJ2eZvKYlo2C8f3k")).toBe(true);
    expect(isSecretValue("4242 4242 4242 4242")).toBe(true);
    expect(isSecretValue("550e8400-e29b-41d4-a716-446655440000")).toBe(false);
    expect(isSecretValue("507f1f77bcf86cd799439011")).toBe(false);
    expect(isSecretValue("hello world")).toBe(false);
  });
  it("redacts nested JSON", () => {
    const out = redactJson({ user: { email: "a@b.co", password: "x", pin: 1234, profile: { bio: "hi" } }, list: [1, 2, 3, 4, 5] }) as any;
    expect(out.user.email).toBe("<redacted>"); // contact field: masked whole
    expect(out.user.password).toBe("<redacted>");
    expect(out.user.pin).toBe(0);
    expect(out.user.profile.bio).toBe("hi");
    expect(out.list).toHaveLength(3);
    expect(redactScalar("Bearer abc.def.ghi")).toBe("<redacted>");
  });
});

describe("filter", () => {
  const ex = (e: Parameters<typeof entry>[0]) => loadHar(har([entry(e)]))[0]!;
  it("drops static assets, trackers, preflights and documents", () => {
    expect(classify(ex({ url: "https://x.test/app.js", resMime: "application/javascript", resText: "1", resourceType: "script" }))).toBe("static-asset");
    expect(classify(ex({ url: "https://x.test/logo.png", resMime: "image/png", resText: "x", resourceType: "image" }))).toBe("static-asset");
    expect(classify(ex({ url: "https://www.google-analytics.com/g/collect", resText: "" }))).toBe("tracker");
    expect(classify(ex({ method: "OPTIONS", url: "https://x.test/api" }))).toBe("preflight");
    expect(classify(ex({ url: "https://x.test/", resMime: "text/html", resText: "<html>", resourceType: "document" }))).toBe("document");
  });
  it("keeps JSON API calls, even without a resource type", () => {
    expect(classify(ex({ url: "https://x.test/api/users", resBody: [], resourceType: "" }))).toBeUndefined();
    expect(classify(ex({ method: "DELETE", url: "https://x.test/api/users/1", status: 204 }))).toBeUndefined();
  });
  it("honours host filters", () => {
    expect(classify(ex({ url: "https://cdn.other.test/api", resBody: {} }), { hosts: ["x.test"] })).toBe("host-filter");
    expect(classify(ex({ url: "https://api.x.test/v1", resBody: {} }), { hosts: ["x.test"] })).toBeUndefined();
  });
});
