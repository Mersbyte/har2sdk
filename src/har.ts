/**
 * HAR (HTTP Archive) parsing and normalisation.
 *
 * Browsers export HAR 1.2 from DevTools ("Save all as HAR"). We accept the
 * standard `{ log: { entries } }` shape, a bare `{ entries }` object, or a raw
 * array of entries, and turn each entry into a normalised {@link Exchange}.
 */

export interface HarNameValue {
  name: string;
  value?: string;
}

export interface HarPostData {
  mimeType?: string;
  text?: string;
  params?: HarNameValue[];
}

export interface HarContent {
  mimeType?: string;
  text?: string;
  encoding?: string;
  size?: number;
}

export interface HarEntry {
  startedDateTime?: string;
  request: {
    method: string;
    url: string;
    headers?: HarNameValue[];
    queryString?: HarNameValue[];
    postData?: HarPostData;
  };
  response: {
    status: number;
    headers?: HarNameValue[];
    content?: HarContent;
  };
  /** Chrome-specific: "xhr", "fetch", "script", "image", ... */
  _resourceType?: string;
  /** Chrome-specific: the frames of a WebSocket connection. */
  _webSocketMessages?: { type?: string; opcode?: number; data?: string }[];
}

export type Body =
  /** `raw` is empty: the parsed value is kept, not the text too (halves memory on large captures). */
  | { kind: "json"; value: unknown; raw: string; mimeType: string }
  /** JSON by content type, but the body wasn't recorded (DevTools often drops large ones). */
  | { kind: "missing"; mimeType: string }
  /** JSON by content type, but it doesn't parse (truncated or not really JSON). */
  | { kind: "unparsed"; raw: string; mimeType: string }
  | { kind: "form"; fields: [string, string][]; raw: string; mimeType: string }
  /** `fields`: the parts that aren't files, read by the leak guard only. */
  | { kind: "multipart"; mimeType: string; fields?: [string, string][] }
  | { kind: "text"; raw: string; mimeType: string }
  | { kind: "binary"; mimeType: string };

/** One request/response pair, normalised. Header names are lower-cased. */
export interface Exchange {
  index: number;
  method: string;
  url: URL;
  origin: string;
  host: string;
  pathname: string;
  query: [string, string][];
  requestHeaders: Map<string, string>;
  requestBody?: Body;
  status: number;
  responseHeaders: Map<string, string>;
  responseBody?: Body;
  resourceType?: string;
  startedAt?: string;
  /**
   * Text the HAR stores that nothing else models (WebSocket frames, NDJSON / JSON-seq bodies).
   * Only the leak guard reads it, as evidence of which values are data.
   */
  evidence?: string[];
}

export class HarError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HarError";
  }
}

