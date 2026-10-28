/**
 * Turn an {@link ApiModel} into a generation plan shared by the TypeScript and
 * OpenAPI emitters: one TypeRegistry, and for each endpoint the TypeNodes for
 * its params, body and success response.
 */
import { applyAnnotations, clientNameFor, isValidClientName, type Annotations } from "./annotations.js";
import { mergeShapes, emptyShape, type Shape } from "./infer.js";
import type { ApiModel, Endpoint } from "./model.js";
import { renameRefs, TypeRegistry, type NamedType, type TypeNode } from "./types.js";
import { trimTrailingSlashes } from "./linear.js";
import { isActionEndpoint } from "./naming.js";
import { isIdentifier, isPlural, pascal, singular, words } from "./words.js";

export interface PlannedParam {
  /** TypeScript property name. */
  name: string;
  /** Name on the wire. */
  wire: string;
  type: TypeNode;
  required: boolean;
  examples: string[];
}

export interface PlannedOp {
  ep: Endpoint;
  /** PascalCase of the method name, used for type names. */
  pascalName: string;
  pathParams: PlannedParam[];
  queryParams: PlannedParam[];
  paramsTypeName?: string;
  body?: { kind: "json" | "form" | "multipart" | "text"; mimeType: string; type: TypeNode; typeName?: string };
  response: {
    type: TypeNode;
    typeName: string;
    kind: "json" | "text" | "empty" | "binary";
    status?: number;
    /** Per-status types when distinct 2xx responses have different shapes. */
    byStatus?: Map<number, TypeNode>;
  };
  /** Error bodies (4xx/5xx JSON), if any were recorded: one type, or a union of per-status types. */
  error?: { type: TypeNode; typeName: string; byStatus?: Map<number, TypeNode> };
  /** True when the endpoint lives on a secondary origin. */
  foreignOrigin?: string;
}

export interface Plan {
  model: ApiModel;
  clientName: string;
  /** Base URL baked into the SDK (defaults to the most common recorded origin). */
  baseUrl: string;
  registry: TypeRegistry;
  ops: PlannedOp[];
  warnings: string[];
}

export interface PlanOptions {
  annotations?: Annotations;
  enums?: boolean;
  baseUrl?: string;
}

const RUNTIME_NAMES = ["ClientOptions", "RequestOptions", "ApiError", "GraphQLError", "RpcError", "QueryValue", "DEFAULT_HEADERS"];
const GENERIC = new Set(["items", "data", "results", "records", "rows", "list", "entries", "hits", "nodes", "edges", "content"]);
const PREFIX = /^(api|apis|rest|v\d+(\.\d+)*|\d{4}-\d{2}|internal|public|ajax|json|graphql|gql)$/i;

export function buildPlan(model: ApiModel, opts: PlanOptions = {}): Plan {
  const warnings = [...(model.warnings ?? []), ...applyAnnotations(model, opts.annotations)];
  const clientName = clientNameFor(model, opts.annotations);
  if (opts.annotations?.clientName && !isValidClientName(opts.annotations.clientName)) {
    warnings.push(`"${opts.annotations.clientName.slice(0, 40)}" can't be a class name (not an identifier, or it shadows a name the client uses); using ${clientName}.`);
  }
  const registry = new TypeRegistry({ enums: opts.enums, reserved: [...RUNTIME_NAMES, clientName], taint: model.taint });

  // Reserve every op's alias names first so object types never steal them.
  for (const ep of model.endpoints) {
    const p = pascal(ep.name);
    registry.reserve(p + "Params");
    registry.reserve(p + "Body");
    registry.reserve(p + "Variables");
    registry.reserve(p + "Input");
    registry.reserve(p + "Error");
  }

  const ops: PlannedOp[] = [];
  for (const ep of model.endpoints) ops.push(planOp(ep, model, registry, warnings));

  // OpenAPI keys paths without a host: the same method + path on two origins collides.
  const seen = new Map<string, string>();
  for (const op of ops) {
    if (op.ep.graphql || op.ep.rpc) continue;
    const key = `${op.ep.method} ${op.ep.path}`;
    const prev = seen.get(key);
    if (prev && prev !== op.ep.origin) warnings.push(`${key} exists on ${prev} and ${op.ep.origin}; openapi.json keeps one of them (the SDK has both).`);
    else seen.set(key, op.ep.origin);
  }

  const auto = registry.finalizeNames();
  if (auto.size) for (const op of ops) visitOp(op, (t) => renameRefs(t, auto));
  if (opts.annotations?.types) renameTypes(registry, ops, opts.annotations.types, warnings);
  if (opts.baseUrl !== undefined) checkBaseUrl(opts.baseUrl);
  const baseUrl = trimTrailingSlashes(opts.baseUrl ?? model.primaryOrigin);
  return { model, clientName, baseUrl, registry, ops, warnings };
}

