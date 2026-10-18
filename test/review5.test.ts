/**
 * Fifth review (v0.5.0), an adversarial audit: new placements that leaked
 * (P*) and correct output the guard broke (C*). One describe block per
 * finding, with the input that showed it; test/privacy-fuzz.test.ts has
 * generated variants of the leak classes.
 */
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { generateFromHar } from "../src/index.js";
import { listenMock } from "../src/mock.js";
import { buildPlan } from "../src/plan.js";
import { renderChatPrompt, renderEndpointDetail } from "../src/summary.js";
import { entry, har } from "./helpers.js";

type Entry = ReturnType<typeof entry>;
const gen = (entries: Entry[], opts = {}) => generateFromHar(har(entries), opts);
const paths = (r: ReturnType<typeof gen>) => r.plan.ops.map((o) => o.ep.path).sort();
/** Every text output except the mock: files (± --examples), the chat prompt and what MCP shows. */
const allText = (entries: Entry[]) => {
  const r = gen(entries);
  const rx = gen(entries, { examples: true });
  const plan = buildPlan(structuredClone(r.model));
  return [...Object.values(r.files), ...Object.values(rx.files), renderChatPrompt(plan), ...plan.ops.map((o) => renderEndpointDetail(plan, o))].join("\n");
};

/** Every recorded request replayed against the default (scrubbed) mock. */
async function mockAll(entries: Entry[]): Promise<string[]> {
  const r = gen(entries);
  const server = await listenMock(r.model, r.exchanges, { port: 0 });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const out: string[] = [];
    for (const en of entries) {
      const u = new URL(en.request.url);
      const pd = en.request.postData;
      const res = await fetch(base + u.pathname + u.search, { method: en.request.method, ...(pd ? { body: pd.text, headers: { "content-type": pd.mimeType ?? "application/json" } } : {}) });
      out.push(await res.text());
    }
    return out;
  } finally {
    server.close();
  }
}

const O = "https://api.k.test";

// ── P1 ─────────────────────────────────────────────────────────────────────────

describe("P1 the mock scrubs XML and plain-text bodies, not just JSON", () => {
  it("XML: element text is scrubbed by its tag name, the markup stays", async () => {
    const [xml] = await mockAll([
      entry({ url: O + "/api/me", resMime: "application/xml", resText: "<user><login>mdemir</login><fullName>Oguz Kilic</fullName><city>Kadikoy</city><status>active</status><email>oguz@kilic.dev</email></user>" }),
    ]);
    for (const v of ["mdemir", "Oguz", "Kilic", "Kadikoy", "oguz@kilic.dev"]) expect(xml).not.toContain(v);
    expect(xml).toMatch(/^<user><login>[a-z]+<\/login><fullName>[^<]+<\/fullName><city>[^<]+<\/city><status>active<\/status><email>[^<]+<\/email><\/user>$/);
  });
  it("attributes and CDATA are scrubbed too", async () => {
    const [xml] = await mockAll([entry({ url: O + "/api/feed", resMime: "text/xml", resText: '<entry author="mdemir" kind="post"><title><![CDATA[Oguz Kilic is sick]]></title></entry>' })]);
    for (const v of ["mdemir", "Oguz", "sick"]) expect(xml).not.toContain(v);
    expect(xml).toContain('kind="post"');
  });
  it("plain text: words are masked line by line", async () => {
    const [whoami, note] = await mockAll([
      entry({ url: O + "/api/whoami", resMime: "text/plain", resText: "mdemir" }),
      entry({ url: O + "/api/note", resMime: "text/plain", resText: "Oguz Kilic is allergic to penicillin\nsecond line" }),
      entry({ url: O + "/api/users", resBody: [{ id: 1, login: "mdemir" }] }),
    ]);
    expect(whoami).not.toContain("mdemir");
    expect(note).not.toMatch(/Oguz|penicillin/);
    expect(note.split("\n")).toHaveLength(2);
  });
  it("truncated JSON keeps its keys, values are scrubbed", async () => {
    const [body] = await mockAll([entry({ url: O + "/api/profile", resMime: "application/json", resText: '{"id": 42, "fullName": "Oguz Kilic", "login": "mdemir", "status": "active", "bio": "I live in Kadik' })]);
    for (const v of ["Oguz", "mdemir", "Kadik"]) expect(body).not.toContain(v);
    expect(body).toContain('"fullName"');
    expect(body).toContain('"status": "active"');
  });
  it("names inside XML are evidence for the rest of the capture", () => {
    const text = allText([
      entry({ url: O + "/api/me", resMime: "application/xml", resText: "<user><login>mdemir</login></user>" }),
      entry({ url: O + "/api/users/mdemir/repos", resBody: [{ id: 1 }] }),
    ]);
    expect(text).not.toContain("mdemir");
  });
});

// ── P2 / C11 ───────────────────────────────────────────────────────────────────

