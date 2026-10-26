/**
 * Twelfth review (v0.6.6, before launch). One describe block per finding.
 *
 * L1: a name recorded in parts (`firstName` + `lastName`) was never joined.
 * A slug the app builds from the parts (`/profiles/zeynep-kaya/settings`)
 * became a path literal and method name in client.ts, openapi.json, the
 * prompt and MCP, with exit 0.
 * L2: GraphQL decimals were not literals at all (`near(lat: 41.0123)`), and
 * a short number under an identity argument (`orders(customer: 48151)`) was
 * not lifted: both stayed in the document written to client.ts.
 * L3: the shape detectors and `isDataKey` knew only ASCII digits. A phone
 * number in Arabic-Indic, Devanagari or full-width digits in a path became a
 * literal, and a dictionary key "דוד-12" a property name ("david-12" was a
 * Record key).
 * L4: `TypeRegistry.intern` embedded each child's key, escaped again by
 * JSON.stringify at every level: a 194-byte body nested 26 deep threw
 * "Invalid string length".
 */
import { describe, expect, it } from "vitest";
import { generateFromHar } from "../src/index.js";
import { collectTaint, isDataLike, isIdShaped } from "../src/leak.js";
import { graphqlLiftMatches, graphqlListItems, graphqlLiteralMatches } from "../src/linear.js";
import { loadHar } from "../src/har.js";
import { isDataKey } from "../src/redact.js";
import { renderChatPrompt } from "../src/summary.js";
import { entry, har } from "./helpers.js";

const O = "https://api.acme.test";
const LIMIT_MS = 5_000;
const SLOW = { timeout: 60_000 };
const SEEDS = 3_000;
const AUTH = { authorization: "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJlLWV4YW1wbGU" };

/** Small deterministic PRNG (mulberry32), so a failing seed can be replayed. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = <T>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;

function timed(fn: () => unknown): number {
  const t = performance.now();
  fn();
  return performance.now() - t;
}

/** Everything a person or a model reads: both files and the chat prompt. */
function outputs(r: ReturnType<typeof generateFromHar>): string {
  return [r.files["client.ts"], r.files["openapi.json"], renderChatPrompt(r.plan)].join("\n").toLowerCase();
}

// ── L1 ─────────────────────────────────────────────────────────────────────────

