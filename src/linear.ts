/**
 * Linear-time replacements for regexes that CodeQL flagged as polynomial. All
 * but withoutQueryOrHash backtracked quadratically on crafted input. Each
 * function returns exactly what the regex in its comment returns;
 * test/review9.test.ts and test/review10.test.ts compare them on generated input.
 */

/** `s.replace(/[ \t]+$/gm, "")`: spaces and tabs at the end of every line. */
export function trimLineEnds(s: string): string {
  // `$` with the m flag matches before \n, \r, \u2028, \u2029 and at the end.
  return s.replace(/[^\n\r\u2028\u2029]+/g, (line) => {
    let end = line.length;
    while (end > 0 && (line.charCodeAt(end - 1) === 32 || line.charCodeAt(end - 1) === 9)) end--;
    return end === line.length ? line : line.slice(0, end);
  });
}

/** `s.replace(/\/+$/, "")`: trailing slashes. */
export function trimTrailingSlashes(s: string): string {
  let end = s.length;
  while (end > 0 && s.charCodeAt(end - 1) === 47) end--;
  return end === s.length ? s : s.slice(0, end);
}

/**
 * `s.replace(/[?#].*$/, "")` for a string without line terminators (the caller
 * has checked `/^\/[^\s]*$/`): everything from the first `?` or `#`.
 */
