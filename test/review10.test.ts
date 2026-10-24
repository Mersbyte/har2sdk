/**
 * Tenth review (v0.6.4): the nine regexes CodeQL still flagged as polynomial
 * after the ninth. One describe block per alert (H1–H9).
 *
 * H1–H5 match GraphQL strings with `"(?:[^"\\]|\\.)*"`. On a string that
 * doesn't close, made of escaped quotes (`"\"\"\"…`), the regex started again
 * at every escaped quote and scanned to the end each time (50 KB: about 4 s).
 * H6–H9 trim `.`, `-` and `~` with `/^[.\-~]+|[.\-~]+$/g`, which rescans a run
 * of them in the middle of a token from each of its characters (50 KB: 1.5 s).
 * Recorded values are at most 4,000 characters, so H7–H9 need many of them.
 *
 * H10–H12 are the same patterns where CodeQL didn't flag them: in
 * normalizeGraphQL and liftGraphQLLiterals (model.ts). The literal regex there
 * was also exponential on a list that doesn't close (`x: [1  1  1 …`: 58
 * bytes took 8 s, each item doubling it), reachable from any GraphQL request.
 *
 * Each block has the attack input with a time limit, and a generated variant
 * that compares the replacement with the original regex. H1–H3 time the
 * function; H10 times a whole capture with their input.
 */
import { describe, expect, it } from "vitest";
import { loadHar } from "../src/har.js";
import { collectTaint, scanText, scrubText, type Taint } from "../src/leak.js";
import { generateFromHar } from "../src/index.js";
import {
  graphqlListItems,
  graphqlLiftMatches,
  graphqlLiteralMatches,
  graphqlTokens,
  isSpaceCode,
  quotedStrings,
  removeHashComments,
  replaceQuoted,
  trimDotsDashesTildes,
  trimLineEnds,
} from "../src/linear.js";
import { graphqlRootFields, normalizeGraphQL, withoutComments } from "../src/model.js";
import { entry, har } from "./helpers.js";

const O = "https://api.acme.test";
const N = 200_000;
// A linear pass over 200 KB takes milliseconds; the old code took minutes on
// these inputs. The limit leaves room for slow CI machines.
const LIMIT_MS = 5_000;
const SLOW = { timeout: 60_000 };
const SEEDS = 3_000;

/** A string that opens with `"` and never closes: `"\"\"\"…`, `n` characters. */
const ESCAPED = '"' + '\\"'.repeat(N / 2);

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

/** The pieces GraphQL strings are made of, with every line terminator and escape. */
const STRING_PIECES = ['"', '"', "\\", '\\"', "\\\\", "\\n", "\n", "\r", "\r\n", " ", " ", " ", "a", "#", '"""'];

/** A match as a plain list, so two can be compared with toEqual. */
const plain = (m: { index?: number } & ArrayLike<string | undefined>) => [m.index, ...Array.from(m)];

// ── H1 ─────────────────────────────────────────────────────────────────────────

const ROOT_TOKEN = /([{}()])|(\.\.\.\s*[A-Za-z_]\w*)|([A-Za-z_]\w*)(\s*:\s*([A-Za-z_]\w*))?|"(?:[^"\\]|\\.)*"/g;

/** graphqlRootFields as it was in 0.6.4. */
function graphqlRootFieldsBefore(doc: string): string[] {
  const start = doc.indexOf("{");
  if (start < 0) return [];
  const fields: string[] = [];
  let depth = 0;
  let parens = 0;
  const re = new RegExp(ROOT_TOKEN);
  re.lastIndex = start;
  let m: RegExpExecArray | null;
  while ((m = re.exec(doc))) {
    if (m[1] === "{") depth++;
    else if (m[1] === "}") {
      if (--depth === 0) break;
    } else if (m[1] === "(") parens++;
    else if (m[1] === ")") parens--;
    else if (m[3] && depth === 1 && parens === 0) fields.push(m[5] ?? m[3]);
  }
  return [...new Set(fields)];
}

