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

/** `s.replace(/"(?:[^"\\\n]|\\.)*"/g, fn)`. */
export function replaceQuoted(s: string, fn: (quoted: string) => string): string {
  let out = "";
  let last = 0;
  for (const [start, end] of quotedStrings(s)) {
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

const GQL_LITERAL = /#[^\n]*|(?:\b([A-Za-z_]\w*)\s*:\s*)?(?:(""")|"|(?<![\w$.])(-?\d{6,})(?![\w.]))/g;

/** A match of {@link graphqlLiteralMatches}: the whole match and its four groups. */
export type GraphqlLiteral = [string, string | undefined, string | undefined, string | undefined, string | undefined] & { index: number };

/**
 * The matches of
 * `/#[^\n]*|(?:\b([A-Za-z_]\w*)\s*:\s*)?(?:"""([\s\S]*?)"""|"((?:[^"\\\n]|\\.)*)"|(?<![\w$.])(-?\d{6,})(?![\w.]))/g`:
 * comments, and string and long number literals with the argument name before them.
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