function singularPascal(s: string): string {
  const w = words(s);
  if (!w.length) return "";
  w[w.length - 1] = singular(w[w.length - 1]!);
  return pascal(w.join(" "));
}

/** "Product" for /products/{id}, "CartItem" for /cart/items; undefined for actions. */
function resourceName(ep: Endpoint): string | undefined {
  if (ep.graphql || ep.rpc || isActionEndpoint(ep)) return undefined;
  const idx = findLastLiteral(ep);
  if (idx < 0) return undefined;
  const last = (ep.tokens[idx] as { value: string }).value;
  if (PREFIX.test(last)) return undefined;
  let name = singularPascal(last);
  const prev = ep.tokens[idx - 1];
  const lw = words(last);
  if (prev?.kind === "literal" && !PREFIX.test(prev.value) && isPlural(lw[lw.length - 1] ?? "")) name = singularPascal(prev.value) + name;
  return /^[A-Z]/.test(name) ? name : undefined;
}

function findLastLiteral(ep: Endpoint): number {
  for (let i = ep.tokens.length - 1; i >= 0; i--) if (ep.tokens[i]!.kind === "literal") return i;
  return -1;
}

function isCollection(ep: Endpoint): boolean {
  const idx = findLastLiteral(ep);
  if (idx < 0 || idx !== ep.tokens.length - 1) return false;
  const w = words((ep.tokens[idx] as { value: string }).value);
  return isPlural(w[w.length - 1] ?? "");
}

