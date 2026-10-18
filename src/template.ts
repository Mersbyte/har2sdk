/**
 * Path templating: `/users/42/orders/ord_9f8a7c` → `/users/{userId}/orders/{orderId}`.
 *
 * Two passes:
 *  1. Per segment: numbers, UUIDs, hex / opaque ids, dates are parameters.
 *  2. Across requests: sibling literals that return the *same response shape*
 *     are values, not resources (`/users/alice`, `/users/bob` → `/users/{user}`),
 *     while `/api/users` and `/api/orders` stay separate because their payloads
 *     differ.
 */
import { isDataLike, isIdentity, isIdShaped, isTainted, personWord, type Taint } from "./leak.js";
import { isPlural, safeIdentifier, setOwn, singular } from "./words.js";

/** A parameter may carry a fixed file extension after it: `/products/{productId}.json`. */
export type Token = { kind: "literal"; value: string } | { kind: "param"; name: string; suffix?: string };

/** How a token reads in a path template: "users", "{userId}", "{productId}.json". */
export function tokenText(t: Token): string {
  return t.kind === "param" ? `{${t.name}}${t.suffix ?? ""}` : t.value;
}

/** Does this concrete segment fit the token? */
export function tokenMatches(t: Token, seg: string | undefined): boolean {
  if (seg === undefined) return false;
  if (t.kind === "literal") return t.value === seg;
  return !t.suffix || (seg.endsWith(t.suffix) && seg.length > t.suffix.length);
}

export interface PathSample {
  origin: string;
  pathname: string;
  /** Deep key paths of the JSON responses seen for this path (for similarity). */
  keyPaths: Set<string>;
  hasJson: boolean;
  /** Path segments that also appear as string values in the response body. */
  echoed?: Set<string>;
  /** Primary language tags from the requests' Accept-Language headers. */
  langs?: Set<string>;
  /** Which response field echoed each segment ("login", "owner.login"). */
  echoFields?: Map<string, string>;
}

export interface TemplatedPath {
  tokens: Token[];
  /** "/users/{userId}" */
  template: string;
  /** Raw value of each parameter in this concrete path, by param name. */
  values: Record<string, string>;
}

const UUID = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;
const INT = /^-?\d+$/;
const HEXID = /^[0-9a-f]{12,}$/i;
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const DATE = /^\d{4}-\d{2}-\d{2}([T ][\d:.]+Z?)?$/;
const PREFIXED_ID = /^[A-Za-z]{1,6}[_-][A-Za-z0-9]{6,}$/; // cus_9s6XKz, ord_8f3k2l9x
const VERSION = /^v\d+(\.\d+)*$/i;
const EMAILISH = /^[^\s@/]+@[^\s@/]+\.[A-Za-z]{2,}$/;
const PHONE = /^\+\d{7,15}$/;
const API_WORD = /^(api|apis|rest|version|versions|v)$/i;
const FILE_EXT = /\.(json|xml|csv|tsv|txt|html?|pdf|png|jpe?g|gif|svg|webp|ics|rss|atom|zip|js|css|md|yaml|yml|xlsx?|docx?)$/i;

/**
 * Does this segment read as words ("getRecommendationsV2", "s3-presigned-upload")
 * rather than an opaque id ("Dk3x9aPq0Lm2Vb7Yt4RsW")? Measures how much of it is
 * made of pronounceable runs of 3+ letters.
 */
export function looksLikeWords(seg: string): boolean {
  const runs = seg.match(/[A-Z]?[a-z]+|[A-Z]+(?![a-z])/g) ?? [];
  const wordy = runs.filter((r) => r.length >= 3 && /[aeiouy]/i.test(r)).reduce((n, r) => n + r.length, 0);
  const total = seg.replace(/[^A-Za-z0-9]/g, "").length || 1;
  return wordy / total >= 0.7;
}

export function splitPath(pathname: string): string[] {
  return pathname
    .split("/")
    .filter((s) => s.length > 0)
    .map((s) => {
      try {
        return decodeURIComponent(s);
      } catch {
        return s;
      }
    });
}