describe("H1 the root fields of an anonymous operation are found in linear time (model.ts graphqlRootFields)", () => {
  it("graphqlRootFields on 200 KB of escaped quotes", () => {
    expect(timed(() => graphqlRootFields("{ a " + ESCAPED))).toBeLessThan(LIMIT_MS);
  });

  it("generated: graphqlTokens yields the original regex's matches", () => {
    const alphabet = [...STRING_PIECES, "{", "}", "(", ")", "...", "... ", "..", ".", ":", " : ", "_b9", "c", "9", "\t"];
    for (let seed = 0; seed < SEEDS; seed++) {
      const doc = generated(seed, alphabet, 30);
      const start = Math.floor(rng(seed + 1)() * (doc.length + 1));
      const re = new RegExp(ROOT_TOKEN);
      re.lastIndex = start;
      const before = [];
      for (let m; (m = re.exec(doc)); ) before.push(plain(m));
      expect([...graphqlTokens(doc, start)].map(plain), `seed ${seed}: ${JSON.stringify(doc)} from ${start}`).toEqual(before);
    }
  });

  it("generated: graphqlRootFields is unchanged", () => {
    const alphabet = [...STRING_PIECES, "{", "{", "}", "}", "(", ")", "...f", "a", "b: c", " ", "d"];
    for (let seed = 0; seed < SEEDS; seed++) {
      const doc = generated(seed, alphabet, 30);
      expect(graphqlRootFields(doc), `seed ${seed}: ${JSON.stringify(doc)}`).toEqual(graphqlRootFieldsBefore(doc));
    }
  });
});

// ── H2 ─────────────────────────────────────────────────────────────────────────

const COMMENTS = /"""[\s\S]*?"""|"(?:[^"\\\n]|\\.)*"|#[^\n\r]*/g;

describe("H2 comments are removed from a GraphQL document in linear time (model.ts withoutComments)", () => {
  it("withoutComments on 200 KB of escaped quotes", () => {
    expect(timed(() => withoutComments(ESCAPED))).toBeLessThan(LIMIT_MS);
  });

  it("generated: removeHashComments equals the original regex replace", () => {
    const alphabet = [...STRING_PIECES, '"""', '""', "#", "# c", "{", "}", "query Q "];
    for (let seed = 0; seed < SEEDS; seed++) {
      const doc = generated(seed, alphabet, 30);
      expect(removeHashComments(doc), `seed ${seed}: ${JSON.stringify(doc)}`).toBe(doc.replace(COMMENTS, (m) => (m.startsWith("#") ? "" : m)));
    }
  });

  it("generated: withoutComments is unchanged", () => {
    const alphabet = [...STRING_PIECES, '"""', "#", "\t", " ", "{ a }"];
    for (let seed = 0; seed < SEEDS; seed++) {
      const doc = generated(seed, alphabet, 30);
      expect(withoutComments(doc), `seed ${seed}: ${JSON.stringify(doc)}`).toBe(trimLineEnds(doc.replace(COMMENTS, (m) => (m.startsWith("#") ? "" : m))));
    }
  });
});

// ── H3 ─────────────────────────────────────────────────────────────────────────

const QUOTED = /"(?:[^"\\\n]|\\.)*"/g;

describe("H3 data-like strings are redacted in linear time when variables can't be lifted (model.ts liftGraphQLLiterals)", () => {
  it("replaceQuoted on 200 KB of escaped quotes", () => {
    expect(timed(() => replaceQuoted(ESCAPED, (s) => s))).toBeLessThan(LIMIT_MS);
  });

  it("generated: replaceQuoted equals the original regex replace", () => {
    const mark = (s: string) => `[${s}]`;
    for (let seed = 0; seed < SEEDS; seed++) {
      const s = generated(seed, STRING_PIECES, 30);
      expect(replaceQuoted(s, mark), `seed ${seed}: ${JSON.stringify(s)}`).toBe(s.replace(QUOTED, mark));
    }
  });
});

// ── H4 ─────────────────────────────────────────────────────────────────────────

const LITERALS = /#[^\n]*|(?:\b([A-Za-z_]\w*)\s*:\s*)?(?:"""([\s\S]*?)"""|"((?:[^"\\\n]|\\.)*)"|(?<![\w$.])(-?\d{6,})(?![\w.]))/g;

