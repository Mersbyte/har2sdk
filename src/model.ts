/**
 * The analysis pipeline: HAR exchanges → an {@link ApiModel}.
 *
 *   filter noise → template paths → detect GraphQL → group into endpoints →
 *   infer types → detect auth & default headers → name everything
 */
import { filterExchanges, type DropReason, type FilterOptions } from "./filter.js";
import { isJsonMime, isObject, loadHar, NOT_JSON, parseJson, type Body, type Exchange } from "./har.js";
import { findFragmentHead, graphqlListItems, graphqlLiftMatches, graphqlTokens, removeHashComments, replaceQuoted, trimLineEnds } from "./linear.js";
import { emptyShape, observe, observeText, type Shape } from "./infer.js";
import { assignNames } from "./naming.js";
import { collectTaint, isDataLike, isGraphqlDataNumber, isGraphqlIdArg, isIdentity, isIdentityKey, isIdKey, isTainted, scrubberFor, type Taint } from "./leak.js";
import { isContactName, isDataKey, isEmail, isPersonalName, isSecretValue, isSensitiveHeader, isSensitiveName, redactScalar, REDACTED, Scrubber } from "./redact.js";
import { isPlural, setOwn, singular, words } from "./words.js";
import { splitPath, templatePaths, tokenText, type PathSample, type Token } from "./template.js";

export interface AnalyzeOptions extends FilterOptions {
  /** Disable cross-request path merging. */
  noMerge?: boolean;
  /** Force path parameters, e.g. ["/users/*"] (a `*` segment is a parameter). */
  params?: string[];
  /** Source file name, for headers in generated code. */
  source?: string;
}

export interface ParamInfo {
  name: string;
  /** Name as it appears on the wire (query / header). Same as `name` for path params. */
  wireName: string;
  shape: Shape;
  required: boolean;
  array: boolean;
  examples: string[];
}

export interface BodyInfo {
  kind: "json" | "form" | "multipart" | "text";
  mimeType: string;
  shape: Shape;
  count: number;
  /** Requests whose headers announce a body the capture doesn't contain. */
  missing?: number;
}

export interface ResponseInfo {
  status: number;
  kind?: Body["kind"];
  mimeType?: string;
  shape: Shape;
  count: number;
  /** JSON responses whose body was not recorded or didn't parse. */
  incomplete: number;
}

export interface GraphQLInfo {
  operationName: string;
  operationType: "query" | "mutation" | "subscription";
  /** The GraphQL document, if it was sent (not for persisted queries). */
  query?: string;
  /** Apollo-style persisted query hash, if used. */
  persistedHash?: string;
  /** Whether it was sent with GET (query string) rather than POST. */
  viaGet: boolean;
  /** No operation name: `operationName` is then "{rootField,…}" and is not sent. */
  anonymous: boolean;
  /** Normalised document (literals and whitespace folded): tells apart operations that share a name. */
  docKey: string;
  /** Inline literals that were turned into variables (they carried recorded data). */
  liftedVariables?: string[];
  errorsSeen: number;
}

export interface RpcInfo {
  /** JSON-RPC 2.0 (one URL, `method` in the body) or tRPC (procedure in the last path segment). */
  kind: "jsonrpc" | "trpc";
  /** "user.get", "post.byId", … */
  procedure: string;
  /** tRPC queries go over GET with `?input=`. */
  viaGet: boolean;
  /** tRPC with the superjson transformer wraps payloads in `{ json }`. */
  superjson: boolean;
  /** superjson `meta.values` seen on inputs (path → type annotation, e.g. { "since": ["Date"] }). */
  superjsonMeta?: Record<string, unknown>;
  /** JSON-RPC protocol version ("1.0" has no `jsonrpc` field). */
  version?: "1.0" | "2.0";
  errorsSeen: number;
}

export interface Endpoint {
  /** Stable id, e.g. "GET /api/users/{userId}" or "POST /graphql#GetUser". */
  id: string;
  method: string;
  origin: string;
  path: string;
  tokens: Token[];
  /** camelCase method name in the SDK. */
  name: string;
  /** Grouping tag (first resource segment). */
  tag: string;
  description?: string;
  count: number;
  pathParams: ParamInfo[];
  queryParams: ParamInfo[];
  requestBody?: BodyInfo;
  responses: ResponseInfo[];
  graphql?: GraphQLInfo;
  rpc?: RpcInfo;
  /** Indices of the exchanges that make up this endpoint. */
  samples: number[];
  example?: EndpointExample;
}

export interface EndpointExample {
  url: string;
  status: number;
  requestBody?: unknown;
  responseBody?: unknown;
}

export interface AuthInfo {
  bearer: boolean;
  bearerIsJwt: boolean;
  /** The Authorization scheme the app used with its token: "Bearer", "Token", "JWT"… ("" = raw token). */
  tokenScheme: string;
  basic: boolean;
  apiKeyHeaders: string[];
  apiKeyQuery: string[];
  cookieNames: string[];
  csrfHeaders: string[];
}

export interface ApiModel {
  source?: string;
  primaryOrigin: string;
  origins: { origin: string; count: number }[];
  stats: { entries: number; kept: number; dropped: Partial<Record<DropReason, number>> };
  auth: AuthInfo;
  /** Constant, non-secret custom headers every request sent (e.g. x-app-version). */
  defaultHeaders: Record<string, string>;
  /** Other custom headers seen (names only) — documented, not replayed. */
  otherHeaders: string[];
  endpoints: Endpoint[];
  /** Notes for the user (dropped telemetry, unmatched --param patterns, …). Never contain recorded values. */
  warnings: string[];
  /** Every recorded value that looks like data, for the leak guard. */
  taint: Taint;
}

export function analyzeHarText(text: string, opts: AnalyzeOptions = {}): { model: ApiModel; exchanges: Exchange[] } {
  const exchanges = loadHar(text);
  return { model: analyzeExchanges(exchanges, opts), exchanges };
}