/** Is this single segment obviously a value (an id) rather than a resource name? */
export function isValueSegment(seg: string, prev?: string): boolean {
  if (VERSION.test(seg)) return false;
  // Free text ("ignore previous instructions", "Ayşe Yılmaz") is never a resource name.
  if (/\s/.test(seg.trim()) || seg.length > 80) return true;
  // Shaped like an id even without other evidence: ord-77314, C07QW9XHK, 2025-107454
  // (but not word-numbers like top100, h264, x509).
  if (isIdShaped(seg) && !/^[a-z]+\d+$/.test(seg) && !EMAILISH.test(seg)) return true;
  // "oguz.kilic" after a collection: a dotted name, not a file ("users.json").
  if (prev && isPlural(prev) && /^\p{L}[\p{L}-]*(\.\p{L}[\p{L}-]*)+$/u.test(seg) && !FILE_EXT.test(seg)) return true;
  // `/rest/api/2/…`: a single digit right after "api" is a version, not an id.
  if (/^\d$/.test(seg) && prev && API_WORD.test(prev)) return false;
  if (INT.test(seg) || UUID.test(seg) || ULID.test(seg) || DATE.test(seg) || EMAILISH.test(seg) || PHONE.test(seg)) return true;
  if (HEXID.test(seg) && /\d/.test(seg)) return true;
  if (PREFIXED_ID.test(seg) && /\d/.test(seg) && !looksLikeWords(seg)) return true;
  // Long opaque blobs with digits and letters (base62 ids, slugs with hashes),
  // but not descriptive names like "getRecommendationsV2".
  if (seg.length >= 16 && /^[A-Za-z0-9_\-.~]+$/.test(seg) && /\d/.test(seg) && /[A-Za-z]/.test(seg) && !looksLikeWords(seg)) return true;
  // "my-post-title-1234" style slugs ending in an id.
  if (/^[a-z0-9]+(-[a-z0-9]+)+-\d{3,}$/i.test(seg)) return true;
  return false;
}

interface Entry {
  origin: string;
  tokens: (string | null)[]; // null = parameter
  pathnames: Set<string>;
  keyPaths: Set<string>;
  hasJson: boolean;
  echoed: Set<string>;
  langs: Set<string>;
  /** Parameter names decided while merging (position → name). */
  hints: Record<number, string>;
  /** File extensions after a parameter (position → ".json"). */
  suffixes: Record<number, string>;
}

/** A token's part of a grouping key: literals as themselves, parameters with their extension. */
function tk(e: Entry, j: number): string {
  const t = e.tokens[j];
  return t === null ? "\u0001" + (e.suffixes[j] ?? "") : t!;
}

export interface TemplateOptions {
  /** Disable cross-request merging (pass 2). */
  noMerge?: boolean;
  // Force parameters: path patterns where a `*` or `{name}` segment marks a
  // parameter, e.g. "/users/*" or "/api/*/posts/{postId}". Wins over every
  // heuristic. Patterns without a leading "/" match anywhere in the path.
  params?: string[];
  /** Recorded values: a path segment that is also recorded data is a parameter. */
  taint?: Taint;
  /** Receives notes such as "--param pattern matched nothing". */
  warnings?: string[];
  /**
   * Values listed as members of a collection: "dotfiles" → {"repo"} when a
   * response of `/users/{u}/repos` lists `{ name: "dotfiles" }`. A segment
   * after that collection's name with such a value is one of its ids.
   */
  members?: Map<string, Set<string>>;
}

