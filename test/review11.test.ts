/**
 * Eleventh review (v0.6.5, before launch). One describe block per finding.
 *
 * I1: the scrubber behind the mock and `--examples` replaced only ASCII
 * letters and digits. Everything else was copied, so a value in a non-Latin
 * script came back as recorded: a full name, city, address and a diagnosis
 * in Chinese, a first name in Cyrillic.
 * I2: the leak guard couldn't see most non-Latin names. An identity needed a
 * Latin letter, and a personal value needed four UTF-16 units, which most
 * Chinese and Korean names don't have. A name in a path segment, echoed under
 * `fullName`, went into client.ts, openapi.json, the prompt and MCP with exit 0.
 * I3: two regexes in `redactFreeText` (emails, URL query strings) rescanned a
 * run of characters from each start. Every mock text body goes through it: an
 * XML tag name of 128 KB took 26 s per request.
 *
 * The names below are the placeholder names of each language (Zhang San,
 * Hong Gildong, Taro Yamada, "so-and-so", Ivan Ivanov), not people.
 */
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { generateFromHar } from "../src/index.js";
import { collectTaint, dataLength } from "../src/leak.js";
import { replaceEmails, stripUrlQueries } from "../src/linear.js";
import { listenMock } from "../src/mock.js";
import { loadHar } from "../src/har.js";
import { redactFreeText, Scrubber } from "../src/redact.js";
import { renderChatPrompt } from "../src/summary.js";
import { entry, har } from "./helpers.js";

const O = "https://api.acme.test";
const N = 200_000;
// A linear pass over 200 KB takes milliseconds; the old code took tens of
// seconds on these inputs. The limit leaves room for slow CI machines.
const LIMIT_MS = 5_000;
const SLOW = { timeout: 60_000 };
const SEEDS = 3_000;

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

function timed(fn: () => unknown): number {
  const t = performance.now();
  fn();
  return performance.now() - t;
}

const CATEGORIES = ["Nd", "Lu", "Ll", "Lt", "Lm", "Lo", "Mn", "Mc", "Me", "Nl", "No"];
const category = (ch: string) => CATEGORIES.find((c) => new RegExp(`^\\p{${c}}$`, "u").test(ch));

/** A random code point outside ASCII, anywhere in Unicode, that matches `re`. */
function codePoint(r: () => number, re: RegExp): string {
  for (;;) {
    const cp = 0x80 + Math.floor(r() * (r() < 0.8 ? 0xff80 : 0x2ff80));
    if (cp >= 0xd800 && cp <= 0xdfff) continue;
    const ch = String.fromCodePoint(cp);
    if (re.test(ch)) return ch;
  }
}

const AUTH = { authorization: "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJlLWV4YW1wbGU" };

describe("I1: the scrubber fakes letters, marks and digits of every script", () => {
  const record = { fullName: "张三", lastName: "张", city: "某市", address: "某区某路", diagnosis: "示例", phone: "+86 000 0000 0000", email: "zhangsan@example.org" };
  const capture = har([
    entry({ url: `${O}/api/account`, reqHeaders: AUTH, resBody: record }),
    entry({ url: `${O}/api/konto`, reqHeaders: AUTH, resBody: { name: "Иван Иванов", vorname: "Иван", stadt: "Город" } }),
  ]);
  const recorded = ["张三", "张", "某市", "某区某路", "示例", "Иван", "Город"];

  it("the mock serves none of the recorded non-Latin values", async () => {
    const r = generateFromHar(capture);
    const server = await listenMock(r.model, r.exchanges, { port: 0 });
    try {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const bodies = await Promise.all(["/api/account", "/api/konto"].map(async (p) => (await fetch(base + p)).json()));
      const account = bodies[0] as Record<string, string>;
      for (const key of ["fullName", "lastName", "city", "address", "diagnosis"] as const) expect(account[key], key).not.toBe(record[key]);
      const text = JSON.stringify(bodies);
      for (const v of recorded) expect(text).not.toContain(v);
      // Same shape: as many characters as recorded, of the same kind.
      expect(account.fullName).toMatch(/^\p{Lo}{2}$/u);
      expect((bodies[1] as Record<string, string>).vorname).toMatch(/^\p{Lu}\p{Ll}{3}$/u);
    } finally {
      server.close();
    }
  });

  it("--examples doesn't write them into openapi.json", () => {
    const r = generateFromHar(capture, { examples: true });
    for (const v of recorded) expect(r.files["openapi.json"]).not.toContain(v);
  });

  it(`generated: ${SEEDS} values from any script never keep a recorded letter, mark or digit, and keep its category`, () => {
    const faked = new RegExp(`^[${CATEGORIES.map((c) => `\\p{${c}}`).join("")}]$`, "u");
    for (let seed = 1; seed <= SEEDS; seed++) {
      const r = rng(seed);
      const chars = Array.from({ length: 1 + Math.floor(r() * 12) }, () => (r() < 0.15 ? "-" : codePoint(r, faked)));
      const value = chars.join("");
      const out = [...new Scrubber({ seed }).fake(value)];
      expect(out.length, value).toBe(chars.length);
      chars.forEach((ch, i) => {
        if (ch === "-") return expect(out[i]).toBe("-");
        expect(out[i], `${seed}: ${value}`).not.toBe(ch);
        // The same category; or, for a character with none of its category within reach, ASCII of the same kind.
        const kind = (c: string) => (/^\p{N}$/u.test(c) ? "N" : /^\p{Lu}$/u.test(c) ? "Lu" : "other");
        if (out[i]!.charCodeAt(0) < 0x80) expect(kind(out[i]!), `${seed}: ${value}`).toBe(kind(ch));
        else expect(category(out[i]!), `${seed}: ${value}`).toBe(category(ch));
      });
    }
  });

  it("a decimal digit stays in its own digit set and a value never starts with a faked zero", () => {
    const s = new Scrubber({ seed: 7 });
    for (const v of ["٤٢٧", "४२७", "４２７", "𝟒𝟐𝟕"]) {
      const out = [...s.fake(v)];
      const zero = (ch: string) => ch.codePointAt(0)! - [...v][0]!.codePointAt(0)! + 4;
      expect(out.map(zero).every((d) => d >= 0 && d <= 9), v).toBe(true);
      expect(zero(out[0]!)).not.toBe(0);
    }
  });
});

