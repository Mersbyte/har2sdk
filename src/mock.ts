/**
 * A mock server that replays recorded responses, matched by endpoint template.
 * Point the generated SDK (or your frontend) at it to develop offline.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Exchange } from "./har.js";
import { graphqlRootFields, normalizeGraphQL, splitUnits, withoutFragments, type ApiModel, type Endpoint } from "./model.js";
import { csvRows, mapTextFields, scrubberFor, scrubText, type Taint } from "./leak.js";
import { redactFreeText, Scrubber } from "./redact.js";
import { splitPath, tokenMatches } from "./template.js";

export interface MockOptions {
  /**
   * Serve the recorded bodies unscrubbed (JSON re-serialised). By default responses are scrubbed:
   * identifiers become consistent fakes of the same shape, vocabulary, dates
   * and numbers stay, and names, free text, emails, secrets and URL query
   * strings are masked — the mock never hands out what it was recorded with.
   */
  raw?: boolean;
  /**
   * Host names the server answers to. Default: localhost, 127.0.0.1, [::1].
   * Any other Host header gets 403, which stops DNS-rebinding pages from
   * reading the recorded data through a name that resolves to 127.0.0.1.
   */
  allowHosts?: string[];
  /** @deprecated redaction is now the default; use `raw: true` to turn it off. */
  redact?: boolean;
  /** Extra origins allowed by CORS (localhost and the recorded origins always are). */
  allowOrigins?: string[];
  /** Artificial latency in ms. */
  delay?: number;
  /** Called for every request (for logging). */
  onRequest?: (info: { method: string; path: string; status: number; endpoint?: string }) => void;
}

interface Candidate {
  ep: Endpoint;
  samples: Exchange[];
  literals: number;
}