/** Positions (and names, for `{name}`) forced to be parameters by --param patterns. */
function forcedPositions(segs: string[], patterns: string[], matched: Set<string>): Map<number, string | undefined> {
  const out = new Map<number, string | undefined>();
  for (const p of patterns) {
    const pat = splitPath(p);
    if (!pat.length) continue;
    const anchored = p.trim().startsWith("/");
    const starts = anchored ? (pat.length === segs.length ? [0] : []) : [...Array(Math.max(0, segs.length - pat.length + 1)).keys()];
    for (const start of starts) {
      const ok = pat.every((x, j) => x === "*" || /^\{.*\}$/.test(x) || x === segs[start + j]);
      if (!ok) continue;
      matched.add(p);
      pat.forEach((x, j) => {
        if (x === "*") out.set(start + j, out.get(start + j));
        else if (/^\{.*\}$/.test(x)) out.set(start + j, safeIdentifier(x.slice(1, -1)) || undefined);
      });
    }
  }
  return out;
}

/**
 * Build templates for a set of concrete paths.
 * Returns a lookup keyed by `${origin}${pathname}`.
 */
export function templatePaths(samples: PathSample[], opts: TemplateOptions = {}): Map<string, TemplatedPath> {
  // Pass 1 — per-segment classification; group identical results.
  const entries = new Map<string, Entry>();
  const matched = new Set<string>();
  for (const s of samples) {
    const segs = splitPath(s.pathname);
    const forced = forcedPositions(segs, opts.params ?? [], matched);
    const hints: Record<number, string> = {};
    const suffixes: Record<number, string> = {};
    const tokens: (string | null)[] = [];
    /** The nearest literal before position i (skipping parameters): the collection it belongs to. */
    const collection = (i: number) => {
      for (let j = i - 1; j >= 0; j--) if (tokens[j] !== null) return tokens[j]!;
      return undefined;
    };
    const classify = (seg: string, i: number): string | null => {
      if (forced.has(i)) {
        const name = forced.get(i);
        if (name) hints[i] = name;
        return null;
      }
      const lower = seg.toLowerCase();
      const prevSeg = segs[i - 1];
      const prevParam = i > 0 && tokens[i - 1] === null;
      // Dated API versions (Shopify's /admin/api/2024-01/) are part of the base path.
      if (/^\d{4}-\d{2}$/.test(seg) && prevSeg && API_WORD.test(prevSeg)) return seg;
      if (isValueSegment(seg, prevSeg)) return null;
      // The same string was recorded as data (an order number in a body, a
      // channel id in a query): it's an identifier, not a resource name.
      // A personal value (a username, a name) right after a collection counts too: /users/mdemir/repos.
      // Vocabulary that also shows up in a body ("oauth2", "ipv4") is not enough: the
      // segment must be id-shaped, or name a user/tenant right after a collection.
      // A one-word name counts as a user's name after a collection of people (/users/oguz).
      const named = isIdentity(opts.taint, seg) || (!!prevSeg && personWord(prevSeg) && !!opts.taint?.labels.has(lower));
      if (opts.taint && isTainted(opts.taint, seg) && (isIdShaped(seg) || (prevSeg && isPlural(prevSeg) && named && !COMMON_SUBPATHS.has(lower)))) return null;
      // Strong tenant prefixes (/orgs/acme/repos, /t/acme-corp/projects): the
      // next segment names a tenant, unless it's a sub-collection or a keyword.
      // Weaker words (account, team, site…) need evidence: see shouldMerge.
      const before = prevSeg?.toLowerCase();
      if (before && STRONG_TENANT_WORDS.has(before) && i < segs.length - 1 && !COMMON_SUBPATHS.has(lower) && !/^v\d/i.test(seg)) {
        if (before === "t" || before.startsWith("tenant")) hints[i] = "tenant";
        return null;
      }
      // Listed by a response of this very collection (/users/{u}/repos lists { name: "dotfiles" }):
      // /repos/{owner}/dotfiles is one of its members.
      const coll = collection(i);
      if (coll && (isPlural(coll) || prevParam) && opts.members?.get(lower)?.has(singular(coll).toLowerCase()) && !COMMON_SUBPATHS.has(lower)) {
        if (prevParam) hints[i] = safeIdentifier(singular(coll));
        return null;
      }
      // Seen once, but the response identifies itself by this very value
      // (`/users/alice` → `{"login": "alice"}`) — after a collection name, after
      // another parameter (/repos/{owner}/har2sdk → { name: "har2sdk" }), or after
      // a singular resource word when the echo is a key field (/project/PROJ → { key: "PROJ" }).
      const field = s.echoFields?.get(lower) ?? (s.echoed?.has(lower) ? "id" : undefined);
      if (field !== undefined && prevSeg && i === segs.length - 1 && !COMMON_SUBPATHS.has(lower)) {
        const strong = /^(id|uuid|key|slug|login|username|handle|code|number)$/i.test(field.split(".").pop()!);
        if (isPlural(prevSeg) || prevParam || (strong && /^[a-z]+$/i.test(prevSeg) && !API_WORD.test(prevSeg))) {
          const owner = field.includes(".") ? field.split(".")[0]! : undefined;
          if (owner) hints[i] = owner;
          else if (prevParam && coll) hints[i] = safeIdentifier(singular(coll));
          return null;
        }
      }
      return seg;
    };
    segs.forEach((seg, i) => {
      // `{id}.json`: a value with a format extension is a parameter that keeps the extension.
      const ext = !forced.has(i) ? seg.match(FILE_EXT)?.[0] : undefined;
      // A file name in a collection (/attachments/hiv-test-results.pdf) is one of its members.
      if (ext && !/^\.(json|xml)$/i.test(ext) && ext.length < seg.length && segs[i - 1] && isPlural(segs[i - 1]!) && !/^(index|default|main)$/i.test(seg.slice(0, -ext.length)) && !COMMON_SUBPATHS.has(seg.slice(0, -ext.length).toLowerCase())) {
        tokens.push(null);
        return;
      }
      if (ext && ext.length < seg.length) {
        const stem = seg.slice(0, -ext.length);
        if (classify(stem, i) === null) {
          tokens.push(null);
          suffixes[i] = ext;
          return;
        }
        delete hints[i];
      }
      tokens.push(classify(seg, i));
    });
    // Owners echoed in a nested object (/repos/okilic/x → { owner: { login: "okilic" } }) name their parameter.
    segs.forEach((seg, i) => {
      const f = s.echoFields?.get(seg.toLowerCase());
      if (tokens[i] === null && !hints[i] && f?.includes(".")) hints[i] = f.split(".")[0]!;
    });
    const key = s.origin + "\u0000" + tokens.map((t, j) => (t === null ? "\u0001" + (suffixes[j] ?? "") : t)).join("/");
    let e = entries.get(key);
    if (!e) entries.set(key, (e = { origin: s.origin, tokens, pathnames: new Set(), keyPaths: new Set(), hasJson: false, echoed: new Set(), langs: new Set(), hints: {}, suffixes }));
    Object.assign(e.hints, hints);
    e.pathnames.add(s.pathname);
    for (const k of s.keyPaths) e.keyPaths.add(k);
    for (const k of s.echoed ?? []) e.echoed.add(k);
    for (const k of s.langs ?? []) e.langs.add(k);
    e.hasJson ||= s.hasJson;
  }
  for (const p of opts.params ?? []) if (!matched.has(p)) opts.warnings?.push(`--param "${p}" matched no recorded path.`);

  let list = [...entries.values()];
  if (!opts.noMerge) list = applyLearnedParams(mergeSiblings(list), opts.taint, opts.members);

  // A name decided for one path (from an echo) holds for every path that shares the prefix.
  const shared = new Map<string, string>();
  const at = (e: Entry, i: number) => e.origin + "\u0000" + e.tokens.slice(0, i + 1).map((_, j) => tk(e, j)).join("/");
  for (const e of list) for (const [i, h] of Object.entries(e.hints)) if (!shared.has(at(e, +i))) shared.set(at(e, +i), h);
  for (const e of list) e.tokens.forEach((t, i) => {
    if (t === null && !e.hints[i] && shared.has(at(e, i))) e.hints[i] = shared.get(at(e, i))!;
  });

  // Assign parameter names and build the lookup.
  const out = new Map<string, TemplatedPath>();
  for (const e of list) {
    const strip = (v: string, i: number) => (e.suffixes[i] && v.endsWith(e.suffixes[i]!) ? v.slice(0, -e.suffixes[i]!.length) : v);
    const valuesAt = (i: number) => [...e.pathnames].map((p) => strip(splitPath(p)[i] ?? "", i));
    const names = paramNames(e.tokens, e.hints, valuesAt);
    const tokens: Token[] = e.tokens.map((t, i) => (t === null ? { kind: "param", name: names[i]!, ...(e.suffixes[i] ? { suffix: e.suffixes[i] } : {}) } : { kind: "literal", value: t }));
    const template = "/" + tokens.map(tokenText).join("/");
    for (const pathname of e.pathnames) {
      const segs = splitPath(pathname);
      const values: Record<string, string> = {};
      tokens.forEach((t, i) => {
        if (t.kind === "param") setOwn(values, t.name, strip(segs[i] ?? "", i));
      });
      out.set(e.origin + pathname, { tokens, template: template === "/" ? "/" : template, values });
    }
  }
  return out;
}