export function analyzeExchanges(all: Exchange[], opts: AnalyzeOptions = {}): ApiModel {
  const { kept, dropped, telemetry, untyped } = filterExchanges(all, opts);
  const taint = collectTaint(kept);
  EXAMPLE_SCRUBBER = scrubberFor(taint);
  const warnings: string[] = [];
  if (telemetry.length) {
    warnings.push(
      `${dropped.telemetry} request${dropped.telemetry === 1 ? "" : "s"} on the app's own origin looked like telemetry and ${dropped.telemetry === 1 ? "was" : "were"} dropped (${telemetry.join(", ")}). Keep them with --include-path.`,
    );
  }
  if (untyped.length) {
    const n = dropped["unknown-type"]!;
    warnings.push(
      `${n} request${n === 1 ? " was" : "s were"} skipped because ${n === 1 ? "its" : "their"} content type is unknown (empty body, no Content-Type) (${untyped.join(", ")}). Keep ${n === 1 ? "it" : "them"} with --include-path.`,
    );
  }

  // --- 1. path templates ------------------------------------------------------
  const samples = new Map<string, PathSample>();
  const members = new Map<string, Set<string>>();
  for (const ex of kept) {
    const key = ex.origin + ex.pathname;
    let s = samples.get(key);
    if (!s) samples.set(key, (s = { origin: ex.origin, pathname: ex.pathname, keyPaths: new Set(), hasJson: false, echoed: new Set(), langs: new Set(), echoFields: new Map() }));
    const lang = ex.requestHeaders.get("accept-language");
    if (lang) for (const part of lang.split(",")) s.langs!.add(part.trim().split(/[-_;]/)[0]!.toLowerCase());
    if (ex.responseBody?.kind === "json" && ex.status < 400) {
      s.hasJson = true;
      collectKeyPaths(ex.responseBody.value, s.keyPaths, "", 0);
      const segs = new Set(splitPath(ex.pathname).map((x) => x.toLowerCase()));
      collectEchoes(ex.responseBody.value, segs, s.echoed!, s.echoFields!);
      collectMembers(ex.pathname, ex.responseBody.value, members);
    }
  }
  const templates = templatePaths([...samples.values()], { noMerge: opts.noMerge, params: opts.params, taint, warnings, members });

  // --- 2. group into endpoints -------------------------------------------------
  // The primary origin is the one with the most distinct endpoints, not the
  // most requests: a chatty telemetry host shouldn't name the SDK.
  const originCounts = new Map<string, number>();
  const originPaths = new Map<string, Set<string>>();
  for (const ex of kept) {
    originCounts.set(ex.origin, (originCounts.get(ex.origin) ?? 0) + 1);
    const t = templates.get(ex.origin + ex.pathname);
    if (t) originPaths.set(ex.origin, (originPaths.get(ex.origin) ?? new Set()).add(ex.method + " " + t.template));
  }
  const origins = [...originCounts.entries()]
    .map(([origin, count]) => ({ origin, count }))
    .sort((a, b) => (originPaths.get(b.origin)?.size ?? 0) - (originPaths.get(a.origin)?.size ?? 0) || b.count - a.count);
  const primaryOrigin = origins[0]?.origin ?? "";
  const multiOrigin = origins.length > 1;

  const acc = new Map<string, Accumulator>();
  // GraphQL operations that share a name (or root fields) but send different
  // documents are different operations: the first keeps the plain id.
  const gqlDocs = new Map<string, string[]>();
  for (const ex of kept) {
    const tmpl = templates.get(ex.origin + ex.pathname);
    if (!tmpl) continue;
    for (const unit of splitUnits(ex)) {
      const hostPart = multiOrigin && ex.origin !== primaryOrigin ? new URL(ex.origin).host : "";
      let tokens = tmpl.tokens;
      let values = tmpl.values;
      if (unit.rpc?.kind === "trpc") {
        // The last segment holds the procedure name(s); the endpoint is the base path.
        const last = tokens[tokens.length - 1];
        tokens = tokens.slice(0, -1);
        if (last?.kind === "param") values = Object.fromEntries(Object.entries(values).filter(([k]) => k !== last.name));
      }
      const path = "/" + tokens.map(tokenText).join("/");
      let suffix = unit.gql ? "#" + unit.gql.operationName : unit.rpc ? "#" + unit.rpc.procedure : "";
      if (unit.gql) {
        const k = `${ex.method} ${hostPart}${path}${suffix}`;
        const docs = gqlDocs.get(k) ?? [];
        if (!docs.includes(unit.gql.docKey)) docs.push(unit.gql.docKey);
        gqlDocs.set(k, docs);
        const n = docs.indexOf(unit.gql.docKey);
        if (n > 0) suffix += "@" + shortHash(unit.gql.docKey);
      }
      const id = `${ex.method} ${hostPart}${path}${suffix}`;
      let a = acc.get(id);
      if (!a) acc.set(id, (a = newAccumulator(id, ex, tokens, path, unit)));
      addSample(a, ex, values, unit);
    }
  }

  const dropped_q = [...acc.values()].filter((a) => a.droppedQueryNames > 0);
  if (dropped_q.length) {
    warnings.push(
      `Left out query parameters whose names contain recorded data (an email or id inside the name) on ${dropped_q.length} endpoint${dropped_q.length === 1 ? "" : "s"}; pass them yourself with the request URL if needed.`,
    );
  }
  const endpoints = [...acc.values()].map(finish);
  endpoints.sort((a, b) => a.path.localeCompare(b.path) || methodOrder(a.method) - methodOrder(b.method) || a.id.localeCompare(b.id));
  assignNames(endpoints);

  const defaultHeaders = detectDefaultHeaders(kept, primaryOrigin, taint);
  return {
    source: opts.source,
    primaryOrigin,
    origins,
    stats: { entries: all.length, kept: kept.length, dropped },
    auth: detectAuth(kept, taint),
    defaultHeaders,
    otherHeaders: detectOtherHeaders(kept, defaultHeaders, taint),
    endpoints,
    warnings,
    taint,
  };
}

function shortHash(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36).slice(0, 6);
}

// ---------------------------------------------------------------------------

/** One logical call. A request is usually one unit; batched GraphQL / RPC requests are several. */
export interface Unit {
  gql?: Omit<GraphQLInfo, "errorsSeen"> & { variables?: unknown };
  rpc?: Omit<RpcInfo, "errorsSeen"> & { input?: unknown; output?: unknown; outputMeta?: Record<string, unknown>; hasOutput: boolean; error: boolean };
  requestBody?: Body;
  responseBody?: Body;
}

/** Split an exchange into logical calls: GraphQL operations, JSON-RPC / tRPC procedures, or the request itself. */
export function splitUnits(ex: Exchange): Unit[] {
  const gql = splitGraphQL(ex);
  if (gql.some((u) => u.gql)) return gql;
  return jsonRpcUnits(ex) ?? trpcUnits(ex) ?? gql;
}

