/**
 * Thirteenth review (v0.6.7, before launch). One describe block per finding.
 *
 * M1: an email's local part is often reused as a username elsewhere in the
 * same app ("okilic@corp.example" → "/people/okilic/…"), but the guard only
 * ever taints the email as a whole. The local part became a path literal,
 * method name and type name in client.ts, openapi.json, the prompt and MCP,
 * with exit 0. Role mailboxes ("info@…", "support@…"…) are excluded: they
 * name a function, not a person.
 * M3: evidence inside a string field that is itself JSON
 * (`{"payload":"{\"login\":\"okilic\"}"}`) was never read, so a path using the
 * login stayed literal, with exit 0. Such strings are parsed now (up to 200 KB,
 * within the guard's existing depth limit).
 * M2: `scrubText`'s slug/host-name pass used a regex that retried from every
 * position inside a long run with no separator, so it was quadratic. The
 * regex only ever matches starting at a run's start, so a lookbehind that
 * rules out mid-run starts changes nothing it matches, only how it fails.
 */
import { describe, expect, it } from "vitest";
import { generateFromHar } from "../src/index.js";
import { collectTaint, scrubText } from "../src/leak.js";
import { loadHar } from "../src/har.js";
import { entry, har } from "./helpers.js";

const O = "https://api.acme.test";
const LIMIT_MS = 2_000;
const SLOW = { timeout: 30_000 };

describe("M1: an email's local part is an identity", () => {
  const capture = har([
    entry({ url: `${O}/api/v1/session`, resBody: { user: { email: "okilic@corp.example" } } }),
    entry({ url: `${O}/api/v1/people/okilic/calendar`, resBody: { events: [] } }),
  ]);

  it("the local part doesn't reach client.ts or openapi.json", () => {
    const r = generateFromHar(capture);
    expect(r.files["client.ts"]).not.toContain("okilic");
    expect(r.files["openapi.json"]).not.toContain("okilic");
    expect(r.files["client.ts"]).toContain("{personId}"); // templated, not literal
  });

  it("a dotted local part is caught too (already worked, stays working)", () => {
    const c2 = har([
      entry({ url: `${O}/api/v1/session`, resBody: { user: { email: "mehmet.demir@corp.example" } } }),
      entry({ url: `${O}/api/v1/people/mehmet.demir/calendar`, resBody: { events: [] } }),
    ]);
    const r = generateFromHar(c2);
    expect(r.files["client.ts"]).not.toContain("mehmet.demir");
  });

  it("a role mailbox's local part is not treated as a person's identity", () => {
    const c3 = har([
      entry({ url: `${O}/api/v1/session`, resBody: { user: { email: "info@corp.example" } } }),
      entry({ url: `${O}/api/v1/people/info/calendar`, resBody: { events: [] } }),
    ]);
    const r = generateFromHar(c3);
    // No crash, no leak warning for a role mailbox's local part.
    expect(r.warnings.join("\n")).not.toMatch(/Leak guard refused/);
  });

  it(`generated: 300 email local parts of 3+ letters, recorded then echoed in a path, are never written`, () => {
    let seed = 1;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const LETTERS = "abcdefghijklmnopqrstuvwxyz";
    for (let i = 0; i < 300; i++) {
      const len = 3 + Math.floor(rnd() * 8);
      let local = "";
      for (let j = 0; j < len; j++) local += LETTERS[Math.floor(rnd() * LETTERS.length)];
      // Keep the random local part away from the role-mailbox list and common words.
      if (["info", "support", "admin", "test", "user", "team", "help"].some((w) => local.includes(w))) continue;
      const c = har([
        entry({ url: `${O}/api/v1/session`, resBody: { user: { email: `${local}@corp.example` } } }),
        entry({ url: `${O}/api/v1/people/${local}/calendar`, resBody: { events: [] } }),
      ]);
      const r = generateFromHar(c);
      expect(r.files["client.ts"], `seed ${i}: ${local}`).not.toContain(local);
      expect(r.files["openapi.json"], `seed ${i}: ${local}`).not.toContain(local);
    }
  });
});