function mergeSiblings(input: Entry[]): Entry[] {
  let list = input;
  let changed = true;
  let guard = 0;
  while (changed && guard++ < 20) {
    changed = false;
    const maxLen = Math.max(0, ...list.map((e) => e.tokens.length));
    for (let i = 0; i < maxLen; i++) {
      const groups = new Map<string, Entry[]>();
      for (const e of list) {
        if (e.tokens.length <= i || e.tokens[i] === null) continue;
        const sig = e.origin + "\u0000" + e.tokens.length + "\u0000" + e.tokens.map((_, j) => (j === i ? "*" : tk(e, j))).join("/");
        let g = groups.get(sig);
        if (!g) groups.set(sig, (g = []));
        g.push(e);
      }
      for (const group of groups.values()) {
        if (group.length < 2) continue;
        const verdict = shouldMerge(group, i);
        if (!verdict) continue;
        const merged: Entry = {
          origin: group[0]!.origin,
          tokens: group[0]!.tokens.map((t, j) => (j === i ? null : t)),
          pathnames: new Set(group.flatMap((g) => [...g.pathnames])),
          keyPaths: new Set(group.flatMap((g) => [...g.keyPaths])),
          hasJson: group.some((g) => g.hasJson),
          echoed: new Set(group.flatMap((g) => [...g.echoed])),
          langs: new Set(group.flatMap((g) => [...g.langs])),
          hints: { ...Object.assign({}, ...group.map((g) => g.hints)), ...(verdict === "locale" ? { [i]: "locale" } : {}) },
          suffixes: { ...group[0]!.suffixes },
        };
        // An entry with that exact template may already exist (from pass 1).
        const existing = list.find((e) => !group.includes(e) && e.origin === merged.origin && sameTokens(e, merged));
        list = list.filter((e) => !group.includes(e) && e !== existing);
        if (existing) {
          for (const p of existing.pathnames) merged.pathnames.add(p);
          for (const k of existing.keyPaths) merged.keyPaths.add(k);
          for (const k of existing.echoed) merged.echoed.add(k);
          merged.hasJson ||= existing.hasJson;
          Object.assign(merged.hints, existing.hints);
        }
        list.push(merged);
        changed = true;
      }
    }
  }
  // Fold any pass-1 entries that now duplicate a merged template.
  return list;
}