export function withoutQueryOrHash(s: string): string {
  const cut = s.search(/[?#]/);
  return cut < 0 ? s : s.slice(0, cut);
}

/** `text.match(/```(?:json)?\s*([\s\S]*?)```/)?.[1]`: the body of the first fenced block. */
export function fencedBody(text: string): string | undefined {
  const open = text.indexOf("```");
  if (open < 0) return undefined;
  let start = open + 3;
  if (text.startsWith("json", start)) start += 4;
  while (start < text.length && /\s/.test(text[start]!)) start++;
  // "json" and whitespace hold no backtick, so no closing fence can start
  // before `start`; and if none follows the first opening, none follows a later one.
  const close = text.indexOf("```", start);
  return close < 0 ? undefined : text.slice(start, close);
}

/**
 * `text.replace(/[^\s"'<>`|()[\]{},;]*%[0-9A-Fa-f]{2}[^\s"'<>`|()[\]{},;]*\/g, fn)`:
 * every run of token characters that holds a percent escape. The regex's
 * leftmost match always spans a whole run, so runs are matched once each.
 */
export function replacePercentRuns(text: string, fn: (token: string) => string): string {
  return text.replace(/[^\s"'<>`|()[\]{},;]+/g, (run) => (/%[0-9A-Fa-f]{2}/.test(run) ? fn(run) : run));
}

const FRAGMENT_HEAD = /(^|\})\s*fragment\s+[A-Za-z_]\w*\s+on\s+(?=([A-Za-z_]\w*))\2/;

/**
 * `/(^|\})\s*fragment\s+[A-Za-z_]\w*\s+on\s+[A-Za-z_]\w*[^{]*\{/.exec(s)` as
 * `{ index, prefix, end }`: where the match starts, its first group, and the
 * index after its `{`. The regex's tail `[^{]*\{` ends at the first `{` after
 * the type condition; if there is none, no later start can match either.
 */
export function findFragmentHead(s: string): { index: number; prefix: string; end: number } | undefined {
  const m = FRAGMENT_HEAD.exec(s);
  if (!m) return undefined;
  const brace = s.indexOf("{", m.index + m[0].length);
  return brace < 0 ? undefined : { index: m.index, prefix: m[1]!, end: brace + 1 };
}

/** `s.replace(/^[.\-~]+|[.\-~]+$/g, "")`: dots, dashes and tildes at either end. */
export function trimDotsDashesTildes(s: string): string {
  const edge = (c: number) => c === 46 || c === 45 || c === 126;
  let start = 0;
  while (start < s.length && edge(s.charCodeAt(start))) start++;
  let end = s.length;
  while (end > start && edge(s.charCodeAt(end - 1))) end--;
  return start === 0 && end === s.length ? s : s.slice(start, end);
}

/** What `.` matches outside the s flag: anything but a line terminator. */
function isDot(c: number): boolean {
  return c !== 10 && c !== 13 && c !== 0x2028 && c !== 0x2029;
}

/**
 * Where `/"(?:[^"\\]|\\.)*"/y` (or `/"(?:[^"\\\n]|\\.)*"/y` when `newline` is
 * false) stops when started at the `"` at `q`: `{ end }` after the closing
 * quote, or `{ fail }` at the backslash or newline it can't get past.
 *
 * A string that fails at `fail` also fails from every `"` between `q` and
 * `fail`: each of those was escaped, so a scan from it continues exactly as
 * the scan from `q` did. Callers remember `fail` and skip those quotes, which
 * the regexes tried one by one (quadratic on `"\"\"\"…`).
 */
function quotedEnd(s: string, q: number, newline: boolean): { end: number } | { fail: number } {
  let i = q + 1;
  while (i < s.length) {
    const c = s.charCodeAt(i);
    if (c === 34) return { end: i + 1 };
    if (c === 92) {
      if (i + 1 < s.length && isDot(s.charCodeAt(i + 1))) i += 2;
      else return { fail: i };
    } else if (c === 10 && !newline) return { fail: i };
    else i++;
  }
  return { fail: i };
}

/**
 * The `/"(?:[^"\\\n]|\\.)*"/g` matches in `s` (`/"(?:[^"\\]|\\.)*"/g` when
 * `newline` is true), as `[start, end]`.
 */
export function* quotedStrings(s: string, newline = false): Generator<[number, number]> {
  let unclosedUntil = -1;
  for (let q = s.indexOf('"'); q >= 0; ) {
    if (q < unclosedUntil) {
      q = s.indexOf('"', q + 1);
      continue;
    }
    const r = quotedEnd(s, q, newline);
    if ("end" in r) {
      yield [q, r.end];
      q = s.indexOf('"', r.end);
    } else {
      unclosedUntil = r.fail;
      q = s.indexOf('"', q + 1);
    }
  }
}

/** `s.replace(/"(?:[^"\\\n]|\\.)*"/g, fn)` (`/"(?:[^"\\]|\\.)*"/g` when `newline` is true). */
export function replaceQuoted(s: string, fn: (quoted: string) => string, newline = false): string {
  let out = "";
  let last = 0;
  for (const [start, end] of quotedStrings(s, newline)) {
    out += s.slice(last, start) + fn(s.slice(start, end));
    last = end;
  }
  return last === 0 ? s : out + s.slice(last);
}

/**
 * `s.replace(/"""[\s\S]*?"""|"(?:[^"\\\n]|\\.)*"|#[^\n\r]*\/g, (m) => (m.startsWith("#") ? "" : m))`:
 * a GraphQL document without its comments.
 */
export function removeHashComments(s: string): string {
  const re = /"""|"|#[^\n\r]*/g;
  let out = "";
  let last = 0;
  let unclosedUntil = -1;
  let noBlockEnd = false;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    const q = m.index;
    if (m[0][0] === "#") {
      out += s.slice(last, q);
      last = re.lastIndex;
      continue;
    }
    if (m[0] === '"""' && !noBlockEnd) {
      const close = s.indexOf('"""', q + 3);
      if (close >= 0) {
        re.lastIndex = close + 3;
        continue;
      }
      // No `"""` after this one, so none after a later one either.
      noBlockEnd = true;
    }
    // A `"` inside a string that doesn't close (see quotedEnd).
    if (q < unclosedUntil) {
      re.lastIndex = q + 1;
      continue;
    }
    const r = quotedEnd(s, q, false);
    if ("end" in r) re.lastIndex = r.end;
    else {
      unclosedUntil = r.fail;
      re.lastIndex = q + 1;
    }
  }
  return last === 0 ? s : out + s.slice(last);
}

const GQL_TOKEN = /([{}()])|(\.\.\.\s*[A-Za-z_]\w*)|([A-Za-z_]\w*)(\s*:\s*([A-Za-z_]\w*))?|"/g;

/**
 * The matches of
 * `/([{}()])|(\.\.\.\s*[A-Za-z_]\w*)|([A-Za-z_]\w*)(\s*:\s*([A-Za-z_]\w*))?|"(?:[^"\\]|\\.)*"/g`
 * from `start`: GraphQL punctuation, spreads, fields with their aliases, and strings.
 */
export function* graphqlTokens(doc: string, start: number): Generator<RegExpExecArray> {
  const re = new RegExp(GQL_TOKEN);
  re.lastIndex = start;
  let unclosedUntil = -1;
  let m: RegExpExecArray | null;
  while ((m = re.exec(doc))) {
    if (m[0] !== '"') {
      yield m;
      continue;
    }
    // The other alternatives can't start at a `"`: if the string doesn't
    // close, the regex moved on to the next character.
    if (m.index < unclosedUntil) continue;
    const r = quotedEnd(doc, m.index, true);
    if ("end" in r) {
      // The string closes: the match the regex made, with its five groups unset.
      const text = doc.slice(m.index, r.end);
      yield Object.assign([text, undefined, undefined, undefined, undefined, undefined], { index: m.index, input: doc, groups: undefined }) as unknown as RegExpExecArray;
      re.lastIndex = r.end;
    } else unclosedUntil = r.fail;
  }
}

const GQL_LITERAL = /#[^\n]*|(?:\b([A-Za-z_]\w*)\s*:\s*)?(?:(""")|"|(?<![\w$.])(-?\d+(?:\.\d+)?)(?![\w.]))/g;

/** A match of {@link graphqlLiteralMatches}: the whole match and its four groups. */
export type GraphqlLiteral = [string, string | undefined, string | undefined, string | undefined, string | undefined] & { index: number };

/**
 * The matches of
 * `/#[^\n]*|(?:\b([A-Za-z_]\w*)\s*:\s*)?(?:"""([\s\S]*?)"""|"((?:[^"\\\n]|\\.)*)"|(?<![\w$.])(-?\d+(?:\.\d+)?)(?![\w.]))/g`:
 * comments, and string and number literals (integers and decimals) with the argument name before them.
 */
export function* graphqlLiteralMatches(doc: string): Generator<GraphqlLiteral> {
  const re = new RegExp(GQL_LITERAL);
  const literal = (index: number, end: number, groups: [string | undefined, string | undefined, string | undefined, string | undefined]): GraphqlLiteral =>
    Object.assign([doc.slice(index, end), ...groups] as GraphqlLiteral, { index });
  let unclosedUntil = -1;
  let noBlockEnd = false;
  let m: RegExpExecArray | null;
  while ((m = re.exec(doc))) {
    if (m[0][0] === "#" || m[3] !== undefined) {
      yield literal(m.index, re.lastIndex, [m[1], undefined, undefined, m[3]]);
      continue;
    }
    // The literal starts at the `"` the match ends with.
    const q = re.lastIndex - (m[2] ? 3 : 1);
    if (m[2] && !noBlockEnd) {
      const close = doc.indexOf('"""', q + 3);
      if (close >= 0) {
        yield literal(m.index, close + 3, [m[1], doc.slice(q + 3, close), undefined, undefined]);
        re.lastIndex = close + 3;
        continue;
      }
      noBlockEnd = true;
    }
    const r = q < unclosedUntil ? undefined : quotedEnd(doc, q, false);
    if (r && "end" in r) {
      yield literal(m.index, r.end, [m[1], undefined, doc.slice(q + 1, r.end - 1), undefined]);
      re.lastIndex = r.end;
      continue;
    }
    if (r) unclosedUntil = r.fail;
    // The string doesn't close. Without it, nothing matches at m.index (a
    // name or a `"`): the regex moved on to the next character.
    re.lastIndex = m.index + 1;
  }
}

/** What `\s` matches (without the u flag). */
export function isSpaceCode(c: number): boolean {
  return (
    (c >= 9 && c <= 13) || c === 32 || c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) ||
    c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff
  );
}