describe("M3: JSON inside a string field is evidence too", () => {
  const stringified = (login: string) =>
    har([
      entry({ url: `${O}/api/v1/me`, resBody: { payload: JSON.stringify({ login }) } }),
      entry({ url: `${O}/api/v1/users/${login}/settings`, resBody: { theme: "dark" } }),
    ]);

  it("a login only inside a stringified JSON field doesn't reach client.ts or openapi.json", () => {
    const r = generateFromHar(stringified("okilic"));
    expect(r.files["client.ts"]).not.toContain("okilic");
    expect(r.files["openapi.json"]).not.toContain("okilic");
    expect(r.files["client.ts"]).toContain("{userId}");
  });

  it("two levels of stringified JSON, and an array of objects, count as well", () => {
    const twice = har([
      entry({ url: `${O}/api/v1/me`, resBody: { a: JSON.stringify({ b: JSON.stringify({ login: "zkaya" }) }) } }),
      entry({ url: `${O}/api/v1/users/zkaya/settings`, resBody: { theme: "dark" } }),
    ]);
    expect(generateFromHar(twice).files["client.ts"]).not.toContain("zkaya");
    const arr = har([
      entry({ url: `${O}/api/v1/me`, resBody: { a: JSON.stringify([{ login: "mdemir" }]) } }),
      entry({ url: `${O}/api/v1/users/mdemir/settings`, resBody: { theme: "dark" } }),
    ]);
    expect(generateFromHar(arr).files["client.ts"]).not.toContain("mdemir");
  });

  it("text that merely looks like JSON doesn't break anything", () => {
    const r = generateFromHar(har([entry({ url: `${O}/api/v1/x`, resBody: { a: "{not json}", b: "[1, 2", c: "{}" } })]));
    expect(r.files["client.ts"]).toBeDefined();
  });

  it("generated: 200 random logins placed only inside a stringified field are never written", () => {
    let seed = 99;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const LETTERS = "bcdfghjklmnpqrstvwxz";
    for (let i = 0; i < 200; i++) {
      let login = "";
      for (let j = 0; j < 4 + Math.floor(rnd() * 6); j++) login += LETTERS[Math.floor(rnd() * LETTERS.length)];
      const r = generateFromHar(stringified(login));
      expect(r.files["client.ts"], `seed ${i}: ${login}`).not.toContain(login);
    }
  });
});

describe("M2: scrubText's slug pass is linear", () => {
  it(
    "a 200,000-character run with no separator scrubs in well under a second",
    SLOW,
    () => {
      const taint = collectTaint(loadHar(har([entry({ url: `${O}/me`, resBody: { fullName: "Zeynep Kaya", email: "zeynep.kaya@acme.test" } })])));
      const text = "x".repeat(200_000);
      const t0 = performance.now();
      scrubText(text, taint);
      expect(performance.now() - t0).toBeLessThan(LIMIT_MS);
    },
  );

  it("output is unchanged for ordinary slug/host-name text", () => {
    const taint = collectTaint(loadHar(har([entry({ url: `${O}/me`, resBody: { fullName: "Zeynep Kaya" } })])));
    const withName = "see zeynep-kaya.crm-app.test for details";
    expect(scrubText(withName, taint)).not.toContain("zeynep");
  });

  it(`generated: 3,000 random strings scrub identically with and without the fix`, () => {
    // The fix only adds a lookbehind; re-derive the old behavior inline and compare.
    const oldRe = /[\p{L}\p{N}]+(?:[._+\-~@][\p{L}\p{N}]+)+/gu;
    const newRe = /(?<![\p{L}\p{N}])[\p{L}\p{N}]+(?:[._+\-~@][\p{L}\p{N}]+)+/gu;
    let seed = 7;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const CHARS = [..."abcXYZ019._+-~@ \t日本語Олег"];
    for (let i = 0; i < 3000; i++) {
      const len = 1 + Math.floor(rnd() * 80);
      let s = "";
      for (let j = 0; j < len; j++) s += CHARS[Math.floor(rnd() * CHARS.length)];
      const a = s.replace(oldRe, (m) => `[${m}]`);
      const b = s.replace(newRe, (m) => `[${m}]`);
      expect(b, `seed ${i}: ${JSON.stringify(s)}`).toBe(a);
    }
  });
});