function sameTokens(a: Entry, b: Entry): boolean {
  return a.tokens.length === b.tokens.length && a.tokens.every((_, i) => tk(a, i) === tk(b, i));
}

/** "ord-77314" → "a-9", "C07QW9XHK" → "A9A9A": what an identifier looks like, without its value. */
function valueShape(v: string): string {
  return v.replace(/[A-Z]+/g, "A").replace(/[a-z]+/g, "a").replace(/\d+/g, "9");
}

/**
 * Apply learned parameters to longer paths: once `/api/orders/{orderId}` is
 * known, `/api/orders/ord-77314/refund` also has an order id at that position —
 * if the literal has the same shape as the recorded ids (digits included), or
 * was itself recorded as data.
 */
function applyLearnedParams(input: Entry[], taint: Taint | undefined, members?: Map<string, Set<string>>): Entry[] {
  let list = input;
  for (let round = 0; round < 5; round++) {
    let changed = false;
    // Index: (origin, position, prefix) → entries with a parameter at that position.
    const prefixKey = (e: Entry, i: number) => e.origin + "\u0000" + i + "\u0000" + e.tokens.slice(0, i).map((_, j) => tk(e, j)).join("/");
    const byPrefix = new Map<string, Entry[]>();
    const summaries = new Map<string, Summary>();
    for (const f of list) {
      f.tokens.forEach((t, i) => {
        if (t !== null) return;
        const k = prefixKey(f, i);
        const arr = byPrefix.get(k);
        if (arr) arr.push(f);
        else byPrefix.set(k, [f]);
      });
    }
    for (const e of list) {
      for (let i = 0; i < e.tokens.length; i++) {
        const lit = e.tokens[i];
        if (lit === null || lit === undefined) continue;
        const pk = prefixKey(e, i);
        const knowns = byPrefix.get(pk);
        const known = knowns?.[0];
        if (!known) continue;
        if (VERSION.test(lit) || WORD_DIGITS.test(lit)) continue;
        let sum = summaries.get(pk);
        if (!sum) summaries.set(pk, (sum = summarize([...new Set(knowns!.flatMap((k) => [...k.pathnames].map((p) => splitPath(p)[i] ?? "")))], taint)));
        const sameShape = isIdShaped(lit) && sum.shapes.has(valueShape(lit));
        // A member of the collection this position belongs to (see TemplateOptions.members).
        let coll: string | undefined;
        for (let j = i - 1; j >= 0 && coll === undefined; j--) if (e.tokens[j] !== null) coll = e.tokens[j]!;
        const member = !!coll && !!members?.get(lit.toLowerCase())?.has(singular(coll).toLowerCase()) && !COMMON_SUBPATHS.has(lit.toLowerCase());
        if (!sameShape && !member && !(taint && isIdShaped(lit) && isTainted(taint, lit)) && !looksLikeSibling(lit, sum)) continue;
        e.tokens = e.tokens.map((t, j) => (j === i ? null : t));
        if (known.hints[i] && !e.hints[i]) e.hints[i] = known.hints[i]!;
        changed = true;
      }
    }
    if (!changed) break;
    // Entries that now share a template become one.
    const byKey = new Map<string, Entry>();
    for (const e of list) {
      const key = e.origin + "\u0000" + e.tokens.map((_, j) => tk(e, j)).join("/");
      const prev = byKey.get(key);
      if (!prev) byKey.set(key, e);
      else {
        for (const p of e.pathnames) prev.pathnames.add(p);
        for (const k of e.keyPaths) prev.keyPaths.add(k);
        for (const k of e.echoed) prev.echoed.add(k);
        prev.hasJson ||= e.hasJson;
        Object.assign(prev.hints, e.hints);
      }
    }
    list = [...byKey.values()];
  }
  return list;
}