export function parseHarText(text: string): HarEntry[] {
  let data: unknown;
  try {
    data = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch (err) {
    const t = text.trimEnd();
    if (/^\s*[[{]/.test(text) && !/[}\]]$/.test(t)) throw truncated(0);
    throw new HarError(
      // Don't echo the parser's message: it quotes the file's first characters.
      `This file is not valid JSON, so it can't be a HAR file. ` +
        `In Chrome DevTools open the Network tab, right-click any request and choose "Save all as HAR".`,
    );
  }
  let entries: unknown;
  if (Array.isArray(data)) entries = data;
  else if (isObject(data) && isObject(data.log) && Array.isArray(data.log.entries)) entries = data.log.entries;
  else if (isObject(data) && Array.isArray(data.entries)) entries = data.entries;
  else throw new HarError(`No "log.entries" array found. Is this a HAR export from the browser's Network tab?`);

  const out: HarEntry[] = [];
  for (const e of entries as unknown[]) {
    if (!isObject(e) || !isObject(e.request) || !isObject(e.response)) continue;
    if (typeof e.request.url !== "string" || typeof e.request.method !== "string") continue;
    out.push(e as unknown as HarEntry);
  }
  checkEntries((entries as unknown[]).length, out.length);
  return out;
}

/** An empty capture, or entries none of which is a request/response pair, is an error worth explaining. */
function checkEntries(total: number, valid: number): void {
  if (total === 0) throw new HarError(`The capture has no requests (its entries array is empty). Turn on "Preserve log" in the Network tab, use the app, then export again.`);
  if (valid === 0) {
    throw new HarError(
      `None of the ${total} entries is a request/response pair (each needs request.method, request.url and response). Is this a HAR export from the browser's Network tab?`,
    );
  }
}

function truncated(entries: number): HarError {
  return new HarError(
    `The file is cut off before its end (${entries} entr${entries === 1 ? "y" : "ies"} read): the export or the download didn't finish. Export the HAR again.`,
  );
}

export function normaliseEntries(entries: HarEntry[]): Exchange[] {
  const out: Exchange[] = [];
  entries.forEach((entry, index) => {
    let url: URL;
    try {
      url = new URL(entry.request.url);
    } catch {
      return;
    }
    const requestHeaders = headerMap(entry.request.headers);
    const responseHeaders = headerMap(entry.response.headers);
    const query: [string, string][] = [];
    url.searchParams.forEach((value, name) => query.push([name, value]));

    const reqMime = entry.request.postData?.mimeType || requestHeaders.get("content-type") || "";
    const resMime = entry.response.content?.mimeType || responseHeaders.get("content-type") || "";

    out.push({
      index,
      method: entry.request.method.toUpperCase(),
      url,
      origin: url.origin,
      host: url.host,
      pathname: url.pathname,
      query,
      requestHeaders,
      requestBody: entry.request.postData ? parseRequestBody(entry.request.postData, reqMime) : missingRequestBody(requestHeaders),
      status: Number(entry.response.status) || 0,
      responseHeaders,
      responseBody: entry.response.content ? parseResponseBody(entry.response.content, resMime) : undefined,
      resourceType: entry._resourceType,
      startedAt: entry.startedDateTime,
      ...withEvidence(entry, reqMime, resMime),
    });
  });
  return out;
}

export function loadHar(text: string): Exchange[] {
  return normaliseEntries(parseHarText(text));
}

/**
 * Read a HAR file as a stream: entries are parsed one at a time, so neither
 * the file's text nor the whole JSON tree is ever held in memory — only the
 * normalised exchanges. Accepts the same shapes as {@link parseHarText}.
 */
export async function loadHarFile(path: string, chunkSize = 1 << 20): Promise<Exchange[]> {
  const { createReadStream } = await import("node:fs");
  const out: Exchange[] = [];
  let index = 0;
  const scanner = new EntryScanner((json) => {
    let entry: unknown;
    try {
      entry = JSON.parse(json);
    } catch {
      throw invalidJson();
    }
    if (!isObject(entry) || !isObject(entry.request) || !isObject(entry.response)) return;
    if (typeof entry.request.url !== "string" || typeof entry.request.method !== "string") return;
    // Same numbering as loadHar: valid entries count, even when their URL doesn't parse.
    const i = index++;
    const ex = normaliseEntries([entry as unknown as HarEntry])[0];
    if (ex) out.push({ ...ex, index: i });
  });
  const stream = createReadStream(path, { encoding: "utf8", highWaterMark: chunkSize });
  for await (const chunk of stream) scanner.write(chunk as string);
  scanner.end(index);
  checkEntries(scanner.elements, index);
  return out;
}

function invalidJson(): HarError {
  // Don't echo the parser's message: it quotes the file's content.
  return new HarError(
    `This file is not valid JSON, so it can't be a HAR file. ` + `In Chrome DevTools open the Network tab, right-click any request and choose "Save all as HAR".`,
  );
}

const STRING_BODY = /[^"\\]*(?:\\[\s\S][^"\\]*)*/y;

/**
 * A minimal streaming JSON scanner that finds the entries array — the root
 * array, `{ entries: [...] }` or `{ log: { entries: [...] } }` — and hands
 * each element's JSON text to a callback. Strings are skipped with indexOf,
 * in one regex step each.
 */
class EntryScanner {
  private stack: string[] = [];
  private inString = false;
  private escaped = false;
  /** The last string seen at object level (a candidate key), capped. */
  private lastString = "";
  private stringStart = -1;
  private pendingKey: string | undefined;
  private keys: (string | undefined)[] = [];
  private entriesDepth = -1;
  private parts: string[] = [];
  private capturing = false;
  private first = true;
  private found = false;
  /** Elements of the entries array, whatever they are (objects or not). */
  elements = 0;
  private inElement = false;

  constructor(private readonly onEntry: (json: string) => void) {}

