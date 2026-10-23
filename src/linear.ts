/**
 * Linear-time replacements for regexes that CodeQL flagged as polynomial. All
 * but withoutQueryOrHash backtracked quadratically on crafted input. Each
 * function returns exactly what the regex in its comment returns;
 * test/review9.test.ts compares them on generated input.
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