function planOp(ep: Endpoint, model: ApiModel, registry: TypeRegistry, warnings: string[]): PlannedOp {
  const P = pascal(ep.name);
  const resource = resourceName(ep);

  const pathParams: PlannedParam[] = ep.pathParams.map((p) => ({
    name: p.name,
    wire: p.wireName,
    type: scalarParam(registry.fromShape(p.shape, [P + pascal(p.name)])),
    required: true,
    examples: p.examples,
  }));
  const usedNames = new Set(pathParams.map((p) => p.name));
  const queryParams: PlannedParam[] = ep.queryParams.map((q) => {
    let name = q.name;
    // `constructor`, `toString`…: every object has them, so `params: XParams = {}` wouldn't type-check.
    if (usedNames.has(name) || OBJECT_MEMBERS.has(name)) name = name + "Query";
    usedNames.add(name);
    let type = scalarParam(registry.fromShape(q.shape, [P + pascal(q.name)], undefined, q.name));
    if (q.array) type = { k: "array", items: type };
    return { name, wire: q.wireName, type, required: q.required, examples: q.examples };
  });

  if (!/^(GET|PUT|POST|DELETE|OPTIONS|HEAD|PATCH|TRACE)$/.test(ep.method)) {
    warnings.push(`${ep.id}: OpenAPI has no key for the method ${ep.method.replace(/[^A-Za-z]/g, "").slice(0, 16)}, so openapi.json lists it under \`x-har2sdk-methods\`.`);
  }
  let body: PlannedOp["body"];
  if (ep.requestBody) {
    const rb = ep.requestBody;
    const hint = ep.graphql ? P + "Variables" : ep.rpc ? P + "Input" : P + "Body";
    registry.release(hint);
    let type: TypeNode;
    if (rb.missing) warnings.push(`${ep.id}: the request body was not recorded${rb.kind === "multipart" ? " (browsers leave out multipart uploads)" : ""}, so its type is \`${rb.kind === "multipart" ? "FormData" : "unknown"}\`.`);
    if (rb.kind === "multipart") type = { k: "unknown" };
    else if (rb.kind === "text") type = { k: "string" };
    else type = registry.fromShape(rb.shape, [hint, (resource ?? P) + "Input"], resource);
    body = { kind: rb.kind, mimeType: rb.mimeType, type, typeName: hint };
  }

  // Success response: merge every 2xx we saw — unless different statuses
  // return clearly different things (200 {url} vs 202 {jobId,state}).
  const ok = ep.responses.filter((r) => r.status >= 200 && r.status < 300);
  let shape: Shape = emptyShape();
  for (const r of ok) shape = mergeShapes(shape, r.shape);
  const okJson = ok.filter((r) => r.shape.count > 0 && r.shape.object && !r.shape.array);
  const distinct = okJson.length >= 2 && okJson.every((a, i) => okJson.every((b, j) => i === j || keyJaccard(a.shape, b.shape) < 0.5));
  if (ok.some((r) => r.incomplete > 0)) warnings.push(`${ep.id}: some response bodies were not recorded or were truncated, so parts of its type are \`unknown\`.`);
  const kinds = new Set(ok.map((r) => r.kind));
  const kind: PlannedOp["response"]["kind"] = kinds.has("json")
    ? "json"
    : kinds.has("text")
      ? "text"
      : kinds.has("binary")
        ? "binary"
        : "empty";

  const isList = !!shape.array;
  const isEnvelope = !!shape.object && [...shape.object.props.entries()].some(([k, v]) => GENERIC.has(k.toLowerCase()) && (v.array || v.object));
  let hints: string[];
  if (ep.graphql) hints = [P + "Data", P + "Response"];
  else if (ep.rpc) hints = [P + "Result", P + "Response"];
  else if (isList) hints = resource ? [resource, P + "Item"] : [P + "Item"];
  else if (isEnvelope && isCollection(ep)) hints = [P + "Response", (resource ?? P) + "Page"];
  else hints = resource ? [resource, P + "Response"] : [P + "Response"];

  let type: TypeNode;
  let byStatus: Map<number, TypeNode> | undefined;
  if (kind === "json" && distinct) {
    registry.reserve(P + "Response");
    byStatus = new Map(okJson.map((r) => [r.status, registry.fromShape(r.shape, [`${P}${r.status}`, `${P}Response${r.status}`], resource)]));
    type = { k: "union", options: [...byStatus.values()] };
  } else if (kind === "json") type = registry.fromShape(shape, hints, resource);
  else if (kind === "text") type = { k: "string" };
  else if (kind === "binary") type = { k: "unknown" };
  else type = ok.length ? { k: "null" } : { k: "unknown" };

  let typeName = P + "Response";
  if (!byStatus && registry.isTaken(typeName) && !(type.k === "ref" && type.name === typeName)) typeName = P + "Result";

  // Error bodies (4xx/5xx JSON) get their own type for `ApiError<…>` and the
  // generated `is…Error()` guard. Statuses with different shapes (404 {error}
  // vs 422 {errors}) stay separate members of a union.
  let error: PlannedOp["error"];
  const errs = ep.responses.filter((r) => r.status >= 400 && r.shape.count > 0);
  if (errs.length) {
    registry.release(P + "Error");
    const errObjs = errs.filter((r) => r.shape.object && !r.shape.array);
    const distinctErr = errObjs.length >= 2 && errObjs.length === errs.length && errObjs.every((a, i) => errObjs.every((b, j) => i === j || keyJaccard(a.shape, b.shape) < 0.5));
    if (distinctErr) {
      const byStatusErr = new Map(errObjs.map((r) => [r.status, registry.fromShape(r.shape, [`${P}Error${r.status}`, `${P}ErrorBody${r.status}`], undefined)]));
      error = { type: { k: "union", options: [...byStatusErr.values()] }, typeName: P + "Error", byStatus: byStatusErr };
    } else {
      let es: Shape = emptyShape();
      for (const r of errs) es = mergeShapes(es, r.shape);
      error = { type: registry.fromShape(es, [P + "Error", P + "ErrorBody"], undefined), typeName: P + "Error" };
      if (error.type.k === "ref" && error.type.name !== error.typeName && registry.isTaken(error.typeName)) error.typeName = P + "ErrorBody";
    }
  }

  const foreignOrigin = ep.origin !== model.primaryOrigin ? ep.origin : undefined;
  return {
    ep,
    pascalName: P,
    pathParams,
    queryParams,
    paramsTypeName: pathParams.length || queryParams.length ? P + "Params" : undefined,
    body,
    response: { type, typeName, kind, status: ok[0]?.status, ...(byStatus ? { byStatus } : {}) },
    ...(error ? { error } : {}),
    foreignOrigin,
  };
}

