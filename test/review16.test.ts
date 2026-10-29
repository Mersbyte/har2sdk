/**
 * Sixteenth review (v0.6.10): a read-only review by Codex of the 0.6.10 changes only (09d1927..ea7bcd6).
 * Six findings, each reproduced with the reviewer's input before it was fixed. One describe block per finding.
 *
 * B1: a response header describing the server (x-service-name: catalog, x-powered-by: Express) made its
 *     value personal, so the CLI refused a normal API (exit 2).
 * A2: removing GraphQL variable defaults searched the whole output once per default (quadratic).
 * C3: a valid GraphQL default that isn't JSON (a trailing comma, a comment, an escaped block string) was
 *     erased without its value, or cut short into an invalid document.
 * D4: an unquoted multipart field name (name=username) wasn't read.
 * D5: a server-sent event whose data spans several `data:` lines wasn't read.
 * D6: a "<" inside a script's JSON split it before the JSON reader saw it.
 */
import { describe, expect, it } from "vitest";
import type { HarEntry } from "../src/har.js";
import { loadHar } from "../src/har.js";
import { generateFromHar } from "../src/index.js";
import { splitUnits } from "../src/model.js";
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
const calendar = (name: string): HarEntry => entry({ url: `${O}/api/v1/people/${name}/calendar`, resBody: { ok: true } });

function withResponseHeaders(e: HarEntry, headers: Record<string, string>): HarEntry {
  e.response.headers = [...(e.response.headers ?? []), ...Object.entries(headers).map(([name, value]) => ({ name, value }))];
  return e;
}

/** The GraphQL unit of one POST: its document and variables after lifting. */
function gqlUnit(query: string): { query?: string; variables?: unknown } {
  const ex = loadHar(har([entry({ method: "POST", url: `${O}/graphql`, reqBody: { query, operationName: "Find" }, resBody: { data: { users: [] } } })]))[0]!;
  return splitUnits(ex)[0]!.gql as { query?: string; variables?: unknown };
}

describe("B1: response headers that describe the server", () => {
  for (const [header, value, path] of [
    ["x-service-name", "catalog", "/api/v1/catalog"],
    ["x-powered-by", "Express", "/api/v1/express"],
    ["x-app-name", "billing", "/api/v1/billing"],
  ] as const) {
    it(`${header}: ${value} next to ${path} (the reviewer's input and variants)`, () => {
      const r = generateFromHar(har([withResponseHeaders(entry({ url: O + path, resBody: { items: [] } }), { [header]: value })]));
      expect(r.leaks).toEqual([]);
      expect(r.files["client.ts"]).toContain(path);
    });
  }
  it("headers about a person still count: x-user, x-account-email, x-login", () => {
    for (const header of ["x-user", "x-login", "x-account-name"]) {
      const r = generateFromHar(har([withResponseHeaders(entry({ url: `${O}/api/v1/whoami`, resBody: { ok: true } }), { [header]: "okilic" }), calendar("okilic")]));
      expect(safe(r, "okilic")).toBe(true);
    }
  });
  it("a value that is data by its shape counts under any header (an email, an id)", () => {
    const r = generateFromHar(har([withResponseHeaders(entry({ url: `${O}/api/v1/ping`, resBody: { ok: true } }), { "x-trace-owner": "x", "x-debug": "okilic@corp.example" }), entry({ url: `${O}/api/v1/mail/okilic@corp.example`, resBody: { ok: true } })]));
    expect(safe(r, "okilic@corp.example")).toBe(true);
  });
  it("generated: random service words under server headers never refuse the API named after them", () => {
    const rnd = rng(16);
    for (let i = 0; i < 20; i++) {
      const w = login(rnd);
      const header = ["x-service-name", "x-powered-by", "server-name", "x-backend", "x-app"][i % 5]!;
      const r = generateFromHar(har([withResponseHeaders(entry({ url: `${O}/api/v1/${w}`, resBody: { items: [] } }), { [header]: w })]));
      expect(r.leaks).toEqual([]);
    }
  });
});