  write(chunk: string): void {
    let i = 0;
    if (this.first) {
      if (chunk.charCodeAt(0) === 0xfeff) i = 1;
      const t = chunk.slice(i).trimStart();
      if (!t) return;
      if (t[0] !== "{" && t[0] !== "[") throw invalidJson();
      this.first = false;
    }
    let captureFrom = this.capturing ? 0 : -1;
    const n = chunk.length;
    while (i < n) {
      if (this.inString) {
        if (this.escaped) {
          this.escaped = false;
          i++;
          continue;
        }
        // The rest of the string in one regex step: plain characters and escape pairs.
        STRING_BODY.lastIndex = i;
        STRING_BODY.exec(chunk);
        const j = STRING_BODY.lastIndex;
        this.collectString(chunk, i, j);
        if (j < n && chunk[j] === '"') {
          this.inString = false;
          i = j + 1;
          continue;
        }
        // The chunk ends inside the string, maybe right after a backslash.
        if (j < n) this.escaped = true;
        i = n;
        break;
      }
      const c = chunk[i]!;
      // Count the entries array's elements: the first character of each one.
      if (this.entriesDepth > 0 && !this.capturing && this.stack.length === this.entriesDepth) {
        if (c === ",") this.inElement = false;
        else if (!this.inElement && c !== "]" && c !== " " && c !== "\n" && c !== "\r" && c !== "\t") {
          this.elements++;
          this.inElement = true;
        }
      }
      if (c === '"') {
        this.inString = true;
        this.lastString = "";
        this.stringStart = 0;
        i++;
        continue;
      }
      if (c === ":") {
        if (this.stack[this.stack.length - 1] === "{") this.pendingKey = this.lastString;
      } else if (c === "{" || c === "[") {
        const depth = this.stack.length;
        if (!this.capturing && this.entriesDepth !== -1 && depth === this.entriesDepth && c === "{") {
          this.capturing = true;
          captureFrom = i;
        }
        this.keys.push(this.pendingKey);
        this.stack.push(c);
        if (c === "[" && this.entriesDepth === -1 && !this.capturing && this.isEntries()) {
          this.entriesDepth = this.stack.length;
          this.found = true;
        }
        this.pendingKey = undefined;
      } else if (c === "}" || c === "]") {
        this.stack.pop();
        this.keys.pop();
        if (this.capturing && this.stack.length === this.entriesDepth) {
          this.parts.push(chunk.slice(captureFrom, i + 1));
          const json = this.parts.join("");
          this.parts = [];
          this.capturing = false;
          captureFrom = -1;
          this.onEntry(json);
        } else if (c === "]" && this.stack.length === this.entriesDepth - 1) {
          this.entriesDepth = -2; // done: ignore any later arrays
        }
      } else if (c === ",") {
        this.pendingKey = undefined;
      }
      i++;
    }
    if (this.capturing && captureFrom !== -1) this.parts.push(chunk.slice(captureFrom));
  }

  /** @param read the entries handed out so far (for the message when the file is cut off). */
  end(read = 0): void {
    if (this.first) throw invalidJson();
    if (this.inString || this.capturing || this.stack.length) throw truncated(read);
    if (!this.found) throw new HarError(`No "log.entries" array found. Is this a HAR export from the browser's Network tab?`);
  }

  private collectString(chunk: string, from: number, to: number): void {
    // Only short strings can be keys we care about ("log", "entries").
    if (this.stringStart !== -1 && this.lastString.length < 16) this.lastString += chunk.slice(from, Math.min(to, from + 16));
  }

  private isEntries(): boolean {
    const depth = this.stack.length;
    if (depth === 1) return true; // a bare array of entries
    const key = this.keys[depth - 1];
    if (key !== "entries") return false;
    if (depth === 2) return true; // { entries: [...] }
    return depth === 3 && this.keys[1] === "log"; // { log: { entries: [...] } }
  }
}

/** Combine several captures into one list (indices stay unique). */
export function mergeExchanges(lists: Exchange[][]): Exchange[] {
  const out: Exchange[] = [];
  for (const list of lists) for (const ex of list) out.push({ ...ex, index: out.length });
  return out;
}

function headerMap(headers: HarNameValue[] | undefined): Map<string, string> {
  const m = new Map<string, string>();
  for (const h of headers ?? []) {
    if (!h || typeof h.name !== "string") continue;
    const name = h.name.toLowerCase();
    // HTTP/2 pseudo headers (":authority", ":path") are noise for our purposes.
    if (name.startsWith(":")) continue;
    const value = String(h.value ?? "");
    const prev = m.get(name);
    m.set(name, prev === undefined ? value : name === "cookie" ? `${prev}; ${value}` : `${prev}, ${value}`);
  }
  return m;
}

export function isJsonMime(mime: string): boolean {
  const m = mime.toLowerCase();
  return /[/+]json\b/.test(m) || m.includes("application/graphql-response");
}

/**
 * A request the headers say had a body the HAR doesn't contain: browsers leave
 * out multipart uploads (files), and some exporters every body.
 */