function keyJaccard(a: Shape, b: Shape): number {
  const A = new Set(a.object?.props.keys() ?? []);
  const B = new Set(b.object?.props.keys() ?? []);
  let inter = 0;
  for (const k of A) if (B.has(k)) inter++;
  const union = A.size + B.size - inter;
  return union ? inter / union : 1;
}

/** Params arrive as text: integers stay numbers, everything else is a string-ish union. */
function scalarParam(t: TypeNode): TypeNode {
  if (t.k === "unknown" || t.k === "null") return { k: "string" };
  if (t.k === "union") {
    const opts = t.options.filter((o) => o.k !== "null");
    if (opts.length === 1) return opts[0]!;
    if (opts.every((o) => o.k === "integer" || o.k === "number")) return { k: "number" };
    return { k: "union", options: opts.map((o) => (o.k === "string" ? { k: "string" } : o)) };
  }
  return t;
}

function visitOp(op: PlannedOp, fn: (t: TypeNode) => void): void {
  fn(op.response.type);
  if (op.error) fn(op.error.type);
  if (op.body) fn(op.body.type);
  op.pathParams.forEach((p) => fn(p.type));
  op.queryParams.forEach((p) => fn(p.type));
}

function renameTypes(registry: TypeRegistry, ops: PlannedOp[], map: Record<string, string>, warnings: string[]): void {
  const rename = new Map<string, string>();
  for (const [from, to] of Object.entries(map)) {
    const nt = registry.get(from);
    if (!nt) {
      warnings.push(`No generated type named "${from}" to rename.`);
      continue;
    }
    // Two types renamed to one name would merge silently (interfaces with one name merge).
    if (!isIdentifier(to) || registry.isTaken(to) || [...rename.values()].includes(to)) {
      warnings.push(`Can't rename type "${from}" to "${to}" (invalid or already used).`);
      continue;
    }
    rename.set(from, to);
  }
  if (!rename.size) return;
  const visit = (t: TypeNode): void => {
    if (t.k === "ref") t.name = rename.get(t.name) ?? t.name;
    else if (t.k === "array") visit(t.items);
    else if (t.k === "map") visit(t.values);
    else if (t.k === "union") t.options.forEach(visit);
  };
  for (const nt of registry.types as NamedType[]) {
    nt.props.forEach((p) => visit(p.type));
  }
  for (const op of ops) visitOp(op, visit);
  for (const nt of registry.types) {
    const to = rename.get(nt.name);
    if (to) nt.name = to;
  }
  registry.renameAliases(rename);
}

/** Throws unless `url` is an absolute http(s) URL: it becomes the SDK's default base URL. */
export function checkBaseUrl(url: string): void {
  let ok = false;
  try {
    ok = /^https?:$/.test(new URL(url).protocol);
  } catch {
    ok = false;
  }
  if (!ok) throw new Error(`Invalid base URL ${JSON.stringify(url.slice(0, 80))} (--base-url): use an absolute http(s) URL such as https://api.example.com.`);
}

/** Names every object has (from Object.prototype): not usable as optional parameter names. */
const OBJECT_MEMBERS = new Set(Object.getOwnPropertyNames(Object.prototype));