describe("I2: the leak guard sees non-Latin names", () => {
  const profile = (name: string, key = "fullName") =>
    entry({ url: `${O}/api/users/${encodeURIComponent(name)}/profile`, reqHeaders: AUTH, resBody: { [key]: name, email: "user@example.org" } });

  it.each(["张三", "홍길동", "山田太郎", "فلان"])("a path segment echoed under fullName (%s) is not written", (name) => {
    const r = generateFromHar(har([profile(name)]));
    // Recorded under a personal key, so it is data: the guard refuses the files.
    expect(r.leaks.length).toBeGreaterThan(0);
    expect(renderChatPrompt(r.plan)).not.toContain(name);
  });

  it("a non-Latin login is an identity: the path segment becomes a parameter", () => {
    const r = generateFromHar(har([profile("张三", "login"), profile("李四", "login")]));
    expect(r.leaks).toEqual([]);
    for (const n of ["张三", "李四"]) {
      expect(r.files["client.ts"]).not.toContain(n);
      expect(r.files["openapi.json"]).not.toContain(n);
    }
    expect(r.model.taint.identities.has("张三")).toBe(true);
  });

  it("length counts what a letter carries: uncased letters twice, ASCII as before", () => {
    expect(dataLength("张三")).toBe(4);
    expect(dataLength("홍길동")).toBe(6);
    expect(dataLength("Ali")).toBe(3);
    // Cased alphabets are counted letter by letter, like Latin: three letters stay below the threshold.
    expect(dataLength("Лев")).toBe(3);
    const taint = collectTaint(loadHar(har([entry({ url: `${O}/api/me`, resBody: { firstName: "Ali", vorname: "Лев", fullName: "张三" } })])));
    expect(taint.values.has("张三")).toBe(true);
    expect(taint.values.has("ali")).toBe(false);
    expect(taint.values.has("лев")).toBe(false);
  });

  it(`generated: ${SEEDS / 10} names of two or three uncased letters from anywhere in Unicode, under personal or identity keys`, SLOW, () => {
    const keys = ["fullName", "displayName", "login", "username", "owner", "adSoyad", "nombre_completo"];
    for (let seed = 1; seed <= SEEDS / 10; seed++) {
      const r = rng(seed);
      const name = Array.from({ length: 2 + Math.floor(r() * 2) }, () => codePoint(r, /^\p{Lo}$/u)).join("");
      const key = keys[Math.floor(r() * keys.length)]!;
      const res = generateFromHar(har([profile(name, key), entry({ url: `${O}/api/orders`, reqHeaders: AUTH, resBody: [{ id: 1, status: "open" }] })]));
      const written = res.leaks.length === 0;
      const files = res.files["client.ts"]! + res.files["openapi.json"]!;
      // Either the files are refused, or the name isn't in them; the prompt never shows it.
      expect(written && files.includes(name), `${seed}: ${key}`).toBe(false);
      expect(renderChatPrompt(res.plan).includes(name), `${seed}: ${key}`).toBe(false);
    }
  });
});

describe("I3: redactFreeText is linear", () => {
  const OLD_EMAIL = /[^\s@"'<>,;]+@[^\s@"'<>,;]+\.[A-Za-z]{2,}/g;
  const OLD_URL = /(https?:\/\/[^\s?#"'<>]+)[?#][^\s"'<>]*/gi;

  it.each([
    ["a run with no @", "a".repeat(N)],
    ["a run, @, a run with no dot", "a".repeat(N / 2) + "@" + "a".repeat(N / 2)],
    ["a domain of dots without letters after them", "a@" + "a.1".repeat(N / 3)],
    ["http:// over and over without a query", "http://a".repeat(N / 8)],
  ])("%s (200 KB)", (_, input) => {
    expect(timed(() => redactFreeText(input))).toBeLessThan(LIMIT_MS);
  });

  it("a mock text body: an XML tag name of 200 KB", SLOW, async () => {
    const r = generateFromHar(har([entry({ url: `${O}/api/feed`, resMime: "application/xml", resText: "<" + "a".repeat(N) + ">1</x>" })]));
    const server = await listenMock(r.model, r.exchanges, { port: 0 });
    try {
      const t = performance.now();
      await (await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/feed`)).text();
      expect(performance.now() - t).toBeLessThan(LIMIT_MS);
    } finally {
      server.close();
    }
  });

  it(`generated: ${SEEDS} inputs give what the old regexes gave`, () => {
    const pieces = ["a", "Z", "1", ".", "@", " ", '"', "'", "<", ">", ",", ";", "?", "#", "/", ":", "-", " ", "\n", "é", "张", "\ud83d", "co", "http://", "HTTPS://", "x@y.io"];
    for (let seed = 1; seed <= SEEDS; seed++) {
      const r = rng(seed);
      const text = Array.from({ length: 1 + Math.floor(r() * 60) }, () => pieces[Math.floor(r() * pieces.length)]).join("");
      expect(replaceEmails(text, "user@example.com"), JSON.stringify(text)).toBe(text.replace(OLD_EMAIL, "user@example.com"));
      expect(stripUrlQueries(text), JSON.stringify(text)).toBe(text.replace(OLD_URL, "$1"));
    }
  });
});