/** "oauth2", "ipv4", "web3", "covid19": words with a number, not ids. */
const WORD_DIGITS = /^[a-z]+\d{1,2}[a-z]*$/;

function charClasses(v: string): Set<string> {
  const out = new Set<string>();
  for (const ch of v) out.add(/[A-Z]/.test(ch) ? "U" : /[a-z]/.test(ch) ? "L" : /\d/.test(ch) ? "D" : "S");
  return out;
}

/**
 * Is this literal another one of these ids? The known values must all be
 * identifiers, and the literal must look like them (similar length, no new
 * kinds of characters) without being a plain word like "summary".
 */
interface Summary {
  shapes: Set<string>;
  valueish: boolean;
  minLen: number;
  maxLen: number;
  classes: Set<string>;
}

/** What the known values at one parameter position look like (computed once per position). */
function summarize(known: string[], taint?: Taint): Summary {
  const sample = known.length > 200 ? known.slice(0, 200) : known;
  const lens = sample.map((v) => v.length);
  return {
    shapes: new Set(sample.map(valueShape)),
    valueish: sample.length > 0 && sample.filter((v) => isValueSegment(v) || isDataLike(v) || isTainted(taint, v)).length * 3 >= sample.length * 2,
    minLen: Math.min(...lens),
    maxLen: Math.max(...lens),
    classes: new Set(sample.flatMap((v) => [...charClasses(v)])),
  };
}

