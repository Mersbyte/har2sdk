/**
 * The literal path words of a plan: every path segment written into `client.ts`
 * as text (`/api/v1/profiles/parker` → `"profiles"`, `"parker"`), with how many
 * distinct recorded paths use it.
 *
 * The leak guard can't recognise a value that has no evidence in the capture (a
 * username used once as a path segment). Only the user knows whether `parker` is
 * a name, so the CLI, `inspect` and the MCP server list these words for them to
 * check, the ones seen in a single recorded path first. This is advice, not a
 * check: it changes nothing in what is generated.
 */
import type { Exchange } from "./har.js";
import type { Plan } from "./plan.js";
import { splitPath, tokenText } from "./template.js";

export interface PathWord {
  /** The segment as written into the client (first spelling seen). */
  word: string;
  /** Distinct recorded request paths (origin + path, before templating) that contain it as a segment. */
  requests: number;
}

/** The API root (`/api`, `/rest`, `/graphql`): structure, not a word of the app's. */
const ROOT = /^(api|apis|rest|graphql|gql)$/i;
/** Version segments: `v1`, `v2.1`, dated versions (`2024-01`). */
const VERSION = /^(v\d+(\.\d+)*|\d{4}-\d{2}(-\d{2})?)$/i;
/** A bare number right after the root (`/rest/api/2/…`) is a version too. */
const NUMBER = /^\d+(\.\d+)*$/;

function isStructure(word: string, prev: string | undefined): boolean {
  return ROOT.test(word) || VERSION.test(word) || (NUMBER.test(word) && prev !== undefined && ROOT.test(prev));
}

/**
 * Every literal path word of the plan's endpoints, deduplicated without regard
 * to case, with its evidence count. Single-use words (seen in one recorded path)
 * come first, then the rest; each group alphabetical.
 */
export function literalPathWords(plan: Plan, exchanges: Exchange[]): PathWord[] {
  const words = new Map<string, string>();
  for (const op of plan.ops) {
    const tokens = op.ep.tokens;
    tokens.forEach((t, i) => {
      if (t.kind !== "literal" || !t.value) return;
      const prev = tokens[i - 1];
      if (isStructure(t.value, prev?.kind === "literal" ? prev.value : undefined)) return;
      const key = t.value.toLowerCase();
      if (!words.has(key)) words.set(key, t.value);
    });
  }
  // Evidence: in how many distinct recorded paths (of the requests behind the endpoints) each word is a segment.
  const byIndex = new Map(exchanges.map((ex) => [ex.index, ex]));
  const paths = new Set<string>();
  for (const op of plan.ops) {
    for (const i of op.ep.samples) {
      const ex = byIndex.get(i);
      if (ex) paths.add(ex.origin + "\u0000" + ex.pathname);
    }
  }
  const counts = new Map<string, number>();
  for (const p of paths) {
    const segs = new Set(splitPath(p.slice(p.indexOf("\u0000") + 1)).map((s) => s.toLowerCase()));
    for (const s of segs) if (words.has(s)) counts.set(s, (counts.get(s) ?? 0) + 1);
  }
  const out = [...words].map(([key, word]) => ({ key, word, requests: counts.get(key) ?? 0 }));
  out.sort((a, b) => Number(a.requests > 1) - Number(b.requests > 1) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return out.map(({ word, requests }) => ({ word, requests }));
}

export const isSingleUse = (w: PathWord): boolean => w.requests <= 1;

/**
 * A `--param` pattern that turns this word into a parameter: the path of an
 * endpoint that has it, with the word (and every parameter) as `*`. Anchored
 * (it starts with "/"), so it matches paths of that length only.
 */
export function paramPatternFor(plan: Plan, word: string): string | undefined {
  return patterns(plan, word)[0]?.pattern;
}

function patterns(plan: Plan, word: string): { pattern: string; member: boolean }[] {
  const key = word.toLowerCase();
  const out: { pattern: string; member: boolean }[] = [];
  for (const op of plan.ops) {
    const tokens = op.ep.tokens;
    const i = tokens.findIndex((t) => t.kind === "literal" && t.value.toLowerCase() === key);
    if (i < 0) continue;
    const prev = tokens[i - 1];
    // A member of a collection: the path's last segment, right under a word (/profiles/parker).
    const member = i === tokens.length - 1 && prev?.kind === "literal" && !isStructure(prev.value, undefined);
    out.push({ pattern: "/" + tokens.map((t, j) => (j === i || t.kind === "param" ? "*" : tokenText(t))).join("/"), member });
  }
  return out;
}

/** The example for the hint: a single-use word that ends a path under another word if there is one (it reads like a member). */
function example(plan: Plan, single: PathWord[]): string | undefined {
  let first: string | undefined;
  for (const w of single) {
    const ps = patterns(plan, w.word);
    const m = ps.find((p) => p.member);
    if (m) return m.pattern;
    first ??= ps[0]?.pattern;
  }
  return first;
}

export interface PathWordsSection {
  /** How many of the other (not single-use) words to show; the rest are counted. Default: all. */
  limit?: number;
  /** How a word is shown (the CLI makes invisible characters visible). */
  show?: (word: string) => string;
  /** Show each other word's evidence count (`cart (4)`: the recorded paths using it). */
  counts?: boolean;
  /** How the user turns a word into a parameter: "cli" names `--param`, "mcp" says to run the CLI with it. */
  for?: "cli" | "mcp";
}

/**
 * The section shown to the user: a heading, the single-use words, the others
 * (up to `limit`, then "+N more"), and how to make a word a parameter.
 * Empty when the plan has no literal path words.
 */
export function renderPathWords(plan: Plan, list: PathWord[], opts: PathWordsSection = {}): string[] {
  if (!list.length) return [];
  const show = opts.show ?? ((w: string) => w);
  const single = list.filter(isSingleUse);
  const others = list.filter((w) => !isSingleUse(w));
  const limit = opts.limit ?? Infinity;
  const shown = others.slice(0, limit);
  const more = others.length - shown.length;
  const lines = [`Path words written into client.ts. Check that none is a name, an id or other personal data:`];
  const label = (s: string) => s.padEnd(27);
  lines.push(`  ${label("seen in one request only:")}${single.length ? single.map((w) => show(w.word)).join(", ") : "none"}`);
  if (others.length) lines.push(`  ${label(opts.counts ? "others (paths using it):" : "others:")}${shown.map((w) => show(w.word) + (opts.counts ? ` (${w.requests})` : "")).join(", ")}${more ? ` (+${more} more: har2sdk inspect)` : ""}`);
  const how = show(`--param ${JSON.stringify(example(plan, single.length ? single : list) ?? "/users/*")}`);
  lines.push(
    opts.for === "mcp"
      ? `  A word that is data: run the har2sdk CLI with ${how} to make it a path parameter, or --exclude-path to leave the path out.`
      : `  A word that is data: make it a path parameter with ${how}, or leave the path out with --exclude-path.`,
  );
  return lines;
}

/** A word with its control and format characters shown as `\u{…}` escapes, so the terminal prints it as text. */
export function visibleWord(word: string): string {
  return word.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, (ch) => `\\u{${ch.codePointAt(0)!.toString(16)}}`);
}