describe("L1 a name recorded in two fields is linked to slugs built from it (leak.ts)", () => {
  const capture = (first: string, last: string, slug: string, keys: [string, string] = ["firstName", "lastName"]) =>
    har([
      entry({ url: `${O}/api/v1/me`, reqHeaders: AUTH, resBody: { id: 81723, [keys[0]]: first, [keys[1]]: last, email: "zk@example.org" } }),
      entry({ url: `${O}/api/v1/profiles/${encodeURIComponent(slug)}/settings`, reqHeaders: AUTH, resBody: { theme: "dark", locale: "tr-TR" } }),
      entry({ method: "PATCH", url: `${O}/api/v1/profiles/${encodeURIComponent(slug)}/settings`, reqHeaders: AUTH, reqBody: { theme: "light" }, resBody: { theme: "light", locale: "tr-TR" } }),
    ]);

  it("the reviewer's capture: the slug becomes a parameter, no output names the person", () => {
    const r = generateFromHar(capture("Zeynep", "Kaya", "zeynep-kaya"));
    expect(r.leaks).toEqual([]);
    const text = outputs(r);
    for (const v of ["zeynep-kaya", "zeynepkaya"]) expect(text).not.toContain(v);
    expect(r.files["client.ts"]).toContain("/api/v1/profiles/${");
  });

  it.each([
    ["zeynep_kaya", ["firstName", "lastName"]],
    ["zeynepkaya", ["first_name", "last_name"]],
    ["kaya-zeynep", ["givenName", "familyName"]],
    ["zeynep.kaya", ["vorname", "nachname"]],
    ["zeynep-kaya", ["isim", "soyad"]],
  ] as const)("%s with keys %j", (slug, keys) => {
    const r = generateFromHar(capture("Zeynep", "Kaya", slug, [...keys]));
    const text = outputs(r);
    expect(text).not.toContain(slug);
    expect(text).not.toContain("zeynepkaya");
  });

  it("names of things are not joined: productName + brandName, or a name and an email", () => {
    const t = collectTaint(loadHar(har([entry({ url: `${O}/api/p`, resBody: { productName: "Runner", brandName: "Acme", name: "Shoes", email: "a@example.org" } })])));
    for (const id of t.identities) expect(id).not.toMatch(/runner|acme|shoes/);
  });

  it(`generated: ${SEEDS / 10} random name pairs, keys and separators never reach the outputs`, SLOW, () => {
    const firstKeys = ["firstName", "first_name", "givenName", "given_name", "vorname", "isim", "nombre", "prenom"];
    const lastKeys = ["lastName", "last_name", "familyName", "surname", "nachname", "soyad", "apellido", "nom"];
    const syllables = ["ka", "ya", "zey", "nep", "mer", "lin", "dra", "os", "tu", "ren", "sel", "an", "vi", "ko"];
    const word = (r: () => number) => Array.from({ length: 2 + Math.floor(r() * 2) }, () => pick(r, syllables)).join("");
    for (let seed = 1; seed <= SEEDS / 10; seed++) {
      const r = rng(seed);
      const [first, last] = [word(r), word(r)];
      if (first === last) continue;
      const sep = pick(r, ["-", "_", ".", ""]);
      const slug = r() < 0.8 ? first + sep + last : last + sep + first;
      const cap = (s: string) => s[0]!.toUpperCase() + s.slice(1);
      const res = generateFromHar(capture(cap(first), cap(last), slug, [pick(r, firstKeys), pick(r, lastKeys)]));
      const text = outputs(res);
      expect(text, `seed ${seed}: ${slug}`).not.toContain(slug);
      expect(text, `seed ${seed}: ${slug}`).not.toContain((first + last).length >= 8 ? first + last : slug);
    }
  });
});

// ── L2 ─────────────────────────────────────────────────────────────────────────