describe("H4 literals in a GraphQL document are collected in linear time (leak.ts graphqlLiterals)", () => {
  it("a capture with `id: ` and a 200 KB string of escaped quotes that doesn't close", SLOW, () => {
    const exchanges = loadHar(gqlCapture("query Q { a(id: " + ESCAPED + ") }"));
    expect(timed(() => collectTaint(exchanges))).toBeLessThan(LIMIT_MS);
  });

  it("graphqlLiteralMatches on 200 KB of escaped quotes", () => {
    expect(timed(() => [...graphqlLiteralMatches("a: " + ESCAPED)])).toBeLessThan(LIMIT_MS);
  });

  it("generated: graphqlLiteralMatches yields the original regex's matches", () => {
    const alphabet = [...STRING_PIECES, '"""', "id", "id:", "id: ", " :", "x_9", "$v", ".", "-", "123456", "1234567", "12", "\t", "(", ")"];
    for (let seed = 0; seed < SEEDS; seed++) {
      const doc = generated(seed, alphabet, 30);
      expect([...graphqlLiteralMatches(doc)].map(plain), `seed ${seed}: ${JSON.stringify(doc)}`).toEqual([...doc.matchAll(LITERALS)].map(plain));
    }
  });
});

// ── H5 ─────────────────────────────────────────────────────────────────────────

describe("H5 strings in a GraphQL comment are collected in linear time (leak.ts graphqlLiterals)", () => {
  it("a capture with a comment holding a 200 KB string of escaped quotes that doesn't close", SLOW, () => {
    const exchanges = loadHar(gqlCapture("query Q { a }\n# " + ESCAPED));
    expect(timed(() => collectTaint(exchanges))).toBeLessThan(LIMIT_MS);
  });

  it("quotedStrings on 200 KB of escaped quotes", () => {
    expect(timed(() => [...quotedStrings(ESCAPED)])).toBeLessThan(LIMIT_MS);
  });

  it("generated: quotedStrings finds the original regex's strings in a comment", () => {
    // A comment is `#[^\n]*`, so it has no \n, but may have every other line terminator.
    const alphabet = STRING_PIECES.filter((p) => !p.includes("\n"));
    for (let seed = 0; seed < SEEDS; seed++) {
      const comment = "#" + generated(seed, alphabet, 30);
      const after = [...quotedStrings(comment)].map(([start, end]) => [start, comment.slice(start + 1, end - 1)]);
      const before = [...comment.matchAll(/"((?:[^"\\\n]|\\.)*)"/g)].map((q) => [q.index, q[1]]);
      expect(after, `seed ${seed}: ${JSON.stringify(comment)}`).toEqual(before);
    }
  });

  it("generated: quotedStrings equals the original regex with and without newlines", () => {
    for (let seed = 0; seed < SEEDS; seed++) {
      const s = generated(seed, STRING_PIECES, 30);
      expect([...quotedStrings(s)], `seed ${seed}: ${JSON.stringify(s)}`).toEqual([...s.matchAll(QUOTED)].map((q) => [q.index, q.index + q[0].length]));
      expect([...quotedStrings(s, true)], `seed ${seed}: ${JSON.stringify(s)}`).toEqual([...s.matchAll(/"(?:[^"\\]|\\.)*"/g)].map((q) => [q.index, q.index + q[0].length]));
    }
  });
});

// ── H6–H9 ──────────────────────────────────────────────────────────────────────

const TRIM = /^[.\-~]+|[.\-~]+$/g;

function trimIsUnchanged(): void {
  const alphabet = [".", "-", "~", "..", "-~.", "a", "B", "9", "_", "+", "@", "%", " ", "\n", "ü"];
  for (let seed = 0; seed < SEEDS; seed++) {
    const s = generated(seed, alphabet);
    expect(trimDotsDashesTildes(s), `seed ${seed}: ${JSON.stringify(s)}`).toBe(s.replace(TRIM, ""));
  }
}

/** Taint holding `count` recorded values made by `value(i)`, each under 4,000 characters. */
function manyValues(count: number, value: (i: number) => string): Taint {
  const args = Array.from({ length: count }, (_, i) => `a${i}: "${value(i)}"`).join(" ");
  const taint = collectTaint(loadHar(gqlCapture(`query Q { f(${args}) { a } }`)));
  expect(taint.values.size).toBeGreaterThanOrEqual(count);
  return taint;
}

const DOTS = ".".repeat(3_990);