export function createMockServer(model: ApiModel, exchanges: Exchange[], opts: MockOptions = {}): Server {
  const byIndex = new Map(exchanges.map((e) => [e.index, e]));
  const candidates: Candidate[] = model.endpoints.map((ep) => ({
    ep,
    samples: ep.samples.map((i) => byIndex.get(i)).filter((e): e is Exchange => !!e),
    literals: ep.tokens.filter((t) => t.kind === "literal").length,
  }));
  candidates.sort((a, b) => b.literals - a.literals);
  const redact = opts.raw ? false : (opts.redact ?? true);
  const trusted = new Set([...model.origins.map((o) => o.origin), ...(opts.allowOrigins ?? [])]);
  const allowed = (origin: string) => trusted.has(origin) || /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin);
  const scrubber = scrubberFor(model.taint);
  const clean = (v: unknown) => (redact ? scrubber.json(v) : v);
  const hosts = new Set(["localhost", "127.0.0.1", "[::1]", "::1", ...(opts.allowHosts ?? []).map((h) => h.toLowerCase())]);

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const host = (req.headers.host ?? "").toLowerCase().replace(/:\d+$/, "");
    if (req.headers.host !== undefined && !hosts.has("*") && !hosts.has(host)) {
      send(res, 403, "application/json", JSON.stringify({ error: "har2sdk mock: unexpected Host header (use localhost or 127.0.0.1, or --bind)" }));
      return;
    }
    // CORS only for local dev servers and the app's own origins — never reflect
    // arbitrary sites, or any page you visit could read the recorded data.
    const origin = typeof req.headers.origin === "string" ? req.headers.origin : undefined;
    if (origin && allowed(origin)) {
      res.setHeader("access-control-allow-origin", origin);
      res.setHeader("access-control-allow-credentials", "true");
      res.setHeader("access-control-allow-headers", req.headers["access-control-request-headers"] ?? "*");
      res.setHeader("access-control-allow-methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
      res.setHeader("access-control-expose-headers", "x-har2sdk-endpoint");
      res.setHeader("vary", "origin");
    }
    if (req.method === "OPTIONS") {
      res.writeHead(204).end();
      return;
    }
    const url = new URL(req.url ?? "/", "http://mock.local");
    const method = (req.method ?? "GET").toUpperCase();
    const body = method === "GET" || method === "HEAD" ? "" : await readBody(req);
    if (body === undefined) {
      send(res, 413, "application/json", JSON.stringify({ error: `har2sdk mock: request body over ${MAX_BODY / 1024 / 1024} MB` }));
      opts.onRequest?.({ method, path: url.pathname + url.search, status: 413 });
      return;
    }

    const rpc = answerRpc(candidates, method, url, body, clean);
    if (rpc) {
      if (opts.delay) await new Promise((r) => setTimeout(r, opts.delay));
      send(res, 200, "application/json", JSON.stringify(rpc.payload));
      opts.onRequest?.({ method, path: url.pathname + url.search, status: 200, endpoint: rpc.ids.join(", ") });
      return;
    }
    const gq = graphqlRequest(method, url, body);
    const segs = splitPath(url.pathname);
    const find = (op: GraphqlOp | undefined) => {
      const matches = candidates.filter((c) => {
        if (c.ep.rpc || c.ep.method !== method || c.ep.tokens.length !== segs.length) return false;
        if (c.ep.graphql && c.ep.graphql.operationName !== op?.name) return false;
        return c.ep.tokens.every((t, i) => tokenMatches(t, segs[i]));
      });
      // Same operation name, different documents: prefer the recording of this document.
      const docKey = op?.query ? normalizeGraphQL(op.query) : undefined;
      return matches.find((c) => !c.ep.graphql || !docKey || c.ep.graphql.docKey === docKey) ?? matches[0];
    };

    if (opts.delay) await new Promise((r) => setTimeout(r, opts.delay));

    // A batch of GraphQL operations gets a batch of results, one per operation.
    if (gq?.batch) {
      const found = gq.ops.map((op) => find(op));
      if (found.some((c) => c?.ep.graphql)) {
        const answers = found.map((c, i) => {
          const value = c?.ep.graphql ? recordedGraphql(c) : undefined;
          return value === undefined ? { errors: [{ message: `har2sdk mock: no recorded response for ${gq.ops[i]!.name ?? "this operation"}` }] } : clean(value);
        });
        res.setHeader("x-har2sdk-endpoint", headerSafe(found.map((c) => c?.ep.id ?? "-").join(", ")));
        send(res, 200, "application/json", JSON.stringify(answers));
        opts.onRequest?.({ method, path: url.pathname + url.search, status: 200, endpoint: found.map((c) => c?.ep.id ?? "-").join(", ") });
        return;
      }
    }
    const match = find(gq?.ops[0]);

    if (!match || !match.samples.length) {
      const status = 404;
      send(res, status, "application/json", JSON.stringify({ error: "har2sdk mock: no recorded response for this request", method, path: url.pathname }));
      opts.onRequest?.({ method, path: url.pathname + url.search, status });
      return;
    }

    const sample = pickSample(match.samples, url);

    res.setHeader("x-har2sdk-endpoint", headerSafe(match.ep.id));
    const rb = sample.responseBody;
    let payload = "";
    let contentType = sample.responseHeaders.get("content-type") ?? "application/octet-stream";
    if (rb?.kind === "json") {
      // GraphQL: this operation's own result, also when it was recorded inside a batch.
      const value = match.ep.graphql ? (recordedGraphql(match, sample) ?? rb.value) : rb.value;
      payload = JSON.stringify(redact ? clean(value) : value);
      if (!/json/.test(contentType)) contentType = "application/json";
    } else if (rb?.kind === "text" || rb?.kind === "unparsed") {
      payload = redact ? scrubTextBody(rb.raw, scrubber, model.taint) : rb.raw;
    }
    send(res, sample.status || 200, contentType, payload);
    opts.onRequest?.({ method, path: url.pathname + url.search, status: sample.status, endpoint: match.ep.id });
  };

  return createServer((req, res) => {
    // A request the mock can't answer must not take the server down.
    handle(req, res).catch(() => {
      if (!res.headersSent) send(res, 500, "application/json", JSON.stringify({ error: "har2sdk mock: internal error" }));
      else res.end();
    });
  });
}

/**
 * Best recorded sample for this request: same path first, then the most
 * matching query parameters (order-insensitive), then a successful status.
 */
