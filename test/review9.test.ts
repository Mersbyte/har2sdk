/**
 * Ninth review (v0.6.4): regexes that CodeQL flagged as polynomial on
 * uncontrolled data. One describe block per finding (G1–G7).
 *
 * G1 and G2 were reachable from a capture: a crafted GraphQL document made the
 * CLI, the MCP server and the mock take seconds (100 KB: 17 s and 4.8 s, four
 * times as long for every doubling). G2 was also reachable from a request to
 * the running mock (100 KB: 5.4 s, during which it answered nothing else).
 * G3, G4 and G6 are quadratic in isolation (100 KB: 4.2 s, 5.5 s and 1.1 s)
 * but no capture we built reached them slowly. G5 was flagged but was already
 * linear (100 KB: under 1 ms). All four are replaced as a precaution.
 *
 * Each block has the attack input at 200 KB with a time limit, and a generated
 * variant that compares the replacement with the original regex.
 */
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { generateFromHar } from "../src/index.js";
import { fencedBody, replacePercentRuns, trimLineEnds, trimTrailingSlashes, withoutQueryOrHash } from "../src/linear.js";
import { listenMock } from "../src/mock.js";
import { withoutComments, withoutFragments } from "../src/model.js";
import { parseAnnotations } from "../src/annotations.js";
import { ROOT, entry, har } from "./helpers.js";

const O = "https://api.acme.test";
const N = 200_000;
// A linear pass over 200 KB takes milliseconds; on the capture tests the old
// code took 65 s (G1) and 17 s (G2). The limit leaves room for slow CI machines.
const LIMIT_MS = 5_000;
const SLOW = { timeout: 60_000 };
const SEEDS = 3_000;

function timed(fn: () => unknown): number {
  const t = performance.now();
  fn();
  return performance.now() - t;
}

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

/** A string of up to `max` pieces drawn from `alphabet`. */
function generated(seed: number, alphabet: string[], max = 24): string {
  const r = rng(seed);
  let s = "";
  for (let n = Math.floor(r() * (max + 1)); n > 0; n--) s += alphabet[Math.floor(r() * alphabet.length)]!;
  return s;
}

function gqlCapture(query: string) {
  return har([entry({ method: "POST", url: O + "/graphql", reqBody: { operationName: "Q", query }, resBody: { data: { a: 1 } } })]);
}

// ── G1 ─────────────────────────────────────────────────────────────────────────

describe("G1 trailing spaces in a GraphQL document don't take quadratic time (model.ts withoutComments)", () => {
  it("a capture with 200 KB of spaces before the last character of a query", SLOW, () => {
    const capture = gqlCapture("query Q { a }\n" + " ".repeat(N) + "x");
    expect(timed(() => generateFromHar(capture))).toBeLessThan(LIMIT_MS);
  });

  it("trimLineEnds on 200 KB of spaces and tabs", () => {
    expect(timed(() => trimLineEnds(" \t".repeat(N / 2) + "x"))).toBeLessThan(LIMIT_MS);
  });

  it("generated: trimLineEnds equals s.replace(/[ \\t]+$/gm, \"\")", () => {
    const alphabet = [" ", "\t", "\n", "\r", "\r\n", "\u2028", "\u2029", "a", "\v", "\f", "\u00a0", "#"];
    for (let seed = 0; seed < SEEDS; seed++) {
      const s = generated(seed, alphabet);
      expect(trimLineEnds(s), `seed ${seed}: ${JSON.stringify(s)}`).toBe(s.replace(/[ \t]+$/gm, ""));
    }
  });

  it("generated: withoutComments is unchanged", () => {
    const before = (doc: string) =>
      doc.replace(/"""[\s\S]*?"""|"(?:[^"\\\n]|\\.)*"|#[^\n\r]*/g, (m) => (m.startsWith("#") ? "" : m)).replace(/[ \t]+$/gm, "");
    const alphabet = [" ", "\t", "\n", "\r", "#", '"', '"""', "\\", "a", "{", "}", "query Q ", "# note"];
    for (let seed = 0; seed < SEEDS; seed++) {
      const doc = generated(seed, alphabet);
      expect(withoutComments(doc), `seed ${seed}: ${JSON.stringify(doc)}`).toBe(before(doc));
    }
  });
});

