/**
 * Eighteenth review (v0.6.12): a read-only review by Codex of the 0.6.12 changes only (v0.6.11..666dcab).
 * Twelve findings, each reproduced with the reviewer's input before it was fixed. One describe block per finding.
 *
 * A1: a sender under `from` was forgotten when its username ended a path under a singular word (/inbox/parker).
 * A2: `reservationRef: "orchid"` was treated as vocabulary like `ref=main`.
 * A3: a username key with digits among ordinary keys ({"parker2026": {…}, "total": 1}) became a property.
 * A4: `last_order_by` (an actor) was exempted as an ordering key.
 * B1: French `identifiant` (any record's identifier) refused a normal catalogue.
 * B2: a second `?from=search` promoted the weak identity to a strong one, and the shop was refused again.
 * C1: the <meta>/<input> attribute reader was quadratic on a long attribute name without "=".
 * C2: the mock renamed a compound key in the payload but not in superjson `meta.values`.
 * C3: a GraphQL comment (`# owner: $o`) was read as an argument binding.
 * D1: an empty string in single-quoted script JSON made the whole literal unreadable.
 * D2: GraphQL GET variables weren't bound to their arguments.
 * D3: Express `j:` JSON cookies weren't parsed.
 */
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import type { HarEntry } from "../src/har.js";
import { generateFromHar } from "../src/index.js";
import { listenMock } from "../src/mock.js";
import { renderChatPrompt } from "../src/summary.js";
import { entry, har } from "./helpers.js";

const O = "https://app.acme.test";
const SLOW = { timeout: 120_000 };
type Result = ReturnType<typeof generateFromHar>;

function rng(seed: number): () => number {
  return () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
}
const CONSONANTS = "bcdfghjklmnpqrstvwxz";
const VOWELS = "aeiou";
const login = (rnd: () => number): string => {
  let w = "";
  for (let i = 0, n = 3 + Math.floor(rnd() * 2); i < n; i++) w += CONSONANTS[Math.floor(rnd() * CONSONANTS.length)]! + VOWELS[Math.floor(rnd() * VOWELS.length)]!;
  return w + CONSONANTS[Math.floor(rnd() * CONSONANTS.length)]!;
};
const hasWord = (text: string, w: string): boolean => new RegExp(`(?<![a-z0-9])${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![a-z0-9])`, "i").test(text);
const safe = (r: Result, value: string): boolean => r.leaks.length > 0 || !hasWord(r.files["client.ts"]!, value);
const profile = (name: string): HarEntry => entry({ url: `${O}/api/v1/profiles/${name}`, resBody: { title: "x", count: 3 } });
const page = (body: string): HarEntry => entry({ url: `${O}/`, resMime: "text/html", resText: `<html><body>${body}</body></html>`, resourceType: "document" });