function jsonRpcUnits(ex: Exchange): Unit[] | undefined {
  if (ex.requestBody?.kind !== "json") return undefined;
  const v = ex.requestBody.value;
  const calls = Array.isArray(v) ? v : [v];
  const res = ex.responseBody?.kind === "json" ? ex.responseBody.value : undefined;
  const responses: unknown[] = Array.isArray(res) ? res : res !== undefined ? [res] : [];
  const v2 = calls.length > 0 && calls.every((c) => isObject(c) && c.jsonrpc === "2.0" && typeof c.method === "string");
  // JSON-RPC 1.0: no version field; requests carry method, params and id, and
  // every response has both `result` and `error`.
  const v1 =
    !v2 &&
    calls.length > 0 &&
    calls.every((c) => isObject(c) && !("jsonrpc" in c) && typeof c.method === "string" && "params" in c && "id" in c && Object.keys(c).every((k) => ["method", "params", "id"].includes(k))) &&
    responses.length > 0 &&
    responses.every((r) => isObject(r) && "result" in r && "error" in r && "id" in r);
  if (!v2 && !v1) return undefined;
  return calls.map((c: Record<string, any>) => {
    const r = responses.find((x) => isObject(x) && c.id !== undefined && x.id === c.id) ?? (calls.length === 1 ? responses[0] : undefined);
    const hasOutput = isObject(r) && "result" in r;
    return {
      rpc: {
        kind: "jsonrpc" as const,
        procedure: c.method as string,
        viaGet: false,
        superjson: false,
        version: v1 ? ("1.0" as const) : ("2.0" as const),
        input: c.params,
        output: hasOutput ? (r as Record<string, unknown>).result : undefined,
        hasOutput,
        error: isObject(r) && !!r.error,
      },
    };
  });
}

/**
 * superjson `meta.values` ({ "since": ["Date"] }) without the entries whose path
 * runs through a dictionary keyed by data ("seen.ord-77314"): those keys are
 * recorded values, and a path into them won't match the next call anyway.
 */
export function superjsonPaths(values: Record<string, unknown>): Record<string, unknown> | undefined {
  const out = Object.fromEntries(Object.entries(values).filter(([p]) => !p.split(".").some((seg) => isDataKey(seg) || isEmail(seg) || isDataLike(seg))));
  return Object.keys(out).length ? out : undefined;
}

const TRPC_PROC = /^[A-Za-z_$][\w$-]*(\.[A-Za-z_$][\w$-]*)*$/;

function trpcUnits(ex: Exchange): Unit[] | undefined {
  const segs = splitPath(ex.pathname);
  const last = segs[segs.length - 1];
  if (!last) return undefined;
  const procs = last.split(",");
  if (!procs.every((p) => TRPC_PROC.test(p))) return undefined;
  const q = Object.fromEntries(ex.query);
  const batch = q.batch === "1";
  // Strong signals only: a REST API may also wrap payloads in { result: { data } }
  // and use dotted names (/api/v2/users.json).
  if (!batch && !segs.slice(0, -1).some((s) => /trpc/i.test(s))) return undefined;
  if (!batch && procs.length > 1) return undefined;
  const res = ex.responseBody?.kind === "json" ? ex.responseBody.value : undefined;
  const list: unknown[] = batch ? (Array.isArray(res) ? res : []) : res !== undefined ? [res] : [];
  const looksTrpc = (x: unknown) => isObject(x) && ((isObject(x.result) && "data" in x.result) || isObject(x.error));
  if (!list.length || !list.every(looksTrpc)) return undefined;

  let rawInput: unknown;
  if (ex.method === "GET") {
    if (q.input) {
      rawInput = parseJson(q.input);
      if (rawInput === NOT_JSON) return undefined;
    }
  } else if (ex.requestBody?.kind === "json") rawInput = ex.requestBody.value;
  const inputs = procs.map((_, i) => (batch ? (isObject(rawInput) ? rawInput[String(i)] : undefined) : rawInput));
  const outputs = procs.map((_, i) => {
    const r = list[i];
    return isObject(r) && isObject(r.result) ? r.result.data : undefined;
  });
  const isSuper = (x: unknown) => isObject(x) && "json" in x && Object.keys(x).every((k) => k === "json" || k === "meta");
  const superjson = [...inputs, ...outputs].some(isSuper);
  const unwrap = (x: unknown) => (superjson && isSuper(x) ? (x as Record<string, unknown>).json : x);
  const metaOf = (x: unknown) => (superjson && isSuper(x) && isObject((x as any).meta) && isObject((x as any).meta.values) ? superjsonPaths((x as any).meta.values) : undefined);
  return procs.map((procedure, i) => {
    const r = list[i];
    const meta = metaOf(inputs[i]);
    return {
      rpc: {
        kind: "trpc" as const,
        procedure,
        viaGet: ex.method === "GET",
        superjson,
        ...(meta ? { superjsonMeta: meta } : {}),
        input: unwrap(inputs[i]),
        output: unwrap(outputs[i]),
        ...(metaOf(outputs[i]) ? { outputMeta: metaOf(outputs[i]) } : {}),
        hasOutput: isObject(r) && isObject(r.result),
        error: isObject(r) && !!r.error,
      },
    };
  });
}