// ── G2 ─────────────────────────────────────────────────────────────────────────

/** withoutFragments as it was in 0.6.4. */
function withoutFragmentsBefore(doc: string): string {
  let out = doc;
  for (let guard = 0; guard < 50; guard++) {
    const m = /(^|\})\s*fragment\s+[A-Za-z_]\w*\s+on\s+[A-Za-z_]\w*[^{]*\{/.exec(out);
    if (!m) break;
    let depth = 1;
    let i = m.index + m[0].length;
    for (; i < out.length && depth > 0; i++) {
      if (out[i] === "{") depth++;
      else if (out[i] === "}") depth--;
      else if (out[i] === '"') i = Math.max(i, out.indexOf('"', i + 1));
    }
    out = out.slice(0, m.index + m[1]!.length) + " " + out.slice(i);
  }
  return out;
}

describe("G2 a fragment definition without a selection set doesn't take quadratic time (model.ts withoutFragments)", () => {
  it("a capture with a 200 KB type condition and no `{` after it", SLOW, () => {
    const capture = gqlCapture("query Q { a }\nfragment f on T" + "c".repeat(N));
    expect(timed(() => generateFromHar(capture))).toBeLessThan(LIMIT_MS);
  });

  it("a capture with thousands of fragment heads and no `{` after them", SLOW, () => {
    const capture = gqlCapture("query Q { a }" + "} fragment a on b ".repeat(N / 18));
    expect(timed(() => generateFromHar(capture))).toBeLessThan(LIMIT_MS);
  });

  it("a 200 KB GraphQL request to the mock", SLOW, async () => {
    const r = generateFromHar(gqlCapture("query Q { a }"));
    const server = await listenMock(r.model, r.exchanges, { port: 0 });
    try {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/graphql`;
      const query = "query Q { a }\nfragment f on T" + "c".repeat(N);
      const t = performance.now();
      const res = await fetch(url, { method: "POST", body: JSON.stringify({ query }), headers: { "content-type": "application/json" } });
      await res.text();
      expect(performance.now() - t).toBeLessThan(LIMIT_MS);
    } finally {
      server.close();
    }
  });

  it("fragments are still removed", () => {
    const doc = 'fragment U on User { id name } query Q { me { ...U } } fragment P on Post { title(x: "}") }';
    expect(withoutFragments(doc)).toBe(withoutFragmentsBefore(doc));
    expect(withoutFragments(doc)).not.toContain("fragment");
  });

  it("generated: withoutFragments is unchanged", () => {
    const alphabet = ["fragment", " ", "\n", "on", "f", "T", "_x9", "{", "}", "{ a }", '"', '"}"', "query Q", "...f", "c"];
    for (let seed = 0; seed < SEEDS; seed++) {
      const doc = generated(seed, alphabet, 30);
      expect(withoutFragments(doc), `seed ${seed}: ${JSON.stringify(doc)}`).toBe(withoutFragmentsBefore(doc));
    }
  });
});

// ── G3 ─────────────────────────────────────────────────────────────────────────

describe("G3 trailing slashes are trimmed in linear time (plan.ts base URL, openapi.ts tRPC paths)", () => {
  it("200 KB of slashes before a last character", () => {
    expect(timed(() => trimTrailingSlashes("/".repeat(N) + "x"))).toBeLessThan(LIMIT_MS);
  });

  it("generated: trimTrailingSlashes equals s.replace(/\\/+$/, \"\")", () => {
    const alphabet = ["/", "//", "a", "\n", " ", "?"];
    for (let seed = 0; seed < SEEDS; seed++) {
      const s = generated(seed, alphabet);
      expect(trimTrailingSlashes(s), `seed ${seed}: ${JSON.stringify(s)}`).toBe(s.replace(/\/+$/, ""));
    }
  });
});

// ── G4 ─────────────────────────────────────────────────────────────────────────

describe("G4 percent-encoded tokens are found in linear time (leak.ts scrubText)", () => {
  const before = (text: string, fn: (t: string) => string) => text.replace(/[^\s"'<>`|()[\]{},;]*%[0-9A-Fa-f]{2}[^\s"'<>`|()[\]{},;]*/g, fn);
  const mark = (t: string) => `[${t}]`;

  it("a 200 KB token without a percent escape", () => {
    expect(timed(() => replacePercentRuns("a".repeat(N), mark))).toBeLessThan(LIMIT_MS);
  });

  it("generated: replacePercentRuns equals the original regex replace", () => {
    const alphabet = ["%", "%4", "%41", "%zz", "%C3%BC", "a", "G", " ", "\n", '"', "'", "<", "`", "|", "(", ")", "[", "]", "{", "}", ",", ";", "\u00a0"];
    for (let seed = 0; seed < SEEDS; seed++) {
      const s = generated(seed, alphabet);
      expect(replacePercentRuns(s, mark), `seed ${seed}: ${JSON.stringify(s)}`).toBe(before(s, mark));
    }
  });
});

// ── G5 ─────────────────────────────────────────────────────────────────────────

describe("G5 a relative link loses its query and fragment in linear time (redact.ts)", () => {
  // The caller only passes strings matching /^\/[^\s]*$/, so they have no line
  // terminator, and the original replace was already linear there; this pins it.
  it("200 KB of `#` and `?`", () => {
    expect(timed(() => withoutQueryOrHash("/" + "#?".repeat(N / 2)))).toBeLessThan(LIMIT_MS);
  });

  it("generated: withoutQueryOrHash equals s.replace(/[?#].*$/, \"\") on what the caller passes", () => {
    const alphabet = ["/", "a", "?", "#", "=", "&", "%20", "x"];
    for (let seed = 0; seed < SEEDS; seed++) {
      const s = "/" + generated(seed, alphabet);
      expect(/^\/[^\s]*$/.test(s)).toBe(true);
      expect(withoutQueryOrHash(s), `seed ${seed}: ${JSON.stringify(s)}`).toBe(s.replace(/[?#].*$/, ""));
    }
  });
});

// ── G6 ─────────────────────────────────────────────────────────────────────────

describe("G6 the JSON fence in a pasted chat reply is found in linear time (annotations.ts)", () => {
  const before = (text: string) => text.match(/```(?:json)?\s*([\s\S]*?)```/)?.[1];

  it("an opening fence followed by 200 KB of whitespace and no closing fence", () => {
    expect(timed(() => fencedBody("```" + " ".repeat(N)))).toBeLessThan(LIMIT_MS);
  });

  it("a reply with a fence still parses", () => {
    const reply = 'Here you go:\n```json\n{ "clientName": "Shop" }\n```\nDone.';
    expect(parseAnnotations(reply).clientName).toBe("Shop");
  });

  it("generated: fencedBody equals the original match", () => {
    const alphabet = ["```", "`", "``", "json", "jso", " ", "\n", "\t", "\u00a0", "{", "}", "a", '"x":1'];
    for (let seed = 0; seed < SEEDS; seed++) {
      const s = generated(seed, alphabet);
      expect(fencedBody(s), `seed ${seed}: ${JSON.stringify(s)}`).toBe(before(s));
    }
  });
});

// ── G7 ─────────────────────────────────────────────────────────────────────────

describe("G7 the CI workflow gives its token read-only access", () => {
  it("ci.yml sets permissions: contents: read for every job", () => {
    const ci = readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8").replace(/\r\n/g, "\n");
    expect(ci).toMatch(/^permissions:\n {2}contents: read$/m);
  });
});