function pickSample(samples: Exchange[], url: URL): Exchange {
  const wanted = new Map<string, string>();
  url.searchParams.forEach((v, k) => wanted.set(k, v));
  let best = samples[0]!;
  let bestScore = -Infinity;
  for (const s of samples) {
    let score = s.pathname === url.pathname ? 1000 : 0;
    for (const [k, v] of s.query) score += wanted.get(k) === v ? 10 : wanted.has(k) ? -5 : -1;
    if (s.status < 400) score += 1;
    if (score > bestScore) {
      best = s;
      bestScore = score;
    }
  }
  return best;
}

/** Recorded output of one RPC procedure (from any sample of its endpoint), with its superjson meta. */
function recordedOutput(c: Candidate): { output: unknown; meta?: Record<string, unknown> } {
  for (const ex of c.samples) {
    for (const u of splitUnits(ex)) if (u.rpc?.procedure === c.ep.rpc!.procedure && u.rpc.hasOutput) return { output: u.rpc.output, ...(u.rpc.outputMeta ? { meta: u.rpc.outputMeta } : {}) };
  }
  return { output: null };
}

function pathMatches(c: Candidate, segs: string[]): boolean {
  return c.ep.tokens.length === segs.length && c.ep.tokens.every((t, i) => tokenMatches(t, segs[i]));
}

/** Answer JSON-RPC (method in the body) and tRPC (procedure in the path) calls, batched or not. */
function answerRpc(candidates: Candidate[], method: string, url: URL, body: string, clean: (v: unknown) => unknown): { payload: unknown; ids: string[] } | undefined {
  const segs = splitPath(url.pathname);
  // JSON-RPC
  if (method === "POST" && body) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      parsed = undefined;
    }
    const calls = Array.isArray(parsed) ? parsed : [parsed];
    if (calls.length && calls.every((x) => x && typeof x === "object" && (x as any).jsonrpc === "2.0" && typeof (x as any).method === "string")) {
      const ids: string[] = [];
      const answers = calls.map((call: any) => {
        const c = candidates.find((k) => k.ep.rpc?.kind === "jsonrpc" && k.ep.rpc.procedure === call.method && pathMatches(k, segs));
        if (!c) return { jsonrpc: "2.0", id: call.id ?? null, error: { code: -32601, message: `har2sdk mock: no recording for ${call.method}` } };
        ids.push(c.ep.id);
        return { jsonrpc: "2.0", id: call.id ?? null, result: clean(recordedOutput(c).output) };
      });
      return { payload: Array.isArray(parsed) ? answers : answers[0], ids };
    }
  }
  // tRPC
  const last = segs[segs.length - 1];
  if (!last) return undefined;
  const base = segs.slice(0, -1);
  const procs = last.split(",");
  const found = procs.map((p) => candidates.find((k) => k.ep.rpc?.kind === "trpc" && k.ep.rpc.procedure === p && k.ep.method === method && pathMatches(k, base)));
  if (!found.every(Boolean)) return undefined;
  const answers = found.map((c) => {
    const { output, meta } = recordedOutput(c!);
    // superjson: the type annotations (Dates, Maps…) are structure, not data.
    return { result: { data: c!.ep.rpc!.superjson ? { json: clean(output), ...(meta ? { meta: { values: meta } } : {}) } : clean(output) } };
  });
  return { payload: url.searchParams.get("batch") === "1" ? answers : answers[0], ids: found.map((c) => c!.ep.id) };
}

export interface ListenOptions extends MockOptions {
  port?: number;
  /** Interface to bind. Defaults to 127.0.0.1 so recorded data isn't exposed to your network. */
  host?: string;
}

/** Create the mock server and start listening; resolves once it is accepting connections. */
export function listenMock(model: ApiModel, exchanges: Exchange[], opts: ListenOptions = {}): Promise<Server> {
  const server = createMockServer(model, exchanges, opts);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 4010, opts.host ?? "127.0.0.1", () => resolve(server));
  });
}

/** Header values must be Latin-1: percent-encode anything else (a path with "çağrı" in it). */
function headerSafe(v: string): string {
  return /^[\x20-\x7e]*$/.test(v) ? v : encodeURI(v);
}

function send(res: ServerResponse, status: number, contentType: string, payload: string): void {
  if (status === 204 || status === 304 || payload === "") {
    res.writeHead(status).end();
    return;
  }
  res.writeHead(status, { "content-type": contentType }).end(payload);
}