const isDigitCode = (c: number) => c >= 48 && c <= 57;
const isWordCode = (c: number) => isDigitCode(c) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;

/**
 * Lookup tables over a GraphQL document, filled right to left in one pass so
 * that no position is scanned twice:
 * - `space[i]`: the first index at or after `i` that `\s` doesn't match;
 * - `digits[i]`: the first index at or after `i` that isn't a digit;
 * - `body[i]`: the index after the `"` that closes a string whose body
 *   (`(?:[^"\\\n]|\\.)*`) starts at `i`, or -1 if it doesn't close.
 */
class GraphqlTables {
  readonly space: Int32Array;
  readonly digits: Int32Array;
  readonly body: Int32Array;
  private readonly lastTriple: number;
  private list: Int32Array | undefined;

  constructor(readonly doc: string) {
    const n = doc.length;
    this.space = new Int32Array(n + 1);
    this.digits = new Int32Array(n + 1);
    this.body = new Int32Array(n + 2).fill(-1);
    this.space[n] = n;
    this.digits[n] = n;
    for (let i = n - 1; i >= 0; i--) {
      const c = doc.charCodeAt(i);
      this.space[i] = isSpaceCode(c) ? this.space[i + 1]! : i;
      this.digits[i] = isDigitCode(c) ? this.digits[i + 1]! : i;
      if (c === 34) this.body[i] = i + 1;
      else if (c === 92) this.body[i] = i + 1 < n && isDot(doc.charCodeAt(i + 1)) ? this.body[i + 2]! : -1;
      else this.body[i] = c === 10 ? -1 : this.body[i + 1]!;
    }
    this.lastTriple = doc.lastIndexOf('"""');
  }