describe("H6 tokens of a scanned text are trimmed in linear time (leak.ts index)", () => {
  it("scanText and scrubText on a 200 KB run of dots inside a token", () => {
    const taint = collectTaint(loadHar(har([entry({ url: O + "/api/me", resBody: { username: "mdemir" } })])));
    const text = "a" + ".-~".repeat(N / 3) + "a";
    expect(timed(() => scanText(text, taint, "x"))).toBeLessThan(LIMIT_MS);
    expect(timed(() => scrubText(text, taint))).toBeLessThan(LIMIT_MS);
  });

  it("generated: trimDotsDashesTildes equals the original regex replace", trimIsUnchanged);
});

describe("H7 a one-token recorded value is trimmed in linear time (leak.ts scanText)", () => {
  it("scanText with 1,000 recorded values that each hold a run of dots", SLOW, () => {
    const taint = manyValues(1_000, (i) => `x${i}${DOTS}y`);
    expect(timed(() => scanText("hello", taint, "x"))).toBeLessThan(LIMIT_MS);
  });

  it("generated: trimDotsDashesTildes equals the original regex replace", trimIsUnchanged);
});

describe("H8 a recorded value of several tokens is trimmed in linear time (leak.ts scanText)", () => {
  it("scanText with 1,000 recorded values of two tokens, the first holding a run of dots", SLOW, () => {
    const taint = manyValues(1_000, (i) => `x${i}${DOTS}y z`);
    expect(timed(() => scanText("hello", taint, "x"))).toBeLessThan(LIMIT_MS);
  });

  it("generated: trimDotsDashesTildes equals the original regex replace", trimIsUnchanged);
});

describe("H9 recorded values are trimmed in linear time when text is scrubbed (leak.ts scrubText)", () => {
  it("scrubText with 1,000 recorded values that each hold a run of dots", SLOW, () => {
    const taint = manyValues(1_000, (i) => `x${i}${DOTS}y`);
    expect(timed(() => scrubText("hello", taint))).toBeLessThan(LIMIT_MS);
  });

  it("generated: trimDotsDashesTildes equals the original regex replace", trimIsUnchanged);
});

// ── H10 ────────────────────────────────────────────────────────────────────────

