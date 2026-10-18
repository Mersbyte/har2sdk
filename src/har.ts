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
}

export type Body =
  /** `raw` is empty: the parsed value is kept, not the text too (halves memory on large captures). */
  | { kind: "json"; value: unknown; raw: string; mimeType: string }
  /** JSON by content type, but the body wasn't recorded (DevTools often drops large ones). */
  | { kind: "missing"; mimeType: string }
  /** JSON by content type, but it doesn't parse (truncated or not really JSON). */
  | { kind: "unparsed"; raw: string; mimeType: string }
  | { kind: "form"; fields: [string, string][]; raw: string; mimeType: string }
  | { kind: "multipart"; mimeType: string }
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
  return out;
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
      requestBody: entry.request.postData ? parseRequestBody(entry.request.postData, reqMime) : undefined,
      status: Number(entry.response.status) || 0,
      responseHeaders,
      responseBody: entry.response.content ? parseResponseBody(entry.response.content, resMime) : undefined,
      resourceType: entry._resourceType,
      startedAt: entry.startedDateTime,
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
  scanner.end();
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

  end(): void {
    if (this.first) throw invalidJson();
    if (this.inString || this.capturing) throw invalidJson();
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
  if (mimeType.startsWith("multipart/")) return { kind: "multipart", mimeType };
  if (mimeType.includes("application/x-www-form-urlencoded")) {
    const fields: [string, string][] = [];
    if (pd.params?.length) {
      for (const p of pd.params) fields.push([p.name, safeDecode(p.value ?? "")]);
    } else {
      new URLSearchParams(text).forEach((v, k) => fields.push([k, v]));
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
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s.replace(/\+/g, " "));
  } catch {
    return s;
  }
}

export function isObject(v: unknown): v is Record<string, any> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