  triple(i: number): boolean {
    return this.doc.startsWith('"""', i);
  }

  /** `"""[\s\S]*?"""` at `i` (a `"""` there): the end, or -1. */
  block(i: number): number {
    // The last `"""` bounds every search, so a failed one costs nothing.
    if (i + 3 > this.lastTriple) return -1;
    return this.doc.indexOf('"""', i + 3) + 3;
  }

  /** `"(?:[^"\\\n]|\\.)*"(?!")` at `i` (a `"` there): the end, or -1. */
  string(i: number): number {
    const end = this.body[i + 1]!;
    return end >= 0 && this.doc.charCodeAt(end) !== 34 ? end : -1;
  }

  /** `-?\d+(?:\.\d+)?(?![\w.])` at `i`: the end, or -1. */
  number(i: number): number {
    const start = this.doc.charCodeAt(i) === 45 ? i + 1 : i;
    if (!isDigitCode(this.doc.charCodeAt(start))) return -1;
    let end = this.digits[start]!;
    // A decimal (`41.0123`): the fraction's digits, then the same check. Backing
    // off to the integer part never helps: a `.` follows it.
    if (this.doc.charCodeAt(end) === 46 && isDigitCode(this.doc.charCodeAt(end + 1))) end = this.digits[end + 1]!;
    const next = this.doc.charCodeAt(end);
    return isWordCode(next) || next === 46 ? -1 : end;
  }

  /**
   * `\[\s*(?:(?:STRING|NUMBER)\s*,?\s*)+\]` at the `[` at `i`, where STRING
   * and NUMBER are {@link block}/{@link string} and {@link number}: the end, or -1.
   *
   * The regex backtracks exponentially over the ways `\s*,?\s*` can split
   * the spaces between items, but only the longest split can be followed by
   * an item or `]`. What remains is a choice for block strings: the regex
   * tries each later `"""` as the end of one, in order, until the rest of the
   * list matches. So, right to left over the document:
   * - `item[j]`: where a list whose next item starts at `j` ends, or -1;
   * - `close[j]`: the same for the first `"""` at or after `j` that ends a
   *   block string the rest of the list can follow, or -1.
   */
  listAt(i: number): number {
    const item = (this.list ??= this.fillList());
    const j = this.space[i + 1]!;
    return j < this.doc.length ? item[j]! : -1;
  }