async function mockGet(capture: string, path: string): Promise<string> {
  const r = generateFromHar(capture);
  const server = await listenMock(r.model, r.exchanges, { port: 0 });
  try {
    return await (await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${path}`)).text();
  } finally {
    server.close();
  }
}

describe("A1: a sender under `from` stays a person unless the capture has a top-level endpoint of that name", () => {
  it("the reviewer's input: /messages [{from: parker}] and /inbox/parker", () => {
    const r = generateFromHar(har([entry({ url: `${O}/api/v1/messages`, resBody: [{ from: "parker" }] }), entry({ url: `${O}/api/v1/inbox/parker`, resBody: { unread: 1 } })]));
    expect(safe(r, "parker")).toBe(true);
    expect(renderChatPrompt(r.plan)).not.toContain("parker");
  });
  it("control: the word of a top-level endpoint is still the app's word (review 17, R1)", () => {
    for (const path of ["/api/v1/orders", "/api/orders", "/orders", "/v2/orders"]) {
      const r = generateFromHar(har([entry({ url: `${O}/api/v1/notifications`, resBody: [{ from: "orders" }] }), entry({ url: O + path, resBody: [] })]));
      expect(r.leaks).toEqual([]);
    }
  });
  it("generated: random senders under a singular collection word", () => {
    const rnd = rng(18);
    for (let i = 0; i < 20; i++) {
      const name = login(rnd);
      const parent = ["inbox", "chat", "thread", "wall", "feed"][i % 5]!;
      const key = ["from", "to", "by"][i % 3]!;
      expect(safe(generateFromHar(har([entry({ url: `${O}/api/v1/messages`, resBody: [{ [key]: name }] }), entry({ url: `${O}/api/v1/${parent}/${name}`, resBody: { n: 1 } })])), name)).toBe(true);
    }
  });
});

describe("A2: compound reference keys name a record", () => {
  it("the reviewer's input: reservationRef: orchid", () => {
    const r = generateFromHar(har([entry({ url: `${O}/api/v1/bookings`, resBody: { reservationRef: "orchid" } }), entry({ url: `${O}/api/v1/bookings/orchid`, resBody: { confirmed: true } })]));
    expect(safe(r, "orchid")).toBe(true);
  });
  it("generated: *Ref, *Reference and *Number keys with letter-only values", () => {
    const rnd = rng(2);
    for (let i = 0; i < 15; i++) {
      const v = login(rnd);
      const key = ["reservationRef", "bookingReference", "caseNumber", "order_ref", "ticketNo"][i % 5]!;
      expect(safe(generateFromHar(har([entry({ url: `${O}/api/v1/items`, resBody: { [key]: v } }), entry({ url: `${O}/api/v1/items/${v}`, resBody: { ok: true } })])), v)).toBe(true);
    }
  });
  it("control: a bare `ref` with a plain word is still vocabulary (?ref=main)", () => {
    expect(generateFromHar(har([entry({ url: "https://gitlab.acme.test/api/v4/projects/7/repository/files/src%2Fmain.ts?ref=main", resBody: { file_name: "main.ts" } })])).leaks).toEqual([]);
  });
});

describe("A3: a digit-bearing key whose value is a record", () => {
  const capture = har([entry({ url: `${O}/api/v1/presence`, resBody: { parker2026: { online: true }, total: 1, status: "ok" } })]);
  it("never a property, never served as recorded (the reviewer's input)", async () => {
    const r = generateFromHar(capture);
    expect(r.files["client.ts"]).not.toContain("parker2026");
    expect(renderChatPrompt(r.plan)).not.toContain("parker2026");
    expect(await mockGet(capture, "/api/v1/presence")).not.toContain("parker2026");
  });
  it("control: one such key with a plain value is a property (review 17, R2)", () => {
    const r = generateFromHar(har([entry({ url: `${O}/api/products/42`, resBody: { id: 42, title: "Mouse", thumb_200: "https://cdn.acme.test/42.png", price: 19.9 } })]));
    expect(r.files["client.ts"]).toContain("thumb_200");
    expect(r.leaks).toEqual([]);
  });
  it("generated: random <login><digits> keys holding records beside ordinary keys", async () => {
    const rnd = rng(3);
    for (let i = 0; i < 10; i++) {
      const key = `${login(rnd)}${1000 + Math.floor(rnd() * 9000)}`;
      const cap = har([entry({ url: `${O}/api/v1/state`, resBody: { [key]: i % 2 ? { a: 1 } : [1, 2], count: 2, ok: true } })]);
      expect(generateFromHar(cap).files["client.ts"]).not.toContain(key);
      expect(await mockGet(cap, "/api/v1/state")).not.toContain(key);
    }
  });
});

describe("A4: actor fields that end in an ordering phrase", () => {
  it("the reviewer's input: last_order_by", () => {
    expect(safe(generateFromHar(har([entry({ url: `${O}/api/v1/queue`, resBody: { last_order_by: "parker" } }), profile("parker")])), "parker")).toBe(true);
  });
  it("generated: <word>_order_by, <word>_sort_by, <word>GroupBy hold people", () => {
    const rnd = rng(4);
    for (let i = 0; i < 12; i++) {
      const name = login(rnd);
      const key = ["last_order_by", "first_sort_by", "lastGroupBy", "prev_filter_by"][i % 4]!;
      expect(safe(generateFromHar(har([entry({ url: `${O}/api/v1/queue`, resBody: { [key]: name } }), profile(name)])), name)).toBe(true);
    }
  });
  it("control: sort_by and orderBy are still ordering controls", () => {
    expect(generateFromHar(har([entry({ url: `${O}/api/v1/orders`, resBody: [] }), entry({ url: `${O}/api/v1/customers?sort_by=orders`, resBody: [] })])).leaks).toEqual([]);
  });
});

describe("B1: French `identifiant` is a record's identifier", () => {
  it("the reviewer's input: a catalogue with identifiant: catalogue", () => {
    const r = generateFromHar(har([entry({ url: `${O}/api/v1/catalogue`, resBody: { identifiant: "catalogue", produits: [] } })]));
    expect(r.leaks).toEqual([]);
    expect(r.files["client.ts"]).toContain("getCatalogue");
  });
});

describe("B2: repeated weak evidence stays weak", () => {
  it("the reviewer's input: ?from=search twice", () => {
    const r = generateFromHar(
      har([entry({ url: `${O}/api/v1/search`, resBody: { items: [] } }), entry({ url: `${O}/api/v1/products/1?from=search`, resBody: { id: 1 } }), entry({ url: `${O}/api/v1/products/2?from=search`, resBody: { id: 2 } })]),
    );
    expect(r.leaks).toEqual([]);
  });
  it("generated: the same navigation word seen 2 to 6 times, in queries and bodies", () => {
    const rnd = rng(5);
    for (let i = 0; i < 10; i++) {
      const w = login(rnd);
      const n = 2 + (i % 5);
      const extra = Array.from({ length: n }, (_, k) => (k % 2 ? entry({ url: `${O}/api/v1/products/${k}?from=${w}`, resBody: { id: k } }) : entry({ method: "POST", url: "https://api.segment.io/v1/track", reqBody: { properties: { from: w, to: w } }, resBody: { ok: true } })));
      expect(generateFromHar(har([entry({ url: `${O}/api/v1/${w}`, resBody: { items: [] } }), ...extra])).leaks).toEqual([]);
    }
  });
  it("control: strong evidence still wins over weak", () => {
    const r = generateFromHar(har([entry({ url: `${O}/api/v1/me`, resBody: { login: "orders" } }), entry({ url: `${O}/api/v1/x?from=orders`, resBody: {} }), entry({ url: `${O}/api/v1/orders`, resBody: [] })]));
    expect(r.model.taint.identities.has("orders")).toBe(true);
  });
});

describe("C1: the attribute reader is linear", () => {
  for (const n of [40_000, 160_000]) {
    it(`<input followed by ${n} name characters and no "="`, SLOW, () => {
      const t0 = performance.now();
      generateFromHar(har([page(`<input ${"a".repeat(n)}>`), entry({ url: `${O}/api/v1/items`, resBody: [] })]));
      expect(performance.now() - t0).toBeLessThan(3_000);
    });
  }
  it("still reads reordered, unquoted and multiple attributes", () => {
    const r = generateFromHar(har([page('<meta content="parker" name="user-login"><input value=parker2 name=username>'), profile("parker"), profile("parker2")]));
    expect(safe(r, "parker")).toBe(true);
    expect(safe(r, "parker2")).toBe(true);
  });
});

describe("C2: superjson meta paths follow renamed compound keys (default mock)", () => {
  it("the reviewer's input", async () => {
    const cap = har([
      entry({ url: `${O}/api/v1/me`, resBody: { login: "parker" } }),
      entry({ url: `${O}/api/trpc/state.get?input=${encodeURIComponent('{"json":null}')}`, resBody: { result: { data: { json: { "user:parker": { since: "2026-01-01T00:00:00.000Z" } }, meta: { values: { "user:parker.since": ["Date"] } } } } } }),
    ]);
    const body = JSON.parse(await mockGet(cap, `/api/trpc/state.get?input=${encodeURIComponent('{"json":null}')}`));
    const data = body.result.data;
    const key = Object.keys(data.json)[0]!;
    expect(key).not.toContain("parker");
    expect(Object.keys(data.meta.values)).toEqual([`${key}.since`]);
  });
});

describe("C3: GraphQL comments and strings are not bindings", () => {
  const gql = (query: string, variables: Record<string, unknown>) => entry({ method: "POST", url: `${O}/graphql`, reqBody: { query, variables }, resBody: { data: { things: [] } } });
  it("the reviewer's input: # owner: $o in a comment", () => {
    const r = generateFromHar(har([gql("query Q($o: String!) { things(category: $o) # owner: $o\n { id } }", { o: "catalog" }), entry({ url: `${O}/api/v1/catalog`, resBody: { items: [] } })]));
    expect(r.leaks).toEqual([]);
  });
  it('a binding inside a string literal is not one: description: "owner: $o"', () => {
    const r = generateFromHar(har([gql('query Q($o: String!) { things(category: $o, note: "owner: $o") { id } }', { o: "catalog" }), entry({ url: `${O}/api/v1/catalog`, resBody: { items: [] } })]));
    expect(r.leaks).toEqual([]);
  });
  it("a comment between the argument and its variable still binds: owner: # c\\n $o", () => {
    expect(safe(generateFromHar(har([gql("query Q($o: String!) { things(owner: # who\n $o) { id } }", { o: "parker" }), profile("parker")])), "parker")).toBe(true);
  });
});

describe("D1: script string literals with empty strings and every escape", () => {
  const shapes: Record<string, (n: string) => string> = {
    emptyField: (n) => `<script>window.x=JSON.parse('{"viewer":{"login":"${n}","bio":""}}')</script>`,
    emptyFieldDouble: (n) => `<script>window.x=JSON.parse("{\\"viewer\\":{\\"login\\":\\"${n}\\",\\"bio\\":\\"\\"}}")</script>`,
    hexEscapes: (n) => `<script>window.x=JSON.parse('\\x7b"viewer":{"login":"${n}","a":"","b":""}\\x7d')</script>`,
    unicodeEscapes: (n) => `<script>window.x=JSON.parse('\\u007b"viewer":{"login":"${n}"}\\u{7d}')</script>`,
  };
  for (const [kind, html] of Object.entries(shapes)) {
    it(`${kind}${kind === "emptyField" ? " (the reviewer's input)" : ""}`, () => expect(safe(generateFromHar(har([page(html("parker")), profile("parker")])), "parker")).toBe(true));
  }
  it("generated: random logins with 0 to 3 empty fields around them", () => {
    const rnd = rng(6);
    for (let i = 0; i < 12; i++) {
      const name = login(rnd);
      const empties = Array.from({ length: i % 4 }, (_, k) => `"e${k}":""`).join(",");
      const json = `{${empties}${empties ? "," : ""}"viewer":{"login":"${name}"}}`;
      expect(safe(generateFromHar(har([page(`<script>s=JSON.parse('${json}')</script>`), profile(name)])), name)).toBe(true);
    }
  });
});

describe("D2: GraphQL over GET binds variables to arguments", () => {
  it("the reviewer's input", () => {
    const q = encodeURIComponent("query Q($o:String!){thing(owner:$o){ok}}");
    const v = encodeURIComponent('{"o":"parker"}');
    const r = generateFromHar(har([entry({ url: `${O}/graphql?query=${q}&variables=${v}`, resBody: { data: { thing: { ok: true } } } }), profile("parker")]));
    expect(safe(r, "parker")).toBe(true);
  });
  it("generated: random variable names and identity arguments", () => {
    const rnd = rng(7);
    for (let i = 0; i < 10; i++) {
      const name = login(rnd);
      const variable = ["o", "who", "x1"][i % 3]!;
      const arg = ["owner", "author", "login", "assignee"][i % 4]!;
      const q = encodeURIComponent(`query Q($${variable}:String!){thing(${arg}:$${variable}){ok}}`);
      const v = encodeURIComponent(JSON.stringify({ [variable]: name }));
      expect(safe(generateFromHar(har([entry({ url: `${O}/graphql?query=${q}&variables=${v}`, resBody: { data: { thing: { ok: true } } } }), profile(name)])), name)).toBe(true);
    }
  });
});

describe("D3: Express cookie envelopes", () => {
  for (const cookie of ["prefs=j%3A%7B%22login%22%3A%22parker%22%7D", 'prefs=j:{"login":"parker"}', "username=s%3Aparker.Q2xvdWRzaWduYXR1cmU", "username=s:parker.abc123"]) {
    it(`${cookie}${cookie.startsWith("prefs=j%3A") ? " (the reviewer's input)" : ""}`, () => {
      const e = entry({ url: `${O}/api/v1/flags`, reqHeaders: { cookie }, resBody: { ok: true } });
      expect(safe(generateFromHar(har([e, profile("parker")])), "parker")).toBe(true);
    });
  }
});