describe("L2 GraphQL decimals and numbers under identity arguments are lifted (linear.ts, model.ts)", () => {
  const gql = (query: string) =>
    har([entry({ method: "POST", url: `${O}/graphql`, reqHeaders: AUTH, reqBody: { operationName: "Orders", query, variables: {} }, resBody: { data: { orders: [{ id: "o1" }] } } })]);

  it("the reviewer's document: customer, lat and lng become variables; first: 20 stays", () => {
    const r = generateFromHar(gql("query Orders { orders(customer: 48151, first: 20) { id } near(lat: 41.0123, lng: 28.9784) { id } }"));
    expect(r.leaks).toEqual([]);
    const client = r.files["client.ts"]!;
    for (const v of ["48151", "41.0123", "28.9784"]) {
      expect(client).not.toContain(v);
      expect(r.files["openapi.json"]).not.toContain(v);
    }
    expect(client).toContain("$lat: Float!");
    expect(client).toContain("$customer: Int!");
    expect(client).toContain("first: 20");
  });

  it("a decimal list is typed [Float!] and a short decimal outside a location argument stays", () => {
    const r = generateFromHar(gql("query Orders { orders(bbox: [41.0123, 28.9784], ratio: 0.5) { id } }"));
    expect(r.files["client.ts"]).toContain("$bbox: [Float!]!");
    expect(r.files["client.ts"]).toContain("ratio: 0.5");
  });

  it("a decimal left in a document (no operation to add variables to) is reported", () => {
    const t = collectTaint(loadHar(gql('{ near(lat: 41.0123) { id } }')));
    expect(t.values.has("41.0123")).toBe(true);
  });

  // The scanners must equal the regexes they implement, with decimals now part of NUMBER.
  const NUMBER = String.raw`-?\d+(?:\.\d+)?(?![\w.])`;
  const STRING = String.raw`"""[\s\S]*?"""|"(?:[^"\\\n]|\\.)*"(?!")`;
  const LIFT = new RegExp(
    String.raw`#[^\n]*|"""[\s\S]*?"""|"(?:[^"\\\n]|\\.)*"|\b([A-Za-z_][A-Za-z0-9_]*)(\s*:\s*)(${STRING}|${NUMBER}|\[\s*(?:(?:${STRING}|${NUMBER})\s*,?\s*)+\])`,
    "g",
  );
  const LITERALS = /#[^\n]*|(?:\b([A-Za-z_]\w*)\s*:\s*)?(?:"""([\s\S]*?)"""|"((?:[^"\\\n]|\\.)*)"|(?<![\w$.])(-?\d+(?:\.\d+)?)(?![\w.]))/g;
  const plain = (m: ArrayLike<string | undefined> & { index?: number }) => [m.index, ...Array.from(m)];
  const NUM_PIECES = ["1", "41", ".", ".0123", "0.5", "-", "-2.5", "1.2.3", "1.", ".5", "e", "a", "_", "$", " ", ": ", "lat", "x: ", ",", "[", "]", '"a"', "#"];
  const generated = (seed: number, alphabet: string[], max: number) => {
    const r = rng(seed);
    let s = "";
    for (let n = Math.floor(r() * (max + 1)); n > 0; n--) s += pick(r, alphabet);
    return s;
  };

  it("generated: graphqlLiftMatches equals the regex on decimals", () => {
    for (let seed = 0; seed < SEEDS; seed++) {
      const doc = generated(seed, NUM_PIECES, 16);
      expect([...graphqlLiftMatches(doc)].map(plain), `seed ${seed}: ${JSON.stringify(doc)}`).toEqual([...doc.matchAll(LIFT)].map(plain));
    }
  });

  it("generated: graphqlListItems equals the regex on decimals", () => {
    const items = new RegExp(`${STRING}|${NUMBER}`, "g");
    for (let seed = 0; seed < SEEDS; seed++) {
      const doc = generated(seed, NUM_PIECES, 20);
      expect([...graphqlListItems(doc)], `seed ${seed}: ${JSON.stringify(doc)}`).toEqual([...doc.matchAll(items)].map((m) => [m.index, m.index! + m[0].length]));
    }
  });

  it("generated: graphqlLiteralMatches equals the regex on decimals", () => {
    for (let seed = 0; seed < SEEDS; seed++) {
      const doc = generated(seed, NUM_PIECES, 20);
      expect([...graphqlLiteralMatches(doc)].map(plain), `seed ${seed}: ${JSON.stringify(doc)}`).toEqual([...doc.matchAll(LITERALS)].map(plain));
    }
  });

  it("linear on 200 KB runs of dotted digits", () => {
    for (const doc of ["a: " + "1.".repeat(100_000), "a: [" + "1.1.".repeat(50_000), "a: " + "1".repeat(200_000) + ".", "lat: 1." + "1".repeat(200_000) + "."]) {
      expect(timed(() => [...graphqlLiftMatches(doc)])).toBeLessThan(LIMIT_MS);
      expect(timed(() => [...graphqlLiteralMatches(doc)])).toBeLessThan(LIMIT_MS);
      expect(timed(() => [...graphqlListItems(doc)])).toBeLessThan(LIMIT_MS);
    }
  });
});

// ── L3 ─────────────────────────────────────────────────────────────────────────

/** The zero of every decimal-digit set (\p{Nd}) in the BMP and beyond. */
const ZEROS = (() => {
  const out: number[] = [];
  for (let cp = 0x30; cp < 0x20000; cp++) if (/^\p{Nd}$/u.test(String.fromCodePoint(cp)) && !/^\p{Nd}$/u.test(String.fromCodePoint(cp - 1))) out.push(cp);
  return out;
})();
const digitsOf = (zero: number, ascii: string) => [...ascii].map((d) => String.fromCodePoint(zero + Number(d))).join("");