  private fillList(): Int32Array {
    const { doc, space } = this;
    const n = doc.length;
    const item = new Int32Array(n + 1).fill(-1);
    const close = new Int32Array(n + 4).fill(-1);
    // After an item that ends at `e`: the separator, then `]` or another item.
    const after = (e: number): number => {
      let s = space[e]!;
      if (doc.charCodeAt(s) === 44) s = space[s + 1]!;
      if (s >= n) return -1;
      return doc.charCodeAt(s) === 93 ? s + 1 : item[s]!;
    };
    for (let j = n - 1; j >= 0; j--) {
      const c = doc.charCodeAt(j);
      const triple = this.triple(j);
      if (triple) item[j] = close[j + 3]!;
      else if (c === 34) {
        const e = this.string(j);
        item[j] = e < 0 ? -1 : after(e);
      } else if (c === 45 || isDigitCode(c)) {
        const e = this.number(j);
        item[j] = e < 0 ? -1 : after(e);
      }
      const end = triple ? after(j + 3) : -1;
      close[j] = end >= 0 ? end : close[j + 1]!;
    }
    return item;
  }
}

/** A match of {@link graphqlLiftMatches}: the whole match, the argument name, the separator and the literal. */
export type GraphqlLift = [string, string | undefined, string | undefined, string | undefined] & { index: number };

/**
 * The matches of the regex model.ts used to read literals with (GQL_LIFT),
 * `/#[^\n]*|"""[\s\S]*?"""|"(?:[^"\\\n]|\\.)*"|\b([A-Za-z_][A-Za-z0-9_]*)(\s*:\s*)(STRING|NUMBER|\[\s*(?:(?:STRING|NUMBER)\s*,?\s*)+\])/g`
 * with STRING = `"""[\s\S]*?"""|"(?:[^"\\\n]|\\.)*"(?!")` and NUMBER = `-?\d+(?:\.\d+)?(?![\w.])`:
 * comments, strings, and arguments with a literal value.
 */
export function* graphqlLiftMatches(doc: string): Generator<GraphqlLift> {
  const t = new GraphqlTables(doc);
  const n = doc.length;
  const match = (index: number, end: number, arg?: string, sep?: string, lit?: string): GraphqlLift =>
    Object.assign([doc.slice(index, end), arg, sep, lit] as GraphqlLift, { index });
  for (let p = 0; p < n; ) {
    const c = doc.charCodeAt(p);
    if (c === 35) {
      const nl = doc.indexOf("\n", p);
      const end = nl < 0 ? n : nl;
      yield match(p, end);
      p = end;
      continue;
    }
    if (c === 34) {
      const block = t.triple(p) ? t.block(p) : -1;
      const end = block >= 0 ? block : t.body[p + 1]!;
      if (end >= 0) {
        yield match(p, end);
        p = end;
      } else p++;
      continue;
    }
    // `\b` before a letter: the start of a name.
    if (isWordCode(c) && !isDigitCode(c) && (p === 0 || !isWordCode(doc.charCodeAt(p - 1)))) {
      let q = p + 1;
      while (q < n && isWordCode(doc.charCodeAt(q))) q++;
      const colon = t.space[q]!;
      if (doc.charCodeAt(colon) === 58) {
        const b = t.space[colon + 1]!;
        const l = doc.charCodeAt(b);
        const end =
          l === 34 ? (t.triple(b) ? t.block(b) : t.string(b)) : l === 91 ? t.listAt(b) : l === 45 || isDigitCode(l) ? t.number(b) : -1;
        if (end >= 0) {
          yield match(p, end, doc.slice(p, q), doc.slice(q, b), doc.slice(b, end));
          p = end;
          continue;
        }
      }
      // No literal follows: nothing matches inside the name either.
      p = q;
      continue;
    }
    p++;
  }
}

/**
 * The matches of `/"""[\s\S]*?"""|"(?:[^"\\\n]|\\.)*"(?!")|-?\d+(?:\.\d+)?(?![\w.])/g`:
 * the items of a list literal, as `[start, end]`.
 */
export function* graphqlListItems(lit: string): Generator<[number, number]> {
  const t = new GraphqlTables(lit);
  for (let p = 0; p < lit.length; ) {
    const c = lit.charCodeAt(p);
    const end = c === 34 ? (t.triple(p) ? t.block(p) : t.string(p)) : c === 45 || isDigitCode(c) ? t.number(p) : -1;
    if (end >= 0) {
      yield [p, end];
      p = end;
    } else p++;
  }
}

