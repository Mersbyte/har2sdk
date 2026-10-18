/**
 * Fourth external review (v0.4.0): the guard broke correct output (R1, R2,
 * M1) and new shapes still leaked (L1–L5, G1, G2).
 */
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { generateFromHar } from "../src/index.js";
import { listenMock } from "../src/mock.js";
import { buildPlan } from "../src/plan.js";
import { renderChatPrompt, renderEndpointDetail } from "../src/summary.js";
import { demoHar, entry, har } from "./helpers.js";

const gen = (entries: ReturnType<typeof entry>[], opts = {}) => generateFromHar(har(entries), opts);
const paths = (r: ReturnType<typeof gen>) => r.plan.ops.map((o) => o.ep.path).sort();
const allText = (r: ReturnType<typeof gen>) => {
  const plan = buildPlan(structuredClone(r.model));
  return [...Object.values(r.files), renderChatPrompt(plan), ...plan.ops.map((o) => renderEndpointDetail(plan, o))].join("\n");
};

async function serve(r: ReturnType<typeof gen>, path: string): Promise<any> {
  const server = await listenMock(r.model, r.exchanges, { port: 0 });
  try {
    return await (await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${path}`)).json();
  } finally {
    server.close();
  }
}

// ── R1 ─────────────────────────────────────────────────────────────────────────

describe("R1 keys with digits are property names", () => {
  it("demo keeps ShippingAddress typed", () => {
    const code = generateFromHar(demoHar()).files["client.ts"]!;
    expect(code).toMatch(/export interface ShippingAddress \{[^}]*line1: string;[^}]*postalCode: string;/);
  });
  it("{ last4, brand } stays an object type", () => {
    const r = gen([entry({ url: "https://api.k.test/api/payment", resBody: { card: { last4: "4242", brand: "visa" } } })]);
    expect(r.files["client.ts"]).toMatch(/export interface Card \{\n\s+last4: string;\n\s+brand: string;/);
  });
  it("sha256, md5Hash, s3Bucket, utf8Name, line2 keep the object typed", () => {
    const r = gen([entry({ url: "https://api.k.test/api/file", resBody: { name: "a", sha256: "x", md5Hash: "y", s3Bucket: "b", utf8Name: "n", line2: "l" } })]);
    const code = r.files["client.ts"]!;
    expect(code).toMatch(/export interface GetFileResponse \{[^}]*sha256: string;[^}]*s3Bucket: string;/);
  });
});

// ── R2 ─────────────────────────────────────────────────────────────────────────

describe("R2 recorded vocabulary doesn't turn path words into parameters", () => {
  it("oauth2, ipv4, web3, covid19 stay literal", () => {
    const r = gen([
      entry({ url: "https://api.w.test/api/me", resBody: { provider: "oauth2", proto: "ipv4", chain: "web3", topic: "covid19" } }),
      entry({ method: "POST", url: "https://api.w.test/api/oauth2/token", reqBody: { a: 1 }, resBody: { ok: true } }),
      entry({ url: "https://api.w.test/api/v1/ipv4/lookup", resBody: { ok: true } }),
      entry({ url: "https://api.w.test/api/v2/web3/blocks", resBody: [] }),
      entry({ url: "https://api.w.test/api/v2/covid19/stats", resBody: { n: 1 } }),
    ]);
    expect(paths(r)).toEqual(["/api/me", "/api/oauth2/token", "/api/v1/ipv4/lookup", "/api/v2/covid19/stats", "/api/v2/web3/blocks"]);
  });
});

// ── M1 ─────────────────────────────────────────────────────────────────────────

describe("M1 the mock keeps the JSON shape", () => {
  const body = {
    card: { last4: "4242", brand: "visa" },
    addressLine2: "Daire 4",
    sha256: "ab12",
    proto: "ipv4",
    avatar: "https://cdn.m.test/u/77/a.jpg",
    lastIp: "203.0.113.7",
    members: [{ login: "okilic" }, { login: "mdemir" }, { login: "zozturk" }],
  };
  it("never renames keys, keeps categories, keeps list values distinct", async () => {
    const r = gen([entry({ url: "https://api.m.test/api/me", resBody: body }), entry({ url: "https://api.m.test/api/team", resBody: { owner: { login: "okilic" } } })]);
    const me = await serve(r, "/api/me");
    expect(Object.keys(me).sort()).toEqual(Object.keys(body).sort());
    expect(Object.keys(me.card).sort()).toEqual(["brand", "last4"]);
    expect(me.card.brand).toBe("visa");
    expect(me.proto).toBe("ipv4");
    expect(me.avatar).toMatch(/\.jpg$/);
    expect(me.lastIp).toMatch(/^192\.0\.2\.\d+$/);
    const logins = me.members.map((m: any) => m.login);
    expect(new Set(logins).size).toBe(3);
    for (const l of logins) expect(["okilic", "mdemir", "zozturk"]).not.toContain(l);
  });
});

// ── L1–L5 ────────────────────────────────────────────────────────────────────

describe("L1 letter-only identity keys are map keys", () => {
  it("reactions keyed by usernames, and a single username key seen elsewhere", () => {
    const r = gen([
      entry({ url: "https://api.l.test/api/posts/1", resBody: { id: 1, author: { login: "okilic" }, reactions: { okilic: { emoji: "+1", at: "2026-01-01" }, mdemir: { emoji: "+1", at: "2026-01-02" }, zozturk: { emoji: "-1", at: "2026-01-03" } } } }),
      entry({ url: "https://api.l.test/api/prefs", resBody: { okilic: { theme: "dark", lang: "tr" } } }),
    ]);
    const text = allText(r);
    for (const v of ["okilic", "Okilic", "mdemir", "Mdemir", "zozturk"]) expect(text).not.toContain(v);
    expect(r.files["client.ts"]).toContain("reactions: Record<string,");
  });
});

describe("L2 data in query parameter names", () => {
  it("?role[oguz@kilic.dev]=admin never becomes a property", () => {
    const r = gen([entry({ url: "https://api.l.test/api/acl?role%5Boguz%40kilic.dev%5D=admin&page=1", resBody: { ok: true } })]);
    expect(allText(r)).not.toContain("oguz@kilic.dev");
    expect(r.warnings.join("\n")).toMatch(/query parameter/);
    expect(r.files["client.ts"]).toContain("page?: number");
  });
});

describe("L3 sensitive vocabulary never becomes an enum", () => {
  it("medical categories and usernames in `source`", () => {
    const rows = Array.from({ length: 8 }, (_, i) => ({ category: i % 2 ? "onkoloji" : "psikiyatri", source: i % 2 ? "mdemir" : "okilic", status: i % 2 ? "open" : "done" }));
    const r = gen([entry({ url: "https://api.l.test/api/appointments", resBody: rows }), entry({ url: "https://api.l.test/api/users/1", resBody: { id: 1, login: "mdemir" } })]);
    const text = allText(r);
    for (const v of ["onkoloji", "psikiyatri", "mdemir", "okilic"]) expect(text).not.toContain(v);
    expect(r.files["client.ts"]).toContain('status: "done" | "open" | (string & {});');
  });
});

describe("L4 every inline GraphQL string becomes a variable", () => {
  it("term and tag literals", () => {
    const r = gen([entry({ method: "POST", url: "https://api.g.test/graphql", reqBody: { query: 'query D { doctors(term: "psikiyatrist", tag: "ivf-tedavisi") { id } }' }, resBody: { data: { doctors: [] } } })]);
    const text = allText(r);
    expect(text).not.toContain("psikiyatrist");
    expect(text).not.toContain("ivf-tedavisi");
    expect(r.files["client.ts"]).toContain("doctors(term: $term, tag: $tag)");
  });
});

describe("L5 single-sample names in paths", () => {
  it("/people/ece, /profiles/oguz.kilic, /teams/oguzs-clinic", () => {
    const r = gen([
      entry({ url: "https://api.l.test/api/people/ece", resBody: { name: "Ece", age: 30 } }),
      entry({ url: "https://api.l.test/api/profiles/oguz.kilic", resBody: { bio: "x" } }),
      entry({ url: "https://api.l.test/api/teams/oguzs-clinic/members", reqHeaders: { "x-tenant": "oguzs-clinic" }, resBody: [{ id: 1 }] }),
    ]);
    expect(paths(r)).toEqual(["/api/people/{personId}", "/api/profiles/{profileId}", "/api/teams/{teamId}/members"]);
    for (const v of ["ece", "Ece", "oguz", "Oguzs"]) expect(allText(r)).not.toMatch(new RegExp(`\\b${v}`));
  });
});

// ── G1 G2 ────────────────────────────────────────────────────────────────────

describe("G1 the guard blocks by default, without false positives on clean captures", () => {
  it("clean demo: no findings", () => {
    expect(generateFromHar(demoHar()).leaks).toEqual([]);
  });
  it("realistic clean capture with short ids and words: no findings", () => {
    const r = gen([
      entry({ url: "https://api.c.test/api/orders?status=open", resBody: [{ id: "sales1", state: "open", total: 12.5, sku: "SKU-1042" }] }),
      entry({ url: "https://api.c.test/api/settings", resBody: { theme: "sepia", locale: "tr-TR", s3Bucket: "assets" } }),
    ]);
    expect(r.leaks).toEqual([]);
  });
});

describe("G2 MCP doesn't treat / as a safe working directory", () => {
  it("refuses an out_dir elsewhere when cwd is /", async () => {
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const { createMcpServer } = await import("../src/mcp.js");
    const dir = mkdtempSync(join(tmpdir(), "har2sdk-g2-"));
    mkdirSync(join(dir, "cap"));
    writeFileSync(join(dir, "cap", "c.har"), har([entry({ url: "https://api.c.test/api/x", resBody: { a: 1 } })]));
    const cwd = process.cwd();
    process.chdir("/");
    try {
      const server = createMcpServer();
      const [a, b] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "t", version: "1" });
      await Promise.all([server.connect(a), client.connect(b)]);
      const res: any = await client.callTool({ name: "generate_sdk", arguments: { har_path: join(dir, "cap", "c.har"), out_dir: "/home/elsewhere/deep" } });
      expect(res.isError).toBe(true);
      const ok: any = await client.callTool({ name: "generate_sdk", arguments: { har_path: join(dir, "cap", "c.har") } });
      expect(ok.isError).toBeFalsy();
    } finally {
      process.chdir(cwd);
    }
  });
});

// ── small ones ────────────────────────────────────────────────────────────────

describe("naming and messages", () => {
  it("a second document under one name gets a readable name", () => {
    const r = gen([
      entry({ method: "POST", url: "https://api.g.test/graphql", reqBody: { operationName: "Feed", query: "query Feed { feed { id } }" }, resBody: { data: { feed: [] } } }),
      entry({ method: "POST", url: "https://api.g.test/graphql", reqBody: { operationName: "Feed", query: "query Feed($after: String) { feed(after: $after) { id } }" }, resBody: { data: { feed: [] } } }),
    ]);
    expect(r.plan.ops.map((o) => o.ep.name).sort()).toEqual(["feed", "feedByAfter"]);
  });
  it("a reserved method name says reserved", () => {
    const r = gen([entry({ method: "POST", url: "https://api.n.test/x", reqBody: { a: 1 }, resBody: { ok: true } })], { annotations: { endpoints: { "POST /x": { name: "then" } } } });
    expect(r.warnings.join("\n")).toMatch(/"then".*reserved/);
  });
  it("two real locales without Accept-Language are one endpoint", () => {
    const body = { items: [{ id: 1, total: 2 }], count: 1 };
    const r = gen([entry({ url: "https://shop.l.test/en/api/cart", resBody: body }), entry({ url: "https://shop.l.test/de/api/cart", resBody: body })]);
    expect(paths(r)).toEqual(["/{locale}/api/cart"]);
  });
});

// ── demo snapshot ─────────────────────────────────────────────────────────────

describe("demo output is pinned", () => {
  it("endpoints, type names and fields match test/fixtures/demo-snapshot.json", async () => {
    const { readFileSync } = await import("node:fs");
    const { ROOT } = await import("./helpers.js");
    const want = JSON.parse(readFileSync(join(ROOT, "test/fixtures/demo-snapshot.json"), "utf8"));
    const r = generateFromHar(demoHar());
    const got = {
      endpoints: r.plan.ops.map((o) => `${o.ep.id} → ${o.ep.name}`),
      types: Object.fromEntries(r.plan.registry.types.map((t) => [t.name, t.aliasOf ? `= ${t.aliasOf}` : t.props.map((p) => p.name + (p.optional ? "?" : "")).join(", ")])),
    };
    // A change here is either a bug or a deliberate improvement: update the fixture on purpose.
    expect(got).toEqual(want);
  });
});