describe("P2 GraphQL number literals that carry data become variables", () => {
  it("user(id: 4815162342) is not baked into the document", () => {
    const entries = [entry({ method: "POST", url: O + "/graphql", reqBody: { query: "query GetUser { user(id: 4815162342) { name } }" }, resBody: { data: { user: { name: "x" } } } })];
    expect(allText(entries)).not.toContain("4815162342");
    const r = gen(entries);
    expect(r.leaks).toEqual([]);
    expect(r.files["client.ts"]).toMatch(/query GetUser\(\$id: ID!\) \{ user\(id: \$id\)/);
  });
  it("small numbers (page sizes) stay in the document", () => {
    const r = gen([entry({ method: "POST", url: O + "/graphql", reqBody: { query: "query Feed { feed(first: 20) { id } }" }, resBody: { data: { feed: [] } } })]);
    expect(r.files["client.ts"]).toContain("feed(first: 20)");
  });
});

describe("C11 list literals and block strings in GraphQL documents become variables", () => {
  it("emails: [\"…\", \"…\"] is lifted instead of refused", () => {
    const entries = [entry({ method: "POST", url: O + "/graphql", reqBody: { query: 'query Find { users(emails: ["oguz@kilic.dev", "ece@x.io"]) { id } }' }, resBody: { data: { users: [] } } })];
    const r = gen(entries);
    expect(r.leaks).toEqual([]);
    expect(allText(entries)).not.toMatch(/oguz@kilic\.dev|ece@x\.io/);
    expect(r.files["client.ts"]).toMatch(/\$emails: \[String!\]!/);
  });
  it('block strings ("""…""") are lifted', () => {
    const entries = [entry({ method: "POST", url: O + "/graphql", reqBody: { query: 'mutation Note { addNote(text: """Oguz Kilic is sick""") { id } }' }, resBody: { data: { addNote: { id: 1 } } } })];
    const r = gen(entries);
    expect(r.leaks).toEqual([]);
    expect(allText(entries)).not.toMatch(/Oguz|sick/);
  });
});

// ── P3 ─────────────────────────────────────────────────────────────────────────

describe("P3 literals in GraphQL documents sent with GET are evidence too", () => {
  it("a username in ?query= makes /users/<it>/repos a parameter", () => {
    const entries = [
      entry({ url: O + "/graphql?operationName=Find&query=" + encodeURIComponent('query Find { user(login: "mdemir") { id } }'), resBody: { data: { user: { id: 1 } } } }),
      entry({ url: O + "/api/users/mdemir/repos", resBody: [{ id: 1 }] }),
    ];
    expect(allText(entries)).not.toContain("mdemir");
    expect(paths(gen(entries))).toContain("/api/users/{userId}/repos");
  });
});

// ── C1 / C2 ────────────────────────────────────────────────────────────────────

const batch = () => [
  entry({
    method: "POST",
    url: O + "/graphql",
    reqBody: [
      { operationName: "GetCart", query: "query GetCart { cart { id total } }", variables: {} },
      { operationName: "GetMe", query: "query GetMe { me { id } }", variables: {} },
    ],
    resBody: [{ data: { cart: { id: "c1", total: 3 } } }, { data: { me: { id: "u1" } } }],
  }),
];

describe("C1 batched GraphQL requests are not mistaken for data", () => {
  it("documents and operation names in a batch don't trip the leak guard", () => {
    const r = gen(batch());
    expect(r.leaks).toEqual([]);
    expect(r.plan.ops.map((o) => o.ep.name).sort()).toEqual(["getCart", "getMe"]);
  });
  it("persisted-query hashes in a batch neither", () => {
    const r = gen([
      entry({ method: "POST", url: O + "/graphql", reqBody: [{ operationName: "GetCart", variables: {}, extensions: { persistedQuery: { version: 1, sha256Hash: "ecf4edb46db40b5132295c0291d62fb65d6759a9eedfa4d5d612dd5ec54a6b38" } } }], resBody: [{ data: { cart: { id: "c1" } } }] }),
    ]);
    expect(r.leaks).toEqual([]);
  });
});

describe("C2 the mock answers a batched GraphQL request with a batch", () => {
  it("one result per operation, in order", async () => {
    const [body] = await mockAll(batch());
    const json = JSON.parse(body!);
    expect(Array.isArray(json)).toBe(true);
    expect(json).toHaveLength(2);
    expect(Object.keys(json[0].data)).toEqual(["cart"]);
    expect(Object.keys(json[1].data)).toEqual(["me"]);
  });
});

// ── P4 ─────────────────────────────────────────────────────────────────────────

describe("P4 identities inside longer names (cookie names, version metadata)", () => {
  const capture = (headers: Record<string, string>) => [1, 2, 3].map((i) => entry({ url: `${O}/api/orders/${i}`, reqHeaders: headers, resBody: { id: i, owner: { login: "mdemir" } } }));
  it("a cookie named after the user is not listed", () => {
    const entries = capture({ cookie: "remember_mdemir=1; sid=abcdefgh12345678" });
    const r = gen(entries);
    expect(r.leaks).toEqual([]);
    expect(allText(entries)).not.toContain("mdemir");
    expect(r.model.auth.cookieNames).toEqual(["sid"]);
  });
  it("version build metadata naming the user is not a default header", () => {
    const entries = capture({ "x-app-version": "2.14.0+mdemir" });
    const r = gen(entries);
    expect(r.leaks).toEqual([]);
    expect(r.model.defaultHeaders).toEqual({});
    expect(gen(capture({ "x-app-version": "2.14.0-beta.1" })).model.defaultHeaders).toEqual({ "x-app-version": "2.14.0-beta.1" });
  });
  it("the scanner sees an identity inside a longer token", async () => {
    const { scanText } = await import("../src/leak.js");
    const r = gen(capture({}));
    expect(scanText('const COOKIE = "remember_mdemir";', r.model.taint, "x")).toHaveLength(1);
    expect(scanText('const V = "2.0.0+mdemir";', r.model.taint, "x")).toHaveLength(1);
  });
  it("…but not inside the API's own host name", () => {
    const entries = [1, 2].map((i) => entry({ url: `https://mdemir.myshop.test/api/orders/${i}`, resBody: { id: i, shop: { owner: "mdemir" } } }));
    const r = gen(entries);
    expect(r.leaks).toEqual([]);
    expect(r.files["client.ts"]).toContain("https://mdemir.myshop.test");
  });
});

// ── P5 ─────────────────────────────────────────────────────────────────────────

describe("P5 URLs in fake data don't keep a user's name in the host or path", () => {
  it("blog/site URLs named after a recorded login or name", async () => {
    const entries = [entry({ url: O + "/api/me", resBody: { login: "mdemir", name: "Oguz Kilic", blog: "https://mdemir.github.io/posts/1", site: "https://oguz-kilic.dev", linkedin: "https://social.test/in/oguz-kilic", docs: "https://api.k.test/docs/v2" } })];
    const [body] = await mockAll(entries);
    const examples = gen(entries, { examples: true }).files["openapi.json"]!;
    for (const out of [body!, examples]) {
      expect(out).not.toMatch(/mdemir|oguz-kilic/);
      expect(out).toContain("https://api.k.test/docs/v2");
    }
    expect(JSON.parse(body!).blog).toMatch(/^https:\/\/[a-z]+\.github\.io\/posts\/\d$/);
  });
});

// ── C3 / C9 ────────────────────────────────────────────────────────────────────

const stripeList = () => [
  entry({ url: "https://api.stripe.test/v1/customers?limit=3", resBody: { object: "list", data: [{ id: "cus_NffrFeUfNV2Hib", object: "customer", email: "jenny@example.org" }], has_more: false, url: "/v1/customers" } }),
  entry({ url: "https://api.stripe.test/v1/customers/cus_NffrFeUfNV2Hib", resBody: { id: "cus_NffrFeUfNV2Hib", object: "customer", email: "jenny@example.org" } }),
];

describe("C3 the API's own relative paths are not data", () => {
  it('Stripe list envelopes ({ url: "/v1/customers" }) don\'t trip the leak guard', () => {
    const r = gen(stripeList());
    expect(r.leaks).toEqual([]);
    expect(paths(r)).toEqual(["/v1/customers", "/v1/customers/{customerId}"]);
  });
  it("a relative path with an id in it still is", async () => {
    const { isDataLike } = await import("../src/leak.js");
    expect(isDataLike("/v1/customers/cus_NffrFeUfNV2Hib/sources")).toBe(true);
    expect(isDataLike("/v1/customers")).toBe(false);
  });
});

describe("C9 the mock keeps relative API paths and fakes only their ids", () => {
  it("url: /v1/customers stays, /v1/customers/<id> gets a fake id", async () => {
    const [list] = await mockAll([...stripeList(), entry({ url: "https://api.stripe.test/v1/x", resBody: { next: "/v1/customers/cus_NffrFeUfNV2Hib/sources?page=2" } })]);
    expect(JSON.parse(list!).url).toBe("/v1/customers");
    const all = (await mockAll([...stripeList(), entry({ url: "https://api.stripe.test/v1/x", resBody: { next: "/v1/customers/cus_NffrFeUfNV2Hib/sources?page=2" } })]))[2]!;
    expect(JSON.parse(all).next).toMatch(/^\/v1\/customers\/cus_[A-Za-z0-9]{14}\/sources$/);
    expect(all).not.toContain("NffrFeUfNV2Hib");
  });
});

// ── C8 ─────────────────────────────────────────────────────────────────────────

describe("C8 type discriminators survive the mock", () => {
  it("__typename, Stripe's object and PascalCase types are kept", async () => {
    const [gql, rest] = await mockAll([
      entry({ method: "POST", url: O + "/graphql", reqBody: { query: "query P { product { __typename id name } }" }, resBody: { data: { product: { __typename: "Product", id: "p1", name: "Trail Pro" } } } }),
      entry({ url: O + "/api/me", resBody: { object: "customer", type: "User", kind: "OrganizationMember", name: "Oguz" } }),
    ]);
    expect(JSON.parse(gql!).data.product.__typename).toBe("Product");
    const me = JSON.parse(rest!);
    expect([me.object, me.type, me.kind]).toEqual(["customer", "User", "OrganizationMember"]);
    expect(me.name).not.toBe("Oguz");
  });
  it("…unless the value is recorded as a person's name", async () => {
    const [, body] = await mockAll([entry({ url: O + "/api/users", resBody: [{ id: 1, login: "Mdemir" }] }), entry({ url: O + "/api/x", resBody: { type: "Mdemir" } })]);
    expect(body).not.toContain("Mdemir");
  });
});

// ── C10 / C12 ──────────────────────────────────────────────────────────────────

describe("C10 the mock keeps tRPC superjson output metadata", () => {
  it("meta.values travels with the json", async () => {
    const [body] = await mockAll([
      entry({ url: O + "/api/trpc/user.byId?input=" + encodeURIComponent(JSON.stringify({ json: { id: "usr_8f3k2l9x" } })), resBody: { result: { data: { json: { id: "usr_8f3k2l9x", createdAt: "2026-01-01T00:00:00.000Z" }, meta: { values: { createdAt: ["Date"] } } } } } }),
    ]);
    expect(JSON.parse(body!).result.data.meta).toEqual({ values: { createdAt: ["Date"] } });
  });
});

describe("C12 superjson meta paths that run through data keys are not baked in", () => {
  it("seen.<order id> is dropped, the plain path stays", () => {
    const r = gen([
      entry({ method: "POST", url: O + "/api/trpc/prefs.save", reqBody: { json: { seen: { "ord-77314": "2026-01-01T00:00:00.000Z" }, since: "2026-01-01T00:00:00.000Z" }, meta: { values: { "seen.ord-77314": ["Date"], since: ["Date"] } } }, resBody: { result: { data: { json: { ok: true } } } } }),
    ]);
    expect(r.leaks).toEqual([]);
    expect(r.files["client.ts"]).not.toContain("ord-77314");
    expect(r.files["client.ts"]).toContain('{"since":["Date"]}');
  });
});

// ── P7 / C6 ────────────────────────────────────────────────────────────────────

const J = "https://acme.atlassian.test";
const jira = () => [
  entry({ url: J + "/rest/api/2/issue/PROJ-12", resBody: { id: "10002", key: "PROJ-12", fields: { summary: "Login broken", status: { name: "In Progress" } } } }),
  entry({ url: J + "/rest/api/2/issue/PROJ-7/comment", resBody: { comments: [{ id: "10000", body: "Looks good" }], total: 1 } }),
  entry({ url: J + "/rest/api/2/project/PROJ", resBody: { id: "10000", key: "PROJ", name: "Project Phoenix" } }),
  entry({ url: J + "/rest/agile/1.0/board/42/sprint?state=active", resBody: { values: [{ id: 37, state: "active", name: "Sprint 12" }] } }),
];

describe("P7 Jira-style issue keys in paths are identifiers", () => {
  it("PROJ-7 seen once in a path is a parameter, not a literal", () => {
    const r = gen(jira());
    expect(paths(r)).toEqual(["/rest/agile/1.0/board/{boardId}/sprint", "/rest/api/2/issue/{issueId}", "/rest/api/2/issue/{issueId}/comment", "/rest/api/2/project/{projectId}"]);
    expect(r.leaks).toEqual([]);
    expect(allText(jira())).not.toMatch(/PROJ-\d/);
  });
});

describe("C6 a value the response echoes as its own key is a parameter after a singular collection too", () => {
  it("/project/PROJ → { key: \"PROJ\" }", () => {
    expect(paths(gen(jira()))).toContain("/rest/api/2/project/{projectId}");
  });
  it("…but /settings/profile → { name: \"profile\" } stays literal", () => {
    expect(paths(gen([entry({ url: O + "/api/settings/profile", resBody: { name: "profile", bio: "x" } })]))).toEqual(["/api/settings/profile"]);
  });
});

// ── P8 ─────────────────────────────────────────────────────────────────────────

describe("P8 tenant slugs ending in s after /orgs/", () => {
  it("/orgs/acme-labs/members is /orgs/{org}/members", () => {
    const entries = [entry({ url: O + "/orgs/acme-labs/members", resBody: [{ login: "x1y2z3", id: 1 }] })];
    expect(paths(gen(entries))).toEqual(["/orgs/{orgId}/members"]);
    expect(allText(entries)).not.toContain("acme-labs");
  });
  it("/orgs/members (a sub-collection) stays literal", () => {
    expect(paths(gen([entry({ url: O + "/api/orgs/members/list", resBody: [] })]))).toEqual(["/api/orgs/members/list"]);
  });
});

// ── C7 ─────────────────────────────────────────────────────────────────────────

describe("C7 Shopify-style dated API versions and .json suffixes", () => {
  const SH = "https://acme-store.myshop.test";
  const shop = () => [
    entry({ url: SH + "/admin/api/2024-01/products.json?limit=2", resBody: { products: [{ id: 632910392, title: "IPod Nano", status: "active" }] } }),
    entry({ url: SH + "/admin/api/2024-01/products/632910392.json", resBody: { product: { id: 632910392, title: "IPod Nano", status: "active" } } }),
    entry({ url: SH + "/admin/api/2024-01/customers/207119551/orders.json", resBody: { orders: [] } }),
  ];
  it("the version stays literal and {id}.json keeps its extension outside the parameter", () => {
    const r = gen(shop());
    expect(paths(r)).toEqual(["/admin/api/2024-01/customers/{customerId}/orders.json", "/admin/api/2024-01/products.json", "/admin/api/2024-01/products/{productId}.json"]);
    expect(r.plan.ops.map((o) => o.ep.name).sort()).toEqual(["getProduct", "listCustomerOrders", "listProducts"]);
    expect(r.leaks).toEqual([]);
  });
  it("the client sends the extension and the mock answers it", async () => {
    const r = gen(shop());
    expect(r.files["client.ts"]).toMatch(/products\/\$\{enc\(params\.productId\)\}\.json`/);
    const bodies = await mockAll(shop());
    expect(JSON.parse(bodies[1]!).product.status).toBe("active");
  });
});

// ── C5 ─────────────────────────────────────────────────────────────────────────

describe("C5 GitHub-style /repos/{owner}/{repo}/…", () => {
  const G = "https://api.github.test";
  const repo = (owner: string, name: string) => ({ id: 5000 + name.length, name, full_name: `${owner}/${name}`, owner: { login: owner, id: 1 }, private: false });
  const gh = () => [
    entry({ url: G + "/user", resBody: { login: "okilic", id: 1, name: "Oguz Kilic" } }),
    entry({ url: G + "/users/okilic/repos", resBody: [repo("okilic", "widget9"), repo("okilic", "dotfiles")] }),
    entry({ url: G + "/repos/okilic/widget9", resBody: repo("okilic", "widget9") }),
    entry({ url: G + "/repos/okilic/widget9/issues?state=open", resBody: [{ id: 1, number: 12, state: "open", title: "x" }] }),
    entry({ url: G + "/repos/okilic/widget9/issues/12", resBody: { id: 1, number: 12, state: "open", title: "x" } }),
    entry({ url: G + "/repos/okilic/dotfiles/pulls", resBody: [] }),
  ];
  it("owner and repository are both parameters", () => {
    const r = gen(gh());
    expect(paths(r)).toEqual(["/repos/{owner}/{repo}", "/repos/{owner}/{repo}/issues", "/repos/{owner}/{repo}/issues/{issueId}", "/repos/{owner}/{repo}/pulls", "/user", "/users/{userId}/repos"]);
    expect(r.leaks).toEqual([]);
    expect(allText(gh())).not.toMatch(/dotfiles|okilic/);
  });
});

// ── C4 ─────────────────────────────────────────────────────────────────────────

describe("C4 names of things are not personal data", () => {
  const shop = () => [
    entry({ url: O + "/api/categories", resBody: [{ id: 1, name: "Books" }, { id: 2, name: "Music" }, { id: 3, name: "Featured" }] }),
    entry({ url: O + "/api/books", resBody: [{ id: 1, title: "x" }] }),
    entry({ url: O + "/api/products/featured", resBody: [{ id: 1, title: "x" }] }),
    entry({ url: O + "/api/cart", resBody: { items: [], shipping: { amount: 5 }, premium: true } }),
    entry({ url: O + "/api/plans", resBody: [{ id: "p1", name: "Premium" }, { id: "p2", name: "Shipping" }] }),
  ];
  it("a category called Books doesn't stop /api/books from being written", () => {
    const r = gen(shop());
    expect(r.leaks).toEqual([]);
    expect(paths(r)).toEqual(["/api/books", "/api/cart", "/api/categories", "/api/plans", "/api/products/featured"]);
  });
  it("a person's name under `name` still is (an object with contact fields, or a list of users)", () => {
    const people = [
      entry({ url: O + "/api/contacts", resBody: [{ id: 1, name: "Oguz", email: "t@x.io" }] }),
      entry({ url: O + "/api/users", resBody: [{ id: 2, name: "Mehmet" }] }),
      entry({ url: O + "/api/oguz/settings", resBody: { a: 1 } }),
      entry({ url: O + "/api/x", resBody: { mehmet: true } }),
    ];
    expect(gen(people).leaks.length).toBeGreaterThan(0);
  });
});

// ── P6 ─────────────────────────────────────────────────────────────────────────

describe("P6 small dictionaries keyed by recorded names", () => {
  const team = () => [
    entry({ url: O + "/api/team", resBody: [{ id: 1, firstName: "Oguz", email: "t@x.io" }, { id: 2, firstName: "Mehmet", email: "m@x.io" }] }),
    entry({ url: O + "/api/scores", resBody: { oguz: { score: 3 }, mehmet: { score: 5 } } }),
    entry({ url: O + "/api/online", resBody: { oguz: true, mehmet: false } }),
  ];
  it("two same-shaped entries keyed by recorded names are a Record", () => {
    const r = gen(team());
    expect(r.leaks).toEqual([]);
    expect(r.files["client.ts"]).toMatch(/Record<string, \w+>/);
    expect(allText(team())).not.toMatch(/oguz|mehmet/i);
  });
  it("the mock fakes those keys", async () => {
    const bodies = await mockAll(team());
    expect(bodies.slice(1).join("\n")).not.toMatch(/oguz|mehmet/i);
    expect(Object.keys(JSON.parse(bodies[1]!))).toHaveLength(2);
  });
  it("an object whose keys merely share a recorded word keeps its properties", () => {
    const r = gen([entry({ url: O + "/api/team", resBody: [{ id: 1, firstName: "Status", email: "t@x.io" }] }), entry({ url: O + "/api/x", resBody: { status: "ok", count: 3 } })]);
    expect(r.files["client.ts"]).toMatch(/status: string;/);
  });
});

describe("C13 a recorded value that is one of the generator's own words is not a leak", () => {
  it("a repository called har2sdk", () => {
    const r = gen([entry({ url: O + "/api/repos", resBody: [{ id: 1, name: "har2sdk", full_name: "x/har2sdk" }] })]);
    expect(r.leaks).toEqual([]);
  });
});

// ── P9 ─────────────────────────────────────────────────────────────────────────

describe("P9 usernames under role keys (reviewer, approver, requester…)", () => {
  it("are identities", () => {
    const entries = [
      entry({ url: O + "/api/prs/12", resBody: { id: 12, reviewer: "mdemir", approver: "ecek", requester: "okilic" } }),
      entry({ url: O + "/api/users/mdemir/stats", resBody: { n: 1 } }),
      entry({ url: O + "/api/prefs", resBody: { ecek: { muted: true } } }),
    ];
    expect(allText(entries)).not.toMatch(/mdemir|ecek/);
    expect(paths(gen(entries))).toContain("/api/users/{userId}/stats");
  });
});

// ── P10 ────────────────────────────────────────────────────────────────────────

describe("P10 upper-case tenant codes under identity keys", () => {
  it("{ team: \"ACME\" } makes /teams/ACME/… a parameter", () => {
    const entries = [entry({ url: O + "/api/me", resBody: { id: 1, email: "a@b.io", team: "ACME" } }), entry({ url: O + "/api/teams/ACME/members", resBody: [] })];
    expect(paths(gen(entries))).toContain("/api/teams/{teamId}/members");
    expect(allText(entries)).not.toMatch(/acme/i);
  });
  it("currency codes under id keys still aren't identities", async () => {
    const { collectTaint } = await import("../src/leak.js");
    const { loadHar } = await import("../src/har.js");
    const t = collectTaint(loadHar(har([entry({ url: O + "/api/x", resBody: { currencyId: "USD" } })])));
    expect(t.identities.has("usd")).toBe(false);
  });
});

// ── P11 ────────────────────────────────────────────────────────────────────────

describe("P11 file names after a collection are identifiers", () => {
  it("/attachments/hiv-test-results.pdf/meta", () => {
    const entries = [entry({ url: O + "/api/attachments/hiv-test-results.pdf/meta", resBody: { size: 3 } })];
    expect(paths(gen(entries))).toEqual(["/api/attachments/{attachmentId}/meta"]);
    expect(allText(entries)).not.toContain("hiv-test");
  });
  it("…but /api/v1/products.json and /docs/index.html stay", () => {
    expect(paths(gen([entry({ url: O + "/api/v1/products.json", resBody: [] }), entry({ url: O + "/api/export/report.csv", resMime: "text/csv", resText: "a,b\n1,2" })]))).toEqual(["/api/export/report.csv", "/api/v1/products.json"]);
  });
});

// ── P12 ────────────────────────────────────────────────────────────────────────

describe("P12 keys that are the identifier form of a recorded name", () => {
  it("{ oguz_kilic: {…} } is a Record, in the client and the mock", async () => {
    const entries = [entry({ url: O + "/api/me", resBody: { id: 1, fullName: "Oguz Kilic", email: "t@x.io" } }), entry({ url: O + "/api/scores", resBody: { oguz_kilic: { score: 3 } } })];
    const r = gen(entries);
    expect(r.leaks).toEqual([]);
    expect(allText(entries)).not.toMatch(/oguz_?kilic/i);
    expect((await mockAll(entries))[1]).not.toMatch(/oguz/i);
  });
});

// ── P13 ────────────────────────────────────────────────────────────────────────

describe("P13 calendar dates in a person's record are personal", () => {
  it("born: 1990-04-12 next to an email is masked; timestamps stay", async () => {
    const entries = [entry({ url: O + "/api/me", resBody: { id: 1, email: "t@x.io", born: "1990-04-12", createdAt: "2024-01-01T10:00:00Z" } })];
    const [body] = await mockAll(entries);
    expect(body).not.toContain("1990-04-12");
    expect(JSON.parse(body!).createdAt).toBe("2024-01-01T10:00:00Z");
    expect(gen(entries, { examples: true }).files["openapi.json"]).not.toContain("1990-04-12");
  });
});

// ── P14 ────────────────────────────────────────────────────────────────────────

describe("P14 the capture's file name is not written into generated files", () => {
  it("oguz-kilic-bank.har", () => {
    const r = gen([entry({ url: O + "/api/me", resBody: { id: 1, fullName: "Oguz Kilic", email: "t@x.io" } })], { source: "oguz-kilic-bank.har" });
    expect(r.leaks).toEqual([]);
    for (const f of Object.values(r.files)) expect(f).not.toContain("oguz-kilic-bank");
  });
});

describe("C14 the new evidence doesn't turn ordinary objects into Records", () => {
  it("{ shipping: {amount}, discount: {amount} } stays an interface when line items are named Shipping and Discount", () => {
    const r = gen([
      entry({ url: O + "/api/cart/lines", resBody: [{ id: 1, name: "Shipping", amount: 5 }, { id: 2, name: "Discount", amount: 1 }] }),
      entry({ url: O + "/api/cart/totals", resBody: { shipping: { amount: 5 }, discount: { amount: 1 } } }),
    ]);
    expect(r.files["client.ts"]).toMatch(/shipping: \w+;\n\s+discount: \w+;/);
    expect(r.leaks).toEqual([]);
  });
  it("…and the mock keeps those keys", async () => {
    const bodies = await mockAll([
      entry({ url: O + "/api/cart/lines", resBody: [{ id: 1, name: "Shipping", amount: 5 }, { id: 2, name: "Discount", amount: 1 }] }),
      entry({ url: O + "/api/cart/totals", resBody: { shipping: { amount: 5 }, discount: { amount: 1 } } }),
    ]);
    expect(Object.keys(JSON.parse(bodies[1]!))).toEqual(["shipping", "discount"]);
  });
  it("PascalCase values are kept only under discriminator keys", async () => {
    const [body] = await mockAll([entry({ url: O + "/api/x", resBody: { source: "Oguz", type: "Order" } })]);
    expect(JSON.parse(body!)).toMatchObject({ type: "Order" });
    expect(body).not.toContain("Oguz");
  });
});

describe("C15 role words recorded as values don't block parameter names", () => {
  it('author_association: "OWNER" and a {owner} parameter', () => {
    const r = gen([
      entry({ url: O + "/users/okilic/repos", resBody: [{ id: 1, name: "dotfiles" }] }),
      entry({ url: O + "/repos/okilic/dotfiles", resBody: { name: "dotfiles", owner: { login: "okilic" } } }),
      entry({ url: O + "/repos/okilic/dotfiles/issues", resBody: [{ id: 1, author_association: "OWNER" }] }),
    ]);
    expect(paths(r)).toEqual(["/repos/{owner}/{repo}", "/repos/{owner}/{repo}/issues", "/users/{userId}/repos"]);
    expect(r.leaks).toEqual([]);
  });
});

// ── P15 / C16 ──────────────────────────────────────────────────────────────────

describe("P15 non-ASCII names", () => {
  it("a dotted Turkish name after a collection is a parameter", () => {
    const entries = [entry({ url: O + "/api/profiles/" + encodeURIComponent("ayşe.yılmaz"), resBody: { id: 1, bio: "x" } })];
    expect(paths(gen(entries))).toEqual(["/api/profiles/{profileId}"]);
    expect(allText(entries)).not.toMatch(/ayşe|yılmaz|y%C4%B1lmaz/i);
  });
  it("the scanner sees non-ASCII values, also percent-encoded", async () => {
    const { scanText } = await import("../src/leak.js");
    const r = gen([entry({ url: O + "/api/me", resBody: { id: 1, login: "çağrı", email: "c@x.io" } })]);
    expect(scanText("const p = `/api/çağrı/stats`;", r.model.taint, "x")).toHaveLength(1);
    expect(scanText("const p = `/api/%C3%A7a%C4%9Fr%C4%B1/stats`;", r.model.taint, "x")).toHaveLength(1);
  });
  it("identifier forms are transliterated: Kılıç and oguz-kilic are the same person", () => {
    const entries = [entry({ url: O + "/api/me", resBody: { id: 1, fullName: "Oğuz Kılıç", email: "t@x.io", site: "https://oguz-kilic.dev" } })];
    expect(gen(entries, { examples: true }).files["openapi.json"]).not.toContain("oguz-kilic");
  });
});

describe("C16 the mock doesn't crash on a path with non-ASCII characters", () => {
  it("answers, with the endpoint header percent-encoded", async () => {
    const bodies = await mockAll([entry({ url: O + "/api/" + encodeURIComponent("iğdır") + "/weather", resBody: { t: 12 } })]);
    expect(JSON.parse(bodies[0]!)).toEqual({ t: 12 });
  });
});

// ── P16 ────────────────────────────────────────────────────────────────────────

describe("P16 an identity written with other separators (ece_kaya / ece-kaya / ece.kaya)", () => {
  const entries = () => [
    entry({ url: O + "/api/members", resBody: [{ id: 1, login: "ece_kaya" }] }),
    entry({ url: O + "/api/users/ece-kaya/settings", resBody: { a: 1 } }),
    entry({ url: O + "/api/me", resBody: { id: 1, email: "e@x.io", blog: "https://ece-kaya.github.io" } }),
  ];
  it("is the same identity in paths and in the scanner", async () => {
    expect(paths(gen(entries()))).toContain("/api/users/{userId}/settings");
    expect(allText(entries())).not.toMatch(/ece[-_.]kaya/);
    const { scanText } = await import("../src/leak.js");
    expect(scanText("const p = '/x/ece.kaya';", gen(entries()).model.taint, "x")).toHaveLength(1);
  });
  it("and in fake URLs", async () => {
    expect((await mockAll(entries()))[2]).not.toMatch(/ece[-_.]kaya/);
  });
});

describe("P17 evidence doesn't depend on the order of the capture", () => {
  it("a name searched for first and shown under fullName later is still recognised as a slug", async () => {
    const entries = [
      entry({ url: O + "/api/search?q=" + encodeURIComponent("Kerem Okafor"), resBody: { hits: [] } }),
      entry({ url: O + "/api/me", resBody: { id: 1, login: "kok", fullName: "Kerem Okafor", site: "https://kerem-okafor.dev" } }),
    ];
    expect((await mockAll(entries))[1]).not.toContain("kerem-okafor");
  });
});

describe("P18 a username with digits is personal under any key", () => {
  it("chiara50 alone on a line of a text body, or under a technical key", async () => {
    const entries = [
      entry({ url: O + "/api/members", resBody: [{ id: 1, login: "chiara50" }] }),
      entry({ url: O + "/api/whoami.txt", resMime: "text/plain", resText: "chiara50" }),
      entry({ url: O + "/api/x", resBody: { source: "chiara50" } }),
    ];
    const bodies = await mockAll(entries);
    expect(bodies.slice(1).join("\n")).not.toContain("chiara50");
  });
});

describe("P19 a one-word org slug that ends in s", () => {
  it("/orgs/kilics/teams", () => {
    const entries = [entry({ url: O + "/orgs/kilics/teams", resBody: [{ id: 1 }] })];
    expect(paths(gen(entries))).toEqual(["/orgs/{orgId}/teams"]);
  });
});

describe("P20 a fake id is never the recorded id", () => {
  it("even when the random digits come out the same", async () => {
    const { Scrubber } = await import("../src/redact.js");
    for (let seed = 0; seed < 300; seed++) {
      const s = new Scrubber({ seed });
      for (const v of ["DEM-66", "ab-11", "X-1", "ord-7"]) expect(s.fake(v)).not.toBe(v);
    }
  });
});

// ── C17 ────────────────────────────────────────────────────────────────────────

describe("C17 --examples on the demo is not refused", () => {
  it("timestamps the scrubber keeps on purpose don't count as leaks", async () => {
    const { demoHar } = await import("./helpers.js");
    const r = generateFromHar(demoHar(), { examples: true });
    expect(r.leaks).toEqual([]);
    expect(r.files["openapi.json"]).toContain('"example"');
  });
  it("a recorded value in the spec itself still is", () => {
    // A GraphQL variable default is kept in the document (docs/KNOWN-ISSUES.md): the guard must still refuse it.
    const r = gen([entry({ method: "POST", url: O + "/graphql", reqBody: { query: 'query Q($login: String = "mdemir") { user(login: $login) { id } }' }, resBody: { data: { user: { id: 1 } } } })], { examples: true });
    expect(r.leaks.length).toBeGreaterThan(0);
  });
});