/** normalizeGraphQL as it was in 0.6.4. */
function normalizeGraphQLBefore(doc: string): string {
  return doc
    .replace(/#[^\n]*/g, "")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/(?<![A-Za-z_$])-?\d+(\.\d+)?/g, "0")
    .replace(/\s+/g, " ")
    .replace(/\s*([{}():,!$=@\[\]])\s*/g, "$1")
    .trim();
}

describe("H10 strings are folded in linear time when two GraphQL documents are compared (model.ts normalizeGraphQL)", () => {
  it("a capture with a 200 KB string of escaped quotes that doesn't close", SLOW, () => {
    expect(timed(() => generateFromHar(gqlCapture("query Q { a(x: " + ESCAPED + ") }")))).toBeLessThan(LIMIT_MS);
  });

  it("normalizeGraphQL on 200 KB of escaped quotes", () => {
    expect(timed(() => normalizeGraphQL(ESCAPED))).toBeLessThan(LIMIT_MS);
  });

  it('generated: replaceQuoted(s, fn, true) equals s.replace(/"(?:[^"\\\\]|\\\\.)*"/g, fn)', () => {
    for (let seed = 0; seed < SEEDS; seed++) {
      const s = generated(seed, STRING_PIECES, 30);
      expect(replaceQuoted(s, () => '""', true), `seed ${seed}: ${JSON.stringify(s)}`).toBe(s.replace(/"(?:[^"\\]|\\.)*"/g, '""'));
    }
  });

  it("generated: normalizeGraphQL is unchanged", () => {
    const alphabet = [...STRING_PIECES, "{", "}", "(", ")", ":", "a", "-1", "2.5", "$v", "\t", "  "];
    for (let seed = 0; seed < SEEDS; seed++) {
      const doc = generated(seed, alphabet, 30);
      expect(normalizeGraphQL(doc), `seed ${seed}: ${JSON.stringify(doc)}`).toBe(normalizeGraphQLBefore(doc));
    }
  });
});

// ── H11 ────────────────────────────────────────────────────────────────────────

const LIFT_STRING = String.raw`"""[\s\S]*?"""|"(?:[^"\\\n]|\\.)*"(?!")`;
const LIFT_NUMBER = String.raw`-?\d+(?![\w.])`;
/** GQL_LIFT as it was in 0.6.4. */
const LIFT = new RegExp(
  String.raw`#[^\n]*|"""[\s\S]*?"""|"(?:[^"\\\n]|\\.)*"|\b([A-Za-z_][A-Za-z0-9_]*)(\s*:\s*)(${LIFT_STRING}|${LIFT_NUMBER}|\[\s*(?:(?:${LIFT_STRING}|${LIFT_NUMBER})\s*,?\s*)+\])`,
  "g",
);

describe("H11 literals to lift are found in linear time (model.ts liftGraphQLLiterals)", () => {
  it("a capture with a list argument of 200 KB that doesn't close", SLOW, () => {
    // The old regex took 29 s on a whole capture with 19 of these items (60 bytes).
    expect(timed(() => generateFromHar(gqlCapture("query Q { a(ids: [" + "1  ".repeat(N / 3) + ") }")))).toBeLessThan(LIMIT_MS);
  });

  it("a list of block strings where each `\"\"\"` could end the one before", SLOW, () => {
    const doc = 'a(x: ["""' + ' """ x'.repeat(N / 6) + "]";
    expect(timed(() => [...graphqlLiftMatches(doc)])).toBeLessThan(LIMIT_MS);
  });

  it("a list that does close is still lifted", () => {
    const r = generateFromHar(gqlCapture('query Q { users(ids: ["u_8f3k2", "u_9d1x0"], first: 20) { id } }'));
    const query = JSON.stringify(r.model);
    expect(query).not.toContain("u_8f3k2");
    expect(query).toContain("first: 20");
  });

  it("isSpaceCode matches \\s on every UTF-16 code unit", () => {
    for (let c = 0; c < 0x10000; c++) if (isSpaceCode(c) !== /\s/.test(String.fromCharCode(c))) expect.fail(`U+${c.toString(16)}`);
  });

  it("generated: graphqlLiftMatches yields the original regex's matches", () => {
    const alphabet = [...STRING_PIECES, "ids", "x", "_9", " : ", ": ", "[", "[", "]", "]", ",", ", ", " ", "1", "123456", "-", "-7", ".", "a", '"a"', '"""b"""', "\t"];
    for (let seed = 0; seed < SEEDS; seed++) {
      // Short, because the original regex is exponential on lists.
      const doc = generated(seed, alphabet, 20);
      expect([...graphqlLiftMatches(doc)].map(plain), `seed ${seed}: ${JSON.stringify(doc)}`).toEqual([...doc.matchAll(LIFT)].map(plain));
    }
  });

  it("generated: graphqlLiftMatches yields the original regex's matches on list arguments", () => {
    const alphabet = ['"""', '"""', '"', "\\", '\\"', "\n", " ", "  ", ",", ", ", "]", "1", "-2", "1a", "1.", '"a"', '"""b"""', "x"];
    for (let seed = 0; seed < SEEDS; seed++) {
      const doc = "ids: [" + generated(seed, alphabet, 16) + (seed % 2 ? "]" : "");
      expect([...graphqlLiftMatches(doc)].map(plain), `seed ${seed}: ${JSON.stringify(doc)}`).toEqual([...doc.matchAll(LIFT)].map(plain));
    }
  });
});

// ── H12 ────────────────────────────────────────────────────────────────────────

describe("H12 the items of a list literal are found in linear time (model.ts liftGraphQLLiterals)", () => {
  it("a 200 KB run of digits followed by a letter", () => {
    expect(timed(() => [...graphqlListItems("1".repeat(N) + "a")])).toBeLessThan(LIMIT_MS);
  });

  it("200 KB of escaped quotes", () => {
    expect(timed(() => [...graphqlListItems(ESCAPED)])).toBeLessThan(LIMIT_MS);
  });

  it("generated: graphqlListItems equals the original regex's matches", () => {
    const items = new RegExp(`${LIFT_STRING}|${LIFT_NUMBER}`, "g");
    const alphabet = [...STRING_PIECES, "[", "]", ",", " ", "1", "123", "-", "-4", "1a", "1.", "x", "_"];
    for (let seed = 0; seed < SEEDS; seed++) {
      const s = generated(seed, alphabet, 30);
      expect([...graphqlListItems(s)], `seed ${seed}: ${JSON.stringify(s)}`).toEqual([...s.matchAll(items)].map((m) => [m.index, m.index + m[0].length]));
    }
  });
});