function missingRequestBody(headers: Map<string, string>): Body | undefined {
  const mimeType = (headers.get("content-type") ?? "").toLowerCase();
  const length = Number(headers.get("content-length") ?? "");
  if (!mimeType || !(length > 0 || mimeType.startsWith("multipart/"))) return undefined;
  return { kind: "missing", mimeType };
}

function parseRequestBody(pd: HarPostData, mimeHeader: string): Body | undefined {
  const mimeType = (pd.mimeType || mimeHeader || "").toLowerCase();
  let text = pd.text ?? "";
  // Not in the HAR spec, but Charles / Proxyman / some exporters base64 the body.
  if ((pd as { encoding?: string }).encoding === "base64" && text) {
    try {
      text = decodeBytes(Buffer.from(text, "base64"), mimeType);
    } catch {
      /* leave as is */
    }
  }
  if (mimeType.startsWith("multipart/")) return { kind: "multipart", mimeType, fields: multipartFields(text, pd.mimeType || mimeHeader || "") }; // the boundary is case-sensitive
  if (mimeType.includes("application/x-www-form-urlencoded")) {
    const fields: [string, string][] = [];
    if (text) {
      // The body text is the one encoding every exporter agrees on.
      new URLSearchParams(text).forEach((v, k) => fields.push([k, v]));
    } else if (pd.params?.length) {
      // Chromium stores `params` already decoded, Firefox percent-encoded: decode only what is still
      // encoded, and never turn "+" into a space (zk+work@corp.example stays an email).
      for (const p of pd.params) fields.push([String(p.name ?? ""), decodeOnce(String(p.value ?? ""))]);
    }
    return { kind: "form", fields, raw: text, mimeType };
  }
  if (!text) return undefined;
  const json = tryJson(text);
  if (json.ok && (isJsonMime(mimeType) || mimeType === "" || mimeType.startsWith("text/plain"))) {
    return { kind: "json", value: json.value, raw: "", mimeType: mimeType || "application/json" };
  }
  return { kind: "text", raw: text, mimeType: mimeType || "text/plain" };
}