/** The characters `[^\s@"'<>,;]` matches (without the u flag). */
const isEmailCode = (c: number) => !isSpaceCode(c) && c !== 64 && c !== 34 && c !== 39 && c !== 60 && c !== 62 && c !== 44 && c !== 59;
const isAsciiLetterCode = (c: number) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122);

/**
 * `text.replace(/[^\s@"'<>,;]+@[^\s@"'<>,;]+\.[A-Za-z]{2,}/g, replacement)`.
 * The regex tried every start inside a run of the class and scanned to its end
 * each time (128 KB of one run: 26 s in the mock). Here a run is read once:
 * every start in it ends at the same place, so they all match or all fail.
 * - The local part can't backtrack: `@` is outside the class, so it is the
 *   whole rest of the run and the run must end in `@`.
 * - After the `@`, the greedy domain gives back characters until `\.` and two
 *   letters follow: the last `.` in the domain's run with two letters after it
 *   and at least one character before it. The letters then run as far as they go.
 * - If there is no such `.`, the next start the regex tries is just after the `@`.
 */
export function replaceEmails(text: string, replacement: string): string {
  const n = text.length;
  let out = "";
  let copied = 0;
  let i = 0;
  while (i < n) {
    if (!isEmailCode(text.charCodeAt(i))) {
      i++;
      continue;
    }
    let at = i;
    while (at < n && isEmailCode(text.charCodeAt(at))) at++;
    if (at >= n || text.charCodeAt(at) !== 64) {
      i = at;
      continue;
    }
    const domain = at + 1;
    let domainEnd = domain;
    while (domainEnd < n && isEmailCode(text.charCodeAt(domainEnd))) domainEnd++;
    let dot = -1;
    for (let j = domainEnd - 3; j > domain; j--) {
      if (text.charCodeAt(j) === 46 && isAsciiLetterCode(text.charCodeAt(j + 1)) && isAsciiLetterCode(text.charCodeAt(j + 2))) {
        dot = j;
        break;
      }
    }
    if (dot < 0) {
      i = domain;
      continue;
    }
    let end = dot + 1;
    while (end < n && isAsciiLetterCode(text.charCodeAt(end))) end++;
    out += text.slice(copied, i) + replacement;
    copied = end;
    i = end;
  }
  return copied === 0 ? text : out + text.slice(copied);
}

/** `[^\s?#"'<>]` (a URL before its query) and `[^\s"'<>]` (the query or fragment). */
const isUrlTailCode = (c: number) => !isSpaceCode(c) && c !== 34 && c !== 39 && c !== 60 && c !== 62;
const isUrlCode = (c: number) => isUrlTailCode(c) && c !== 63 && c !== 35;

/**
 * `text.replace(/(https?:\/\/[^\s?#"'<>]+)[?#][^\s"'<>]*\/gi, "$1")`: URLs
 * without their query string and fragment. The regex scanned to the end of
 * the run after every `http://` in it ("http://ahttp://a…" 256 KB: 7 s).
 * The run after `://` can't give anything back (`?` and `#` are outside its
 * class), so it must end in `?` or `#`; if it doesn't, no `http://` inside it
 * can match either, and the search resumes where the run ends.
 */
export function stripUrlQueries(text: string): string {
  const scheme = /https?:\/\//gi;
  const n = text.length;
  let out = "";
  let copied = 0;
  for (let m = scheme.exec(text); m; m = scheme.exec(text)) {
    const start = m.index + m[0].length;
    let q = start;
    while (q < n && isUrlCode(text.charCodeAt(q))) q++;
    const c = text.charCodeAt(q);
    if (q > start && (c === 63 || c === 35)) {
      let end = q + 1;
      while (end < n && isUrlTailCode(text.charCodeAt(end))) end++;
      out += text.slice(copied, q);
      copied = end;
      scheme.lastIndex = end;
    } else scheme.lastIndex = Math.max(q, m.index + 1);
  }
  return copied === 0 ? text : out + text.slice(copied);
}