function looksLikeSibling(lit: string, sum: Summary): boolean {
  if (!sum.valueish) return false;
  if (/^[a-z]+(-[a-z]+)*$/.test(lit) || /^[A-Z][a-z]+$/.test(lit) || VERSION.test(lit)) return false;
  if (lit.length < sum.minLen - 1 || lit.length > sum.maxLen + 1) return false;
  // Digits may appear in one id and not in another (A9QZRY vs AKQXZP).
  return [...charClasses(lit)].every((c) => c === "D" || sum.classes.has(c));
}

/** After these, the next segment is (nearly always) a tenant id: /orgs/acme, /t/acme-corp. */
const STRONG_TENANT_WORDS = new Set(["t", "tenant", "tenants", "org", "orgs", "organization", "organizations", "workspace", "workspaces"]);
/** These need evidence (two different values) before the next segment becomes a parameter. */
const TENANT_WORDS = new Set([...STRONG_TENANT_WORDS, "team", "teams", "account", "accounts", "company", "companies", "site", "sites", "project", "projects"]);
const COMMON_SUBPATHS = new Set(
  "settings me current self new search all default public private admin billing members invites invitations profile preferences config configuration usage stats".split(" "),
);

const LOCALE = /^[a-z]{2}([-_][a-z]{2})$/i;
const LOCALE_SHORT = /^[a-z]{2}$/;

function shouldMerge(group: Entry[], i: number): boolean | "locale" {
  const literals = group.map((e) => e.tokens[i] as string);
  if (literals.some((l) => VERSION.test(l))) return false;
  const n = new Set(literals).size;
  if (n < 2) return false;

  // Locale prefixes: /en-us/…, /de-de/…, or /tr/…, /de/… near the start of the path
  // (the rest of the path is identical, which grouping already guarantees).
  // Two-letter codes collide with words and department codes (/id/, /no/, /it/, /hr/):
  // they need three distinct languages, or a matching Accept-Language header.
  if (i <= 1 && literals.every((l) => LOCALE.test(l))) return "locale";
  if (i <= 1 && literals.every((l) => LOCALE_SHORT.test(l) && KNOWN_LANGS.has(l))) {
    const langs = new Set(group.flatMap((e) => [...e.langs]));
    const confirmed = literals.filter((l) => langs.has(l.toLowerCase())).length >= 1 && n >= 2;
    const unambiguous = !literals.some((l) => AMBIGUOUS_LANGS.has(l));
    const withJ = group.filter((e) => e.hasJson && e.keyPaths.size > 0);
    const similar = withJ.length < 2 || meanJaccard(withJ.map((e) => e.keyPaths)) >= 0.6;
    if (confirmed || (n >= 3 && unambiguous) || (n === 2 && i === 0 && unambiguous && similar)) return "locale";
  }

  // /teams/{teamId}/…, /account/{accountId}/…: two different values right after a
  // tenant-ish word, none of them a sub-collection name, followed by more path.
  const before = i > 0 ? group[0]!.tokens[i - 1] : undefined;
  if (typeof before === "string" && TENANT_WORDS.has(before.toLowerCase()) && i < group[0]!.tokens.length - 1) {
    if (!literals.some((l) => isPlural(l) || COMMON_SUBPATHS.has(l.toLowerCase()) || VERSION.test(l))) return true;
  }

  const withJson = group.filter((e) => e.hasJson && e.keyPaths.size > 0);
  const sim = withJson.length >= 2 ? meanJaccard(withJson.map((e) => e.keyPaths)) : undefined;
  const minKeys = withJson.length ? Math.min(...withJson.map((e) => e.keyPaths.size)) : 0;

  // How many of these literals does the server echo back in its response?
  // `/users/alice` → `{"login": "alice"}` is strong evidence of an identifier.
  const echoed = group.filter((e) => e.echoed.has((e.tokens[i] as string).toLowerCase())).length;

  // Words (any case: "users", "getUserInfo", "s3-presigned-upload") are names
  // of resources, actions or sub-collections. Merge them only when the server
  // echoes each one back as an identifier and the payloads match.
  const wordLike = (l: string) => /^[A-Za-z]+([-_.][A-Za-z]+)*$/.test(l) || looksLikeWords(l);
  if (literals.every(wordLike)) {
    const plural = literals.filter((l) => isPlural(l)).length;
    if (plural * 2 >= literals.length && echoed < group.length) return false;
    if (sim === undefined || echoed * 3 < group.length * 2) return false;
    return sim >= 0.6;
  }

  // Opaque, digit-bearing values ("t1x", "a7f3k") with no payload to compare:
  // need several distinct samples.
  const valueish = literals.every((l) => /\d/.test(l) && !wordLike(l));
  if (valueish) return sim === undefined ? n >= 3 : sim >= 0.5;

  if (sim === undefined) return false;
  return (n >= 3 && sim >= 0.6) || (n === 2 && sim >= 0.9 && minKeys >= 3);
}