function parseResponseBody(content: HarContent, mimeHeader: string): Body | undefined {
  const mimeType = (content.mimeType || mimeHeader || "").toLowerCase();
  if (content.text === undefined || content.text === null) return isJsonMime(mimeType) ? { kind: "missing", mimeType } : undefined;
  let text: string = content.text;
  // An empty body is no body, whatever the encoding: Playwright stores a 204 the page
  // read as `text: "", encoding: "base64"` with no content type.
  if (text === "") return undefined;
  if (content.encoding === "base64") {
    if (!isTextual(mimeType)) return { kind: "binary", mimeType };
    try {
      text = decodeBytes(Buffer.from(text, "base64"), mimeType);
    } catch {
      return { kind: "binary", mimeType };
    }
  }
  text = text.replace(/^\uFEFF/, "");
  if (text === "") return undefined;
  const looksJson = /^\s*[[{]/.test(stripXssiPrefix(text));
  if (isJsonMime(mimeType) || ((mimeType === "" || mimeType.startsWith("text/plain")) && looksJson)) {
    const json = tryJson(stripXssiPrefix(text));
    if (json.ok) return { kind: "json", value: json.value, raw: "", mimeType: mimeType || "application/json" };
    if (isJsonMime(mimeType)) return { kind: "unparsed", raw: text, mimeType };
  }
  if (isTextual(mimeType)) return { kind: "text", raw: text, mimeType };
  return { kind: "binary", mimeType };
}

/** Decode bytes with the charset the response declared (windows-1254, Shift_JIS, …). */
function decodeBytes(bytes: Uint8Array, mimeType: string): string {
  const charset = mimeType.match(/charset=["']?([\w.:-]+)/i)?.[1];
  if (charset) {
    try {
      return new TextDecoder(charset).decode(bytes);
    } catch {
      /* unknown label: fall back to UTF-8 */
    }
  }
  return new TextDecoder("utf-8").decode(bytes);
}

/** Some APIs (Google, Facebook) prefix JSON with `)]}'` to defeat XSSI. */
function stripXssiPrefix(text: string): string {
  return text.replace(/^\s*\)\]\}'[^\n]*\n/, "").replace(/^\s*for\s*\(;;\);/, "");
}

function isTextual(mime: string): boolean {
  return mime === "" || mime.startsWith("text/") || isJsonMime(mime) || /xml|javascript|graphql|x-www-form-urlencoded/.test(mime);
}

function tryJson(text: string): { ok: true; value: unknown } | { ok: false } {
  const value = parseJson(text);
  return value === NOT_JSON ? { ok: false } : { ok: true, value };
}

/**
 * JSON nested deeper than this is treated as not JSON: everything that walks a
 * body (shapes, taint, the scrubber) recurses, and real APIs stay far below it.
 */
export const MAX_JSON_DEPTH = 200;

export const NOT_JSON: unique symbol = Symbol("not JSON");

/** `JSON.parse`, or NOT_JSON for invalid text and text nested deeper than MAX_JSON_DEPTH. */
export function parseJson(text: string): unknown {
  if (jsonDepth(text) > MAX_JSON_DEPTH) return NOT_JSON;
  try {
    return JSON.parse(text);
  } catch {
    return NOT_JSON;
  }
}

/** The deepest nesting of brackets outside strings, counted without recursion (stops past the limit). */
function jsonDepth(text: string): number {
  let depth = 0;
  let max = 0;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (inString) {
      if (c === 92) i++; // backslash: skip the escaped character
      else if (c === 34) inString = false;
    } else if (c === 34) inString = true;
    else if (c === 91 || c === 123) {
      if (++depth > max) max = depth;
      if (max > MAX_JSON_DEPTH) return max;
    } else if (c === 93 || c === 125) depth--;
  }
  return max;
}

/** Percent-decode a value that is still encoded; leave a decoded one (and "+") alone. */
function decodeOnce(s: string): string {
  if (!/%[0-9A-Fa-f]{2}/.test(s)) return s;
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

const MAX_EVIDENCE_PARTS = 2000;
const MAX_EVIDENCE_CHARS = 200_000;
/** At most this much evidence text per entry (a long WebSocket session can hold far more). */
const MAX_EVIDENCE_TOTAL = 2_000_000;

/** The non-file parts of a multipart body ("--B\r\nContent-Disposition: form-data; name=\"x\"\r\n\r\nvalue"). */
function multipartFields(text: string, mimeType: string): [string, string][] {
  const boundary = mimeType.match(/boundary=(?:"([^"]+)"|([^;\s]+))/i);
  const b = boundary?.[1] ?? boundary?.[2];
  if (!b || !text) return [];
  const out: [string, string][] = [];
  for (const part of text.slice(0, 4 * MAX_EVIDENCE_CHARS).split("--" + b)) {
    if (out.length >= MAX_EVIDENCE_PARTS) break;
    const sep = part.search(/\r?\n\r?\n/);
    if (sep < 0) continue;
    const head = part.slice(0, sep);
    const name = head.match(/\bname="([^"]*)"/i)?.[1];
    if (name === undefined || /\bfilename\*?=/i.test(head)) continue;
    const value = part.slice(sep).replace(/^\r?\n\r?\n/, "").replace(/\r?\n$/, "");
    out.push([name, value.slice(0, MAX_EVIDENCE_CHARS)]);
  }
  return out;
}

/** NDJSON, JSON Lines and JSON text sequences: text the body parser files as binary. */
const LINE_JSON_MIME = /ndjson|jsonl|json-seq|jsonlines/;

function withEvidence(entry: HarEntry, reqMime: string, resMime: string): { evidence?: string[] } {
  const out: string[] = [];
  let budget = MAX_EVIDENCE_TOTAL;
  const push = (t: unknown) => {
    if (typeof t !== "string" || !t || out.length >= MAX_EVIDENCE_PARTS || budget <= 0) return;
    const kept = t.slice(0, Math.min(MAX_EVIDENCE_CHARS, budget));
    budget -= kept.length;
    out.push(kept);
  };
  const content = entry.response.content;
  if (content && LINE_JSON_MIME.test(resMime.toLowerCase()) && typeof content.text === "string") {
    let text = content.text;
    if (content.encoding === "base64") {
      try {
        text = decodeBytes(Buffer.from(text, "base64"), resMime);
      } catch {
        text = "";
      }
    }
    push(text);
  }
  if (LINE_JSON_MIME.test(reqMime.toLowerCase())) push(entry.request.postData?.text);
  const frames = entry._webSocketMessages;
  if (Array.isArray(frames)) {
    for (const f of frames) {
      // Text frames only (opcode 1); binary frames are base64 in the HAR.
      if (f && typeof f === "object" && (f.opcode === undefined || f.opcode === 1)) push(f.data);
    }
  }
  return out.length ? { evidence: out } : {};
}

export function isObject(v: unknown): v is Record<string, any> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