/** The largest request body the mock reads; a bigger one gets 413. */
const MAX_BODY = 10 * 1024 * 1024;

/**
 * The request body as text, or undefined if it is larger than MAX_BODY. A body
 * that is too large is still read to its end (and dropped, never kept): answering
 * while the client is still sending would reset the connection before it reads the 413.
 */
function readBody(req: IncomingMessage): Promise<string | undefined> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let over = Number(req.headers["content-length"] ?? 0) > MAX_BODY;
    req.on("data", (c: Buffer) => {
      if (over) return;
      size += c.length;
      if (size > MAX_BODY) {
        over = true;
        chunks.length = 0;
      } else chunks.push(c);
    });
    req.on("end", () => resolve(over ? undefined : Buffer.concat(chunks).toString("utf8")));
    req.on("error", () => resolve(""));
  });
}

interface GraphqlOp {
  name: string | undefined;
  query: string | undefined;
}

function graphqlRequest(method: string, url: URL, body: string): { ops: GraphqlOp[]; batch: boolean } | undefined {
  if (method === "GET") {
    const query = url.searchParams.get("query") ?? undefined;
    return { ops: [{ name: url.searchParams.get("operationName") ?? matchName(query ?? ""), query }], batch: false };
  }
  try {
    const parsed = JSON.parse(body);
    const list: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
    const ops = list
      .filter((x): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x))
      .map((x) => {
        const query = typeof x.query === "string" ? x.query : undefined;
        return { name: typeof x.operationName === "string" ? x.operationName : matchName(query ?? ""), query };
      });
    if (ops.length) return { ops, batch: Array.isArray(parsed) };
  } catch {
    /* not JSON */
  }
  return undefined;
}

/** The recorded result of this GraphQL operation (its own element when it was recorded in a batch). */
function recordedGraphql(c: Candidate, first?: Exchange): unknown {
  const g = c.ep.graphql!;
  for (const ex of first ? [first, ...c.samples] : c.samples) {
    for (const u of splitUnits(ex)) {
      if (u.gql?.operationName === g.operationName && u.gql.docKey === g.docKey && u.responseBody?.kind === "json") return u.responseBody.value;
    }
  }
  return undefined;
}

/** Same naming as the model: the operation name, or "{rootField,…}" for anonymous documents. */
function matchName(raw: string): string | undefined {
  if (!raw) return undefined;
  const query = withoutFragments(raw);
  const named = query.match(/^\s*(?:query|mutation|subscription)\s+([A-Za-z_][A-Za-z0-9_]*)/)?.[1];
  return named ?? `{${graphqlRootFields(query).join(",") || "anonymous"}}`;
}

/**
 * Text bodies get the same treatment as JSON: CSV cells by column, XML / HTML
 * text and attributes by tag or attribute name, values of truncated JSON by
 * key, and plain text line by line. Then the free-text rules run over the
 * result as a second net (emails, query strings, phone and card numbers).
 */
function scrubTextBody(raw: string, scrubber: Scrubber, taint: Taint): string {
  let out: string;
  if (csvRows(raw)) out = scrubText(scrubCsv(raw, scrubber), taint);
  else {
    const mapped = mapTextFields(raw, (v, k) => scrubber.json(v, k));
    out =
      mapped ??
      raw
        .split(/(\r?\n)/)
        .map((line) => (line.trim() && !/^\r?\n$/.test(line) ? line.match(/^\s*/)![0] + String(scrubber.json(line.trim())) : line))
        .join("");
  }
  return redactFreeText(out);
}

/** CSV bodies: every cell is scrubbed like a JSON value under its column's name. */
function scrubCsv(text: string, scrubber: Scrubber): string {
  const rows = csvRows(text);
  if (!rows) return text;
  const head = rows[0]!;
  const sep = text.split(/\r?\n/)[0]!.includes(",") ? "," : text.split(/\r?\n/)[0]!.includes(";") ? ";" : "\t";
  // Lines that aren't rows (a trailing note) are free text.
  return [head.join(sep), ...rows.slice(1).map((r) => (r.length === head.length ? r.map((cell, i) => String(scrubber.json(cell, head[i]))).join(sep) : r.join(sep)))].join("\n");
}