describe("L3 digits and dictionary keys of any script are data (leak.ts, redact.ts)", () => {
  it("the reviewer's paths: phone numbers and ids in other digit sets become parameters", () => {
    const ids = ["٠٥٣٢١٢٣٤٥٦٧", "९८७६५४३२१०", "１２３４５６７８９０", "علي٣٤٥"];
    const r = generateFromHar(
      har([
        entry({ url: `${O}/api/v1/lookup/${encodeURIComponent(ids[0]!)}`, reqHeaders: AUTH, resBody: { found: true } }),
        entry({ url: `${O}/api/v1/accounts/${encodeURIComponent(ids[1]!)}/balance`, reqHeaders: AUTH, resBody: { amount: 12 } }),
        entry({ url: `${O}/api/v1/tickets/${encodeURIComponent(ids[2]!)}`, reqHeaders: AUTH, resBody: { state: "open" } }),
        entry({ url: `${O}/api/v1/members/${encodeURIComponent(ids[3]!)}/posts`, reqHeaders: AUTH, resBody: [{ title: "x" }] }),
      ]),
    );
    const text = outputs(r);
    for (const v of ids) {
      expect(text).not.toContain(v);
      expect(text).not.toContain(encodeURIComponent(v).toLowerCase());
    }
  });

  it("a dictionary keyed by non-Latin names with digits is a Record, like its ASCII twin", () => {
    for (const keys of [["david-12", "sarah-7"], ["דוד-12", "שרה-7"], ["李娜12", "王伟7"]]) {
      const r = generateFromHar(har([entry({ url: `${O}/api/v1/rooms`, reqHeaders: AUTH, resBody: { rooms: Object.fromEntries(keys.map((k, i) => [k, { open: i === 0 }])) } })]));
      for (const k of keys) expect(outputs(r), k).not.toContain(k);
    }
  });

  it(`generated: ${SEEDS} numbers in every digit set are data, and phone-shaped ones are id-shaped`, () => {
    expect(ZEROS.length).toBeGreaterThan(40);
    for (let seed = 1; seed <= SEEDS; seed++) {
      const r = rng(seed);
      const zero = pick(r, ZEROS);
      const ascii = String(1 + Math.floor(r() * 9)) + Array.from({ length: 6 + Math.floor(r() * 6) }, () => Math.floor(r() * 10)).join("");
      const v = digitsOf(zero, ascii);
      expect(isDataLike(v), `${seed}: ${v}`).toBe(true);
      expect(isIdShaped(v), `${seed}: ${v}`).toBe(true);
      expect(isDataKey(v), `${seed}: ${v}`).toBe(true);
    }
  });

  it("ASCII words with one or two digits stay property names and vocabulary", () => {
    for (const k of ["oauth2", "ipv4", "address2", "line1"]) {
      expect(isDataKey(k), k).toBe(false);
      expect(isIdShaped(k), k).toBe(false);
    }
  });
});

// ── L4 ─────────────────────────────────────────────────────────────────────────

describe("L4 type interning is linear in nesting depth (types.ts)", () => {
  const nested = (depth: number, key: (i: number) => string) => {
    let v: unknown = { leaf: "x" };
    for (let i = 0; i < depth; i++) v = { [key(i)]: v };
    return har([entry({ url: `${O}/api/deep`, resBody: v })]);
  };

  it.each([26, 40, 60])("a body nested %i deep generates quickly", (depth) => {
    let r: ReturnType<typeof generateFromHar> | undefined;
    expect(timed(() => (r = generateFromHar(nested(depth, (i) => `k${i % 7}`))))).toBeLessThan(LIMIT_MS);
    expect(r!.files["client.ts"]).toContain("leaf");
  });

  it("equal shapes still share a type at depth", () => {
    const body = { a: { b: { c: { id: 1 } } }, x: { b: { c: { id: 2 } } } };
    const r = generateFromHar(har([entry({ url: `${O}/api/twin`, resBody: body })]));
    expect(r.files["client.ts"]).toMatch(/export type X = A;|x: A;/);
  });

  it("generated: 60 random trees up to 60 deep each generate under the limit", SLOW, () => {
    for (let seed = 1; seed <= 60; seed++) {
      const r = rng(seed);
      const depth = 1 + Math.floor(r() * 60);
      expect(timed(() => generateFromHar(nested(depth, () => pick(r, ["child", "node", "next", "k1", "items"])))), `seed ${seed}`).toBeLessThan(LIMIT_MS);
    }
  });
});