// A document must actually have a selection set: `{ viewer { id } }`, `query Q { … }`.
// "subscription plans" (a search term) or `{"status":"open"}` (JSON) are not GraphQL.
const GQL_DOC = /^\s*(?:(?:query|mutation|subscription|fragment)\b[^{}]*)?\{\s*(?:[A-Za-z_]|\.\.\.)/;

/** Top-level field names of the first operation: `{ a: viewer { id } products }` → ["viewer", "products"]. */
export function graphqlRootFields(doc: string): string[] {
  const start = doc.indexOf("{");
  if (start < 0) return [];
  const fields: string[] = [];
  let depth = 0;
  let parens = 0;
  for (const m of graphqlTokens(doc, start)) {
    if (m[1] === "{") depth++;
    else if (m[1] === "}") {
      if (--depth === 0) break;
    } else if (m[1] === "(") parens++;
    else if (m[1] === ")") parens--;
    else if (m[3] && depth === 1 && parens === 0) fields.push(m[5] ?? m[3]);
  }
  return [...new Set(fields)];
}

function gqlFromObject(body: Record<string, any>, path: string, viaGet: boolean): Unit["gql"] | undefined {
  const raw = typeof body.query === "string" ? body.query : undefined;
  const persistedHash: string | undefined = body.extensions?.persistedQuery?.sha256Hash;
  const looksGql = (raw && GQL_DOC.test(raw)) || (persistedHash && typeof body.operationName === "string");
  if (!looksGql && !(raw && /graphql|gql/i.test(path))) return undefined;
  const lifted = raw ? liftGraphQLLiterals(raw, body.variables) : undefined;
  const query = lifted?.query;
  // Fragments can come first: look at the operation itself.
  // Comments first: a leading `# …` line would hide the operation's name.
  const op = query ? withoutFragments(withoutComments(query)) : undefined;
  const m = op?.match(/^\s*(query|mutation|subscription)\s+([A-Za-z_][A-Za-z0-9_]*)/);
  const operationType = (op?.match(/^\s*(query|mutation|subscription)\b/)?.[1] as GraphQLInfo["operationType"]) ?? "query";
  // Only a GraphQL Name can name an operation: anything else ("ignore previous
  // instructions…") is free text from the capture, and the operation is anonymous.
  const given = typeof body.operationName === "string" && /^[_A-Za-z]\w{0,127}$/.test(body.operationName) ? body.operationName : undefined;
  const named = given || m?.[2];
  // Anonymous operations are told apart by what they select: "{viewer}", "{products}".
  const operationName = named || `{${(op ? graphqlRootFields(op) : []).join(",") || "anonymous"}}`;
  const docKey = query ? normalizeGraphQL(query) : `#${persistedHash ?? ""}`;
  return {
    operationName,
    operationType,
    query,
    persistedHash,
    viaGet,
    anonymous: !named,
    docKey,
    ...(lifted?.names.length ? { liftedVariables: lifted.names } : {}),
    variables: lifted ? lifted.variables : body.variables,
  };
}

/**
 * A GraphQL document without its `#` comments: they carry no meaning for the
 * operation, only whatever text the app (or a hostile capture) put there.
 * Strings and block strings are kept as they are.
 */
export function withoutComments(doc: string): string {
  return trimLineEnds(removeHashComments(doc));
}

/** The document without its fragment definitions (they may precede the operation). */
export function withoutFragments(doc: string): string {
  let out = doc;
  for (let guard = 0; guard < 50; guard++) {
    const m = findFragmentHead(out);
    if (!m) break;
    let depth = 1;
    let i = m.end;
    for (; i < out.length && depth > 0; i++) {
      if (out[i] === "{") depth++;
      else if (out[i] === "}") depth--;
      else if (out[i] === '"') i = Math.max(i, out.indexOf('"', i + 1));
    }
    out = out.slice(0, m.index + m.prefix.length) + " " + out.slice(i);
  }
  return out;
}

/** Whitespace and literal values folded away: two recordings of the same operation compare equal. */
export function normalizeGraphQL(doc: string): string {
  return replaceQuoted(doc.replace(/#[^\n]*/g, ""), () => '""', true)
    .replace(/(?<![A-Za-z_$])-?\d+(\.\d+)?/g, "0")
    .replace(/\s+/g, " ")
    .replace(/\s*([{}():,!$=@\[\]])\s*/g, "$1")
    .trim();
}

/**
 * Inline literals that carry data (`login(username: "oguz", password: "…")`,
 * `user(email: "a@b.c")`, `user(id: 4815162342)`, `users(ids: ["…"])`, block
 * strings) become variables: the document stays valid, the SDK method takes
 * them as parameters, and no recorded value is baked in. Small numbers
 * (`first: 20`) and enum values stay: they are part of the query's logic.
 * The document is read by graphqlLiftMatches (linear.ts), which matches what
 * the regex GQL_LIFT that it replaces (quoted in its comment) matched, without
 * that regex's exponential backtracking.
 */
function liftGraphQLLiterals(doc: string, variables: unknown): { query: string; variables: unknown; names: string[] } {
  const taken = new Set([...doc.matchAll(/\$([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]!));
  const defs: string[] = [];
  const names: string[] = [];
  const values: Record<string, unknown> = {};
  const idArg = isGraphqlIdArg;
  const scalar = (lit: string): string | number => {
    if (lit.startsWith('"""')) return lit.slice(3, -3).trim();
    if (lit.startsWith('"')) {
      try {
        return JSON.parse(lit);
      } catch {
        return lit.slice(1, -1);
      }
    }
    return Number(lit);
  };
  // Numbers are data when they look like ids or locations: see isGraphqlDataNumber (leak.ts), which the leak guard uses too.
  const dataNumber = isGraphqlDataNumber;
  const lift = (m: string, arg: string | undefined, sep: string, lit: string): string => {
    if (!arg) return m; // a comment or a string that isn't an argument value
    let value: unknown;
    let type: string;
    if (lit.startsWith("[")) {
      const items = [...graphqlListItems(lit)].map(([start, end]) => scalar(lit.slice(start, end)));
      if (!items.some((x) => typeof x === "string" || dataNumber(arg, x))) return m;
      value = items;
      const numbers = items.every((x) => typeof x === "number");
      type = `[${numbers ? (idArg(arg) ? "ID" : items.every((x) => Number.isInteger(x)) ? "Int" : "Float") : idArg(arg) ? "ID" : "String"}!]`;
    } else {
      value = scalar(lit);
      if (typeof value === "number") {
        if (!dataNumber(arg, value)) return m;
        type = !Number.isInteger(value) ? "Float" : idArg(arg) || Math.abs(value) > 2147483647 ? "ID" : "Int";
      } else type = idArg(arg) ? "ID" : "String";
    }
    // Every inline string is lifted: a single word can be sensitive too
    // (term: "psikiyatrist"), and variables keep the document reusable.
    let name = arg;
    for (let k = 2; taken.has(name); k++) name = `${arg}${k}`;
    taken.add(name);
    names.push(name);
    defs.push(`$${name}: ${type}!`);
    setOwn(values, name, value);
    return `${arg}${sep}$${name}`;
  };
  let body = "";
  let last = 0;
  for (const m of graphqlLiftMatches(doc)) {
    body += doc.slice(last, m.index) + lift(m[0], m[1], m[2]!, m[3]!);
    last = m.index + m[0].length;
  }
  body += doc.slice(last);
  if (!defs.length) return { query: doc, variables, names };
  const query = insertVariableDefinitions(body, defs);
  if (query === undefined) return { query: replaceQuoted(doc, (s) => (isDataLike(s.slice(1, -1)) ? JSON.stringify(REDACTED) : s)), variables, names: [] };
  return { query, variables: { ...(isObject(variables) ? variables : {}), ...values }, names };
}

/** Add `$x: String!` definitions to the (first) operation of a document. */
function insertVariableDefinitions(doc: string, defs: string[]): string | undefined {
  let depth = 0;
  for (let i = 0; i < doc.length; i++) {
    const ch = doc[i]!;
    if (ch === '"') {
      const end = doc.indexOf('"', i + 1);
      if (end < 0) return undefined;
      i = end;
      continue;
    }
    if (ch === "{") {
      if (depth === 0) {
        const head = doc.slice(0, i);
        const lastTop = head.slice(Math.max(head.lastIndexOf("}") + 1, 0));
        if (/^\s*fragment\b/.test(lastTop)) {
          depth++;
          continue;
        }
        const op = lastTop.match(/^(\s*)(query|mutation|subscription)\b(\s*[A-Za-z_][A-Za-z0-9_]*)?(\s*\(([\s\S]*)\))?/);
        const start = head.length - lastTop.length;
        if (!op) return doc.slice(0, start) + `${lastTop.match(/^\s*/)![0]}query (${defs.join(", ")}) ` + doc.slice(start + lastTop.match(/^\s*/)![0].length);
        const before = (op[1] ?? "") + op[2] + (op[3] ?? "");
        const existing = op[5]?.trim();
        const args = existing ? `(${existing}, ${defs.join(", ")})` : `(${defs.join(", ")})`;
        return doc.slice(0, start) + before + args + doc.slice(start + op[0].length);
      }
      depth++;
    } else if (ch === "}") depth--;
  }
  return undefined;
}

/** A GraphQL request (or a batch of them) becomes one unit per operation. */
function splitGraphQL(ex: Exchange): Unit[] {
  if (ex.method === "GET") {
    const q = Object.fromEntries(ex.query);
    if (q.query || q.extensions) {
      const body: Record<string, unknown> = { query: q.query, operationName: q.operationName };
      // Invalid (or absurdly deep) JSON is left out, as if it weren't there.
      for (const k of ["variables", "extensions"] as const) {
        const v = q[k] ? parseJson(q[k]) : NOT_JSON;
        if (v !== NOT_JSON) body[k] = v;
      }
      const gql = gqlFromObject(body, ex.pathname, true);
      if (gql) return [{ gql, responseBody: ex.responseBody }];
    }
    return [{ requestBody: ex.requestBody, responseBody: ex.responseBody }];
  }
  if (ex.requestBody?.kind === "json") {
    const v = ex.requestBody.value;
    if (isObject(v)) {
      const gql = gqlFromObject(v, ex.pathname, false);
      if (gql) return [{ gql, requestBody: ex.requestBody, responseBody: ex.responseBody }];
    } else if (Array.isArray(v) && v.length && v.every(isObject)) {
      const ops = v.map((b) => gqlFromObject(b, ex.pathname, false));
      if (ops.every(Boolean)) {
        const res = ex.responseBody?.kind === "json" && Array.isArray(ex.responseBody.value) ? ex.responseBody.value : [];
        return ops.map((gql, i) => ({
          gql,
          responseBody: res[i] !== undefined ? { kind: "json", value: res[i], raw: "", mimeType: "application/json" } : undefined,
        }));
      }
    }
  }
  return [{ requestBody: ex.requestBody, responseBody: ex.responseBody }];
}

interface Accumulator {
  id: string;
  method: string;
  origin: string;
  path: string;
  tokens: Token[];
  count: number;
  pathParams: Map<string, { shape: Shape; examples: Set<string> }>;
  query: Map<string, { shape: Shape; present: number; array: boolean; examples: Set<string> }>;
  bodies: Map<BodyInfo["kind"], BodyInfo>;
  responses: Map<number, ResponseInfo>;
  gql?: GraphQLInfo;
  rpc?: RpcInfo;
  samples: number[];
  example?: EndpointExample;
  droppedQueryNames: number;
}

function newAccumulator(id: string, ex: Exchange, tokens: Token[], path: string, unit: Unit): Accumulator {
  const gql = unit.gql;
  const rpc = unit.rpc;
  return {
    id,
    method: ex.method,
    origin: ex.origin,
    path,
    tokens,
    count: 0,
    pathParams: new Map(),
    query: new Map(),
    bodies: new Map(),
    responses: new Map(),
    gql: gql
      ? {
          operationName: gql.operationName,
          operationType: gql.operationType,
          query: gql.query,
          persistedHash: gql.persistedHash,
          viaGet: gql.viaGet,
          anonymous: gql.anonymous,
          docKey: gql.docKey,
          ...(gql.liftedVariables ? { liftedVariables: gql.liftedVariables } : {}),
          errorsSeen: 0,
        }
      : undefined,
    rpc: rpc
      ? { kind: rpc.kind, procedure: rpc.procedure, viaGet: rpc.viaGet, superjson: rpc.superjson, ...(rpc.version ? { version: rpc.version } : {}), errorsSeen: 0 }
      : undefined,
    samples: [],
    droppedQueryNames: 0,
  };
}

const IGNORED_QUERY = new Set(["_", "_t", "cachebuster", "cb", "nocache"]);

function addSample(a: Accumulator, ex: Exchange, pathValues: Record<string, string>, unit: Unit): void {
  a.count++;
  a.samples.push(ex.index);

  for (const [name, value] of Object.entries(pathValues)) {
    let p = a.pathParams.get(name);
    if (!p) a.pathParams.set(name, (p = { shape: emptyShape(), examples: new Set() }));
    observeText(p.shape, value);
    if (p.examples.size < 5) p.examples.add(EXAMPLE_SCRUBBER.id(value));
  }

  if (unit.gql) {
    const vars = unit.gql.variables;
    const body = a.bodies.get("json") ?? { kind: "json" as const, mimeType: "application/json", shape: emptyShape(), count: 0 };
    observe(body.shape, isObject(vars) ? vars : {});
    body.count++;
    a.bodies.set("json", body);
    if (!a.gql!.query && unit.gql.query) a.gql!.query = unit.gql.query;
  } else if (unit.rpc) {
    if (unit.rpc.input !== undefined) {
      const body = a.bodies.get("json") ?? { kind: "json" as const, mimeType: "application/json", shape: emptyShape(), count: 0 };
      observe(body.shape, unit.rpc.input);
      body.count++;
      a.bodies.set("json", body);
    }
    if (unit.rpc.superjson) a.rpc!.superjson = true;
    if (unit.rpc.superjsonMeta) a.rpc!.superjsonMeta = { ...(a.rpc!.superjsonMeta ?? {}), ...unit.rpc.superjsonMeta };
  } else {
    const seen = new Map<string, string[]>();
    for (const [k, v] of ex.query) {
      if (IGNORED_QUERY.has(k)) continue;
      const list = seen.get(k) ?? [];
      list.push(v);
      seen.set(k, list);
    }
    for (const [k, values] of seen) {
      // ?role[oguz@kilic.dev]=admin: a name that carries data can't be an SDK parameter.
      if (k.split(/[[\]]+/).some((part) => part && (isDataKey(part) || isEmail(part)))) {
        a.droppedQueryNames++;
        continue;
      }
      const name = k.endsWith("[]") ? k.slice(0, -2) : k;
      let q = a.query.get(k);
      if (!q) a.query.set(k, (q = { shape: emptyShape(), present: 0, array: false, examples: new Set() }));
      q.present++;
      if (values.length > 1 || k.endsWith("[]")) q.array = true;
      const sensitive = isSensitiveName(name);
      for (const v of values) {
        observeText(q.shape, v, { sensitive });
        if (q.examples.size < 3) q.examples.add(sensitive ? REDACTED : EXAMPLE_SCRUBBER.string(v, isContactName(name) || isPersonalName(name)));
      }
    }
    const rb = unit.requestBody;
    if (rb?.kind === "missing") {
      // The headers say there was a body (a multipart upload the browser left out).
      const kind = rb.mimeType.startsWith("multipart/") ? "multipart" : rb.mimeType.includes("x-www-form-urlencoded") ? "form" : isJsonMime(rb.mimeType) ? "json" : "text";
      const body = a.bodies.get(kind) ?? { kind, mimeType: rb.mimeType, shape: emptyShape(), count: 0 };
      body.count++;
      body.missing = (body.missing ?? 0) + 1;
      a.bodies.set(kind, body);
    } else if (rb && (rb.kind === "json" || rb.kind === "form" || rb.kind === "multipart" || rb.kind === "text")) {
      const body = a.bodies.get(rb.kind) ?? { kind: rb.kind, mimeType: rb.mimeType, shape: emptyShape(), count: 0 };
      if (rb.kind === "json") observe(body.shape, rb.value);
      else if (rb.kind === "form") observeFields(body.shape, rb.fields);
      else body.shape.count++;
      body.count++;
      a.bodies.set(rb.kind, body);
    }
  }

  const status = ex.status;
  let r = a.responses.get(status);
  if (!r) a.responses.set(status, (r = { status, shape: emptyShape(), count: 0, incomplete: 0 }));
  r.count++;
  if (unit.rpc) {
    if (unit.rpc.error) a.rpc!.errorsSeen++;
    if (unit.rpc.hasOutput) {
      r.kind ??= "json";
      r.mimeType ??= "application/json";
      observe(r.shape, unit.rpc.output);
    }
  }
  const resBody = unit.rpc ? undefined : unit.responseBody;
  if (resBody) {
    const incomplete = resBody.kind === "missing" || resBody.kind === "unparsed";
    if (incomplete) r.incomplete++;
    r.kind ??= incomplete ? "json" : resBody.kind;
    r.mimeType ??= resBody.mimeType;
    if (resBody.kind === "json") {
      let value = resBody.value;
      if (unit.gql && isObject(value)) {
        if (value.errors) a.gql!.errorsSeen++;
        value = value.data ?? null;
      }
      observe(r.shape, value);
    }
  }

  if (!a.example || (a.example.status >= 300 && status < 300)) {
    // Examples are fake data with the recorded shape: see Scrubber.
    const s = EXAMPLE_SCRUBBER;
    const cap = (v: unknown) => capExample(s.json(v));
    a.example = {
      url: redactUrl(ex, new Set(Object.values(pathValues))),
      status,
      requestBody: unit.gql
        ? cap(unit.gql.variables ?? {})
        : unit.rpc
          ? cap(unit.rpc.input)
          : unit.requestBody?.kind === "json"
            ? cap(unit.requestBody.value)
            : unit.requestBody?.kind === "form"
              ? Object.fromEntries(unit.requestBody.fields.map(([k, v]) => [k, isSensitiveName(k) ? REDACTED : s.string(v, isContactName(k) || isPersonalName(k))]))
              : undefined,
      responseBody: unit.rpc
        ? cap(unit.rpc.output)
        : resBody?.kind === "json"
          ? cap(unit.gql && isObject(resBody.value) ? resBody.value.data : resBody.value)
          : undefined,
    };
  }
}

function observeFields(shape: Shape, fields: [string, string][]): void {
  shape.count++;
  const o = (shape.object ??= { count: 0, props: new Map() });
  o.count++;
  for (const [k, v] of fields) {
    let child = o.props.get(k);
    if (!child) o.props.set(k, (child = emptyShape()));
    observeText(child, v, { sensitive: isSensitiveName(k) });
  }
}

function finish(a: Accumulator): Endpoint {
  const bodies = [...a.bodies.values()].sort((x, y) => y.count - x.count);
  return {
    id: a.id,
    method: a.method,
    origin: a.origin,
    path: a.path,
    tokens: a.tokens,
    name: "",
    tag: "",
    count: a.count,
    pathParams: [...a.pathParams.entries()].map(([name, p]) => ({
      name,
      wireName: name,
      shape: p.shape,
      required: true,
      array: false,
      examples: [...p.examples],
    })),
    queryParams: [...a.query.entries()]
      .map(([wire, q]) => ({
        name: wire.endsWith("[]") ? wire.slice(0, -2) : wire,
        wireName: wire,
        shape: q.shape,
        required: a.count >= 3 && q.present === a.count,
        array: q.array,
        examples: [...q.examples],
      }))
      .sort((x, y) => Number(y.required) - Number(x.required) || x.name.localeCompare(y.name)),
    requestBody: bodies[0],
    responses: [...a.responses.values()].sort((x, y) => x.status - y.status),
    graphql: a.gql,
    rpc: a.rpc,
    samples: a.samples,
    example: a.example,
  };
}

/** One scrubber per analysis: the same recorded id gets the same fake everywhere. */
let EXAMPLE_SCRUBBER = new Scrubber();

/** Keep examples small: three array items, depth 8. */
function capExample(v: unknown, depth = 0): unknown {
  if (depth > 8) return null;
  if (Array.isArray(v)) return v.slice(0, 3).map((x) => capExample(x, depth + 1));
  if (isObject(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, capExample(x, depth + 1)]));
  return typeof v === "string" && v.length > 200 ? v.slice(0, 200) + "…" : v;
}

function redactUrl(ex: Exchange, paramValues: Set<string>): string {
  const u = new URL(ex.url.href);
  const params = new URLSearchParams();
  for (const [k, v] of ex.query) params.append(k, isSensitiveName(k) ? REDACTED : EXAMPLE_SCRUBBER.string(v, isContactName(k) || isPersonalName(k)));
  u.search = params.toString();
  u.username = "";
  u.password = "";
  u.pathname = u.pathname
    .split("/")
    .map((seg) => {
      try {
        const d = decodeURIComponent(seg);
        // `{productId}.json`: the value is the part before the extension.
        const ext = d.match(/\.[A-Za-z0-9]{1,5}$/)?.[0] ?? "";
        const r = paramValues.has(d) ? EXAMPLE_SCRUBBER.id(d) : ext && paramValues.has(d.slice(0, -ext.length)) ? EXAMPLE_SCRUBBER.id(d.slice(0, -ext.length)) + ext : d;
        return r === d ? seg : encodeURIComponent(r);
      } catch {
        return seg;
      }
    })
    .join("/");
  try {
    return decodeURI(u.toString());
  } catch {
    return u.toString();
  }
}

function collectKeyPaths(value: unknown, out: Set<string>, prefix: string, depth: number): void {
  if (depth > 3 || out.size > 400) return;
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 5)) collectKeyPaths(item, out, prefix + "[].", depth + 1);
  } else if (isObject(value)) {
    for (const [k, v] of Object.entries(value)) {
      const key = /^\d+$/.test(k) ? "{n}" : k;
      out.add(prefix + key);
      collectKeyPaths(v, out, prefix + key + ".", depth + 1);
    }
  }
}

const ID_FIELD = /^(id|uuid|slug|login|username|user_?name|handle|screen_?name|nickname|key|code|ref|sku|identifier|path|name|first_?name|display_?name|full_?name)$|(Id|_id|Slug|_slug|Key|_key|Code|_code|Name|_name)$/;

/**
 * Which path segments does the response use as *its own identifier*? Only the
 * id-like fields of the top-level object count (`{"login": "alice"}` for
 * /users/alice) — not values somewhere in a list (`state: "active"` items
 * under /projects/active) — plus the id fields of an owner-like object
 * (`{ owner: { login: "alice" } }` for /repos/alice/x), recorded as "owner.login".
 */
function collectEchoes(value: unknown, segs: Set<string>, out: Set<string>, fields: Map<string, string>, depth = 0, prefix = ""): void {
  if (!isObject(value) || depth > 1) return;
  for (const [k, v] of Object.entries(value)) {
    if (typeof v === "string" && ID_FIELD.test(k)) {
      const s = v.toLowerCase();
      if (segs.has(s)) {
        out.add(s);
        if (!fields.has(s) || !prefix) fields.set(s, prefix + k);
      }
    } else if (depth === 0 && isObject(v) && /^(data|result|user|item|profile|record)$/i.test(k)) {
      collectEchoes(v, segs, out, fields, depth + 1, prefix);
    } else if (depth === 0 && isObject(v) && isIdentityKey(k)) {
      collectEchoes(v, segs, out, fields, depth + 1, k + ".");
    }
  }
}

const LIST_KEYS = /^(items|data|results|records|rows|list|entries|hits|nodes|values|objects|elements|content)$/i;

/**
 * Values that a collection's list response names its items by:
 * `GET /users/{u}/repos` → `[{ name: "dotfiles" }]` makes "dotfiles" a member of "repo".
 */
function collectMembers(pathname: string, value: unknown, out: Map<string, Set<string>>): void {
  const segs = splitPath(pathname);
  let resource: string | undefined;
  for (let i = segs.length - 1; i >= 0 && !resource; i--) {
    const seg = segs[i]!.replace(/\.(json|xml)$/i, "");
    if (/^[A-Za-z][A-Za-z_-]*$/.test(seg) && isPlural(seg)) resource = singular(seg).toLowerCase();
    else if (!/^[A-Za-z][A-Za-z_-]*$/.test(seg) || i < segs.length - 1) break;
  }
  if (!resource) return;
  let items: unknown[] | undefined = Array.isArray(value) ? value : undefined;
  if (!items && isObject(value)) {
    for (const [k, v] of Object.entries(value)) if (Array.isArray(v) && (LIST_KEYS.test(k) || singular(k).toLowerCase() === resource)) items = v;
  }
  for (const item of (items ?? []).slice(0, 500)) {
    if (!isObject(item)) continue;
    for (const [k, v] of Object.entries(item)) {
      if (typeof v !== "string" || !ID_FIELD.test(k) || /\s/.test(v) || v.length < 2 || v.length > 100) continue;
      const set = out.get(v.toLowerCase()) ?? new Set<string>();
      set.add(resource);
      out.set(v.toLowerCase(), set);
    }
  }
}

function methodOrder(m: string): number {
  return ["GET", "POST", "PUT", "PATCH", "DELETE"].indexOf(m) + 1 || 9;
}

// --- auth & headers ----------------------------------------------------------

const API_KEY_HEADERS = /^(x-)?(api-?key|apikey|auth-?token|access-?token|x-token|client-?id|app-?key|subscription-key|ocp-apim-subscription-key)$/;
const API_KEY_QUERY = /^(api_?key|apikey|key|appid|app_?id|app_?key|access_?token|token|auth|client_?id|subscription-key)$/i;

/** Analytics / consent / CDN cookies — never the session. */
const TRACKING_COOKIE =
  /^(_ga|_gid|_gat|_gcl_\w+|_fbp|_fbc|_hj\w*|ajs_\w+|amplitude\w*|amp_\w+|mp_\w+|_clck|_clsk|_uet\w+|_pin_unauth|_tt_\w+|_scid|_rdt_uuid|__stripe_mid|__stripe_sid|optanon\w*|OptanonConsent|OptanonAlertBoxClosed|cookieconsent\w*|CookieConsent|euconsent\w*|__cf_bm|cf_clearance|_cfuvid|intercom-\w+|_dd_s|_lr_\w+|ln_or|_ttp|_tt_enable_cookie|NID|1P_JAR|AEC|__utm\w)$/i;

/** A cookie or header name with recorded data in it ("remember_mdemir", "x-user-42ab9f"): never listed. */
function nameCarriesData(name: string, taint: Taint, whole = true): boolean {
  if (whole && (isDataLike(name) || isTainted(taint, name))) return true;
  return name.split(/[._+\-]+/).some((p) => p.length >= 3 && (isTainted(taint, p) || isDataLike(p) || isIdentity(taint, p)));
}

function detectAuth(exchanges: Exchange[], taint: Taint): AuthInfo {
  const info: AuthInfo = { bearer: false, bearerIsJwt: false, tokenScheme: "Bearer", basic: false, apiKeyHeaders: [], apiKeyQuery: [], cookieNames: [], csrfHeaders: [] };
  const apiKeyHeaders = new Set<string>();
  const apiKeyQuery = new Set<string>();
  const cookies = new Set<string>();
  const csrf = new Set<string>();
  for (const ex of exchanges) {
    const auth = ex.requestHeaders.get("authorization");
    if (auth) {
      if (/^basic\s/i.test(auth)) info.basic = true;
      else {
        info.bearer = true;
        const m = auth.match(/^([A-Za-z][\w-]*)\s+(\S+)$/);
        info.tokenScheme = m ? m[1]! : "";
        if (/^eyJ/.test(m ? m[2]! : auth)) info.bearerIsJwt = true;
      }
    }
    for (const name of ex.requestHeaders.keys()) {
      if (API_KEY_HEADERS.test(name)) apiKeyHeaders.add(name);
      if (/csrf|xsrf/.test(name)) csrf.add(name);
    }
    for (const [k, v] of ex.query) if (API_KEY_QUERY.test(k) && v.length >= 8) apiKeyQuery.add(k);
    const cookie = ex.requestHeaders.get("cookie");
    if (cookie) for (const part of cookie.split(";")) {
      const name = part.split("=")[0]?.trim();
      if (name && !TRACKING_COOKIE.test(name) && !nameCarriesData(name, taint)) cookies.add(name);
    }
  }
  info.apiKeyHeaders = [...apiKeyHeaders].sort();
  info.apiKeyQuery = [...apiKeyQuery].sort();
  // Session-looking cookies first: they're what `cookieAuth` should name.
  const sessionish = (n: string) => (/sess|sid|auth|token|jwt|login|remember/i.test(n) ? 0 : 1);
  info.cookieNames = [...cookies].sort((a, b) => sessionish(a) - sessionish(b) || a.localeCompare(b));
  info.csrfHeaders = [...csrf].sort();
  return info;
}

/** Headers the browser (not the app) sets. Never replay these. */
const BROWSER_HEADERS = new Set([
  "accept",
  "accept-encoding",
  "accept-language",
  "cache-control",
  "connection",
  "content-length",
  "content-type",
  "cookie",
  "dnt",
  "host",
  "if-modified-since",
  "if-none-match",
  "origin",
  "pragma",
  "priority",
  "referer",
  "te",
  "upgrade-insecure-requests",
  "user-agent",
  "authorization",
]);

const SAFE_DEFAULT_HEADER =
  /^(x-requested-with|x-requested-by|x-app|x-app-name|x-client|x-client-name|x-client-type|x-platform|x-device-type|x-source|x-channel|api-version|accept-version|apollographql-client-name|apollographql-client-version|x-[a-z-]*(version|build)|x-[a-z-]*client(-name|-type)?)$/;

/** Custom request headers the app sent that are not baked into the SDK (names only). */
function detectOtherHeaders(exchanges: Exchange[], defaults: Record<string, string>, taint: Taint): string[] {
  const names = new Set<string>();
  for (const ex of exchanges) {
    for (const name of ex.requestHeaders.keys()) {
      if (BROWSER_HEADERS.has(name) || name.startsWith("sec-") || name in defaults) continue;
      if (!/^x-|^[a-z]+-[a-z]+-/.test(name) || /^x-(forwarded|real-ip|amz-|goog-|datadog|b3|cloud-trace)/.test(name) || nameCarriesData(name, taint)) continue;
      names.add(name);
    }
  }
  return [...names].sort().slice(0, 12);
}

/** Values that describe the app or platform, never the user or device: "web", "ios", "2.14.0". */
const PLATFORM_WORDS = new Set(
  "web webapp web-app app spa pwa site frontend backend browser desktop mobile tablet phone ios android ipad iphone mac macos osx windows win linux electron native react next vue angular dashboard console portal admin cli server client sdk js ts mweb amp lite".split(
    " ",
  ),
);

function safeHeaderValue(name: string, value: string, brand: Set<string>, taint: Taint): boolean {
  // Pre-release / build metadata can name a person or a machine ("2.14.0+mdemir").
  if (/version|build/.test(name)) return /^v?\d+([._]\d+){0,3}([-+][0-9A-Za-z]+(\.[0-9A-Za-z]+)*)?$|^\d{4}-\d{2}-\d{2}$/.test(value) && !nameCarriesData(value.replace(/^v?[\d._]+/, ""), taint, false);
  if (name === "x-requested-with") return /^[A-Za-z]{3,24}$/.test(value);
  // Every word must be a platform word or part of the API's own host name
  // ("acme-web" for api.acme.com); anything else may be a user or device name.
  const parts = value.toLowerCase().split(/[-_. /]+/).filter(Boolean);
  return parts.length > 0 && parts.length <= 4 && parts.every((p) => PLATFORM_WORDS.has(p) || brand.has(p) || /^v?\d+(\.\d+)*$/.test(p));
}

function detectDefaultHeaders(exchanges: Exchange[], primaryOrigin: string, taint: Taint): Record<string, string> {
  let brand = new Set<string>();
  try {
    brand = new Set(new URL(primaryOrigin).hostname.split(/[.-]/).filter((p) => p.length >= 3));
  } catch {
    /* no origin */
  }
  if (!exchanges.length) return {};
  const values = new Map<string, Map<string, number>>();
  for (const ex of exchanges) {
    for (const [name, value] of ex.requestHeaders) {
      if (BROWSER_HEADERS.has(name) || name.startsWith("sec-") || isSensitiveHeader(name)) continue;
      if (API_KEY_HEADERS.test(name) || /csrf|xsrf|request-id|trace|span|correlation|idempotency/.test(name)) continue;
      // Per-device / per-user identifiers must not be baked into an SDK.
      if (words(name).includes("id") || isSecretValue(value) || value.length > 64) continue;
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) || /^[0-9a-f]{16,}$/i.test(value)) continue;
      // Allowlist: only app/client/version style headers are safe to bake in.
      // Anything else (x-username, x-forwarded-for, x-amz-date …) may be
      // personal or per-request; it's only mentioned by name in the docs.
      if (!SAFE_DEFAULT_HEADER.test(name) || value.length > 40 || !safeHeaderValue(name, value, brand, taint)) continue;
      let m = values.get(name);
      if (!m) values.set(name, (m = new Map()));
      m.set(value, (m.get(value) ?? 0) + 1);
    }
  }
  const out: Record<string, string> = {};
  for (const [name, m] of [...values.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (m.size !== 1) continue;
    const [value, count] = [...m.entries()][0]!;
    if (count >= Math.max(2, Math.ceil(exchanges.length * 0.8))) setOwn(out, name, value);
  }
  return out;
}