const AMBIGUOUS_LANGS = new Set("id no it hr is am as be in me my so to or on at do go hi ms sk sl".split(" "));
const KNOWN_LANGS = new Set(
  "ar bg bn cs da de el en es et fa fi fr he hi hr hu id it ja ko lt lv ms nb nl no pl pt ro ru sk sl sr sv th tr uk vi zh".split(" "),
);

function meanJaccard(sets: Set<string>[]): number {
  let total = 0;
  let pairs = 0;
  for (let a = 0; a < sets.length; a++) {
    for (let b = a + 1; b < sets.length; b++) {
      const A = sets[a]!;
      const B = sets[b]!;
      let inter = 0;
      for (const k of A) if (B.has(k)) inter++;
      const union = A.size + B.size - inter;
      total += union === 0 ? 1 : inter / union;
      pairs++;
    }
  }
  return pairs ? total / pairs : 1;
}

/** `/users/{?}/orders/{?}` → ["userId", "orderId"] (by position). */
function paramNames(tokens: (string | null)[], hints: Record<number, string> = {}, valuesAt?: (i: number) => string[]): Record<number, string> {
  const names: Record<number, string> = {};
  const used = new Set<string>();
  let anon = 0;
  tokens.forEach((t, i) => {
    if (t !== null) return;
    const prev = i > 0 ? tokens[i - 1] : undefined;
    let base: string;
    const vals = valuesAt?.(i) ?? [];
    if (hints[i]) {
      base = hints[i]!;
    } else if (vals.length && vals.every((v) => /^(19|20)\d\d$/.test(v))) {
      base = "year";
    } else if (vals.length && vals.every((v) => /^\d{4}-\d{2}-\d{2}$/.test(v))) {
      base = "date";
    } else if (typeof prev === "string" && !VERSION.test(prev) && /[A-Za-z]/.test(prev)) {
      base = safeIdentifier(singular(prev)) + "Id";
    } else {
      base = anon === 0 ? "id" : `param${anon + 1}`;
      anon++;
    }
    let name = base;
    let k = 2;
    while (used.has(name)) name = `${base}${k++}`;
    used.add(name);
    names[i] = name;
  });
  return names;
}