describe("A2: GraphQL variable defaults are removed in linear time", () => {
  it("20,000 defaults (the reviewer's input took 13.5 s)", SLOW, () => {
    const defs = Array.from({ length: 20_000 }, (_, i) => `$v${i}: Int = 1`).join(", ");
    const t0 = performance.now();
    const u = gqlUnit(`query Find(${defs}) { users { id } }`);
    expect(performance.now() - t0).toBeLessThan(3_000);
    expect(u.query).not.toContain("= 1");
  });
});

describe("C3: GraphQL defaults that are valid GraphQL but not JSON", () => {
  it("an object with a trailing comma keeps its value (the reviewer's input)", () => {
    const u = gqlUnit("query Find($f: Filter = {limit: 5,}) { users(filter: $f) { id } }");
    expect(u.query).toBe("query Find($f: Filter) { users(filter: $f) { id } }");
    expect(u.variables).toEqual({ f: { limit: 5 } });
  });
  it("an object with a comment", () => {
    const u = gqlUnit('query Find($f: Filter = {limit: 5 # note\n login: "okilic"}) { users(filter: $f) { id } }');
    expect(u.variables).toEqual({ f: { limit: 5, login: "okilic" } });
    expect(u.query).not.toContain("okilic");
  });
  it('a block string with an escaped \\""" (the reviewer\'s input)', () => {
    const u = gqlUnit('query Find($s: String = """a \\""" b""") { users(s: $s) { id } }');
    expect(u.query).toBe("query Find($s: String) { users(s: $s) { id } }");
    expect(u.variables).toEqual({ s: 'a """ b' });
  });
  it("lists without commas, enums inside objects, floats; top-level enums and booleans stay", () => {
    const u = gqlUnit('query Find($t: [String] = ["a" "b"], $f: F = {sort: ASC}, $x: Float = 1.5e3, $o: Order = DESC, $b: Boolean = false) { users { id } }');
    expect(u.query).toBe("query Find($t: [String], $f: F, $x: Float, $o: Order = DESC, $b: Boolean = false) { users { id } }");
    expect(u.variables).toEqual({ t: ["a", "b"], f: { sort: "ASC" }, x: 1500 });
  });
  it("a default that doesn't parse stays in the document (the guard still sees it)", () => {
    const u = gqlUnit("query Find($f: Filter = {limit: }) { users { id } }");
    expect(u.query).toContain("{limit: }");
    const r = generateFromHar(har([entry({ method: "POST", url: `${O}/graphql`, reqBody: { query: 'query Find($f: Filter = {login: "okilic" limit: }) { users { id } }' }, resBody: { data: { users: [] } } })]));
    expect(safe(r, "okilic")).toBe(true);
  });
  it("generated: random logins in nested defaults never reach the client, and the value is kept", () => {
    const rnd = rng(3);
    for (let i = 0; i < 20; i++) {
      const name = login(rnd);
      const sep = [",", " ", ", ", " # c\n"][i % 4]!;
      const u = gqlUnit(`query Find($f: F = {a: {login: "${name}"${sep}n: [1${sep}2]}${sep}}) { users(f: $f) { id } }`);
      expect(u.query).not.toContain(name);
      expect(u.variables).toEqual({ f: { a: { login: name, n: [1, 2] } } });
    }
  });
});

describe("D4: multipart field names as tokens", () => {
  const upload = (disposition: string, value: string, boundary = "X") =>
    entry({ method: "POST", url: `${O}/api/v1/upload`, reqMime: `multipart/form-data; boundary=${boundary}`, reqBody: `--${boundary}\r\nContent-Disposition: ${disposition}\r\n\r\n${value}\r\n--${boundary}--\r\n`, resBody: { ok: true } });
  it("name=username (the reviewer's input)", () => {
    expect(safe(generateFromHar(har([upload("form-data; name=username", "okilic"), calendar("okilic")])), "okilic")).toBe(true);
  });
  it('quoted with an escape, extra spaces, and a "filename" part that is a file', () => {
    expect(safe(generateFromHar(har([upload('form-data ; name = "user\\"name"', "okilic"), calendar("okilic")])), "okilic")).toBe(true);
    const file = generateFromHar(har([upload('form-data; name="avatar"; filename="a.txt"', "okilic"), calendar("okilic")]));
    expect(file.model.taint.identities.has("okilic")).toBe(false);
  });
  it("a boundary string inside a value is not a delimiter", () => {
    const r = generateFromHar(har([upload("form-data; name=username", "okilic--X-not-a-boundary"), calendar("okilic")]));
    expect(r.model.taint.values.has("okilic--x-not-a-boundary")).toBe(true);
  });
  it("generated: random logins under token and quoted names", () => {
    const rnd = rng(4);
    for (let i = 0; i < 20; i++) {
      const name = login(rnd);
      const disposition = i % 2 ? "form-data; name=login" : 'form-data; name="login"';
      expect(safe(generateFromHar(har([upload(disposition, name, "b" + i), calendar(name)])), name)).toBe(true);
    }
  });
});

describe("D5: server-sent events over several data lines", () => {
  const sse = (text: string) => entry({ url: `${O}/api/v1/events`, resMime: "text/event-stream", resText: text });
  it("the reviewer's input", () => {
    expect(safe(generateFromHar(har([sse('data: {"viewer":\ndata: {"login":"okilic"}}\n\n'), calendar("okilic")])), "okilic")).toBe(true);
  });
  it("CRLF line ends, event and id fields, and an event that ends without a blank line", () => {
    expect(safe(generateFromHar(har([sse('event: me\r\nid: 1\r\ndata: {"viewer":\r\ndata: {"login":"okilic"}}'), calendar("okilic")])), "okilic")).toBe(true);
  });
  it("generated: an event split at a random point", () => {
    const rnd = rng(5);
    for (let i = 0; i < 20; i++) {
      const name = login(rnd);
      const json = JSON.stringify({ user: { username: name } });
      const cut = 1 + Math.floor(rnd() * (json.length - 2));
      const text = `data: ${json.slice(0, cut)}\ndata: ${json.slice(cut)}\n\n`;
      // The lines are joined with a newline: a cut inside a string literal makes the JSON invalid, as it
      // would be for the browser too. Only cuts outside strings are tested.
      const inString = (json.slice(0, cut).match(/"/g)?.length ?? 0) % 2 === 1;
      if (inString) continue;
      expect(safe(generateFromHar(har([sse(text), calendar(name)])), name)).toBe(true);
    }
  });
});

describe("D6: script JSON with a < in it", () => {
  const page = (script: string) => entry({ url: `${O}/`, resMime: "text/html", resText: `<html><body><p>Hello</p>${script}</body></html>`, resourceType: "document" });
  it("the reviewer's input", () => {
    expect(safe(generateFromHar(har([page('<script type="application/json">{"hint":"a < b","viewer":{"login":"okilic"}}</script>'), calendar("okilic")])), "okilic")).toBe(true);
  });
  it("a < that looks like a tag, and window state after other code", () => {
    expect(safe(generateFromHar(har([page('<script>if (a <b) x(); window.__STATE__ = {"html":"<b>hi</b>","viewer":{"login":"okilic"}};</script>'), calendar("okilic")])), "okilic")).toBe(true);
  });
  it("text around the scripts is still read", () => {
    const r = generateFromHar(har([page('<script>var x = 1 < 2;</script><span data-email="mehmet.oz@corp.example"></span>')]));
    expect(r.model.taint.values.has("mehmet.oz@corp.example")).toBe(true);
  });
  it("generated: random logins after random < characters", () => {
    const rnd = rng(6);
    for (let i = 0; i < 20; i++) {
      const name = login(rnd);
      const junk = ["a < b", "<i>", "1<2", "<<", "</notscript>"][i % 5]!;
      const r = generateFromHar(har([page(`<script>window.s = {"note":${JSON.stringify(junk)},"me":{"login":"${name}"}}</script>`), calendar(name)]));
      expect(safe(r, name)).toBe(true);
      expect(renderChatPrompt(r.plan)).not.toContain(`/people/${name}/`);
    }
  });
});
