/**
 * Annotations: human- or Claude-written overrides layered on top of the
 * deterministic output. Stored as `har2sdk.annotations.json` next to the SDK so
 * re-running the generator on a fresh capture keeps the good names.
 *
 * {
 *   "clientName": "ShopClient",
 *   "endpoints": {
 *     "GET /api/v1/products/{productId}": {
 *       "name": "getProduct",
 *       "description": "Fetch a single product with price and stock.",
 *       "tag": "catalog",
 *       "params": { "productId": "id" }
 *     }
 *   },
 *   "types": { "Item2": "OrderLine" }
 * }
 */
import { z } from "zod";
import { fencedBody } from "./linear.js";
import type { ApiModel } from "./model.js";
import { RESERVED_METHOD_NAMES } from "./naming.js";
import { tokenText } from "./template.js";
import { isIdentifier, pascal, safeIdentifier } from "./words.js";

export interface EndpointAnnotation {
  /** camelCase SDK method name. */
  name?: string;
  /** One or two sentences describing what the endpoint does. */
  description?: string;
  /** Group name (becomes an OpenAPI tag). */
  tag?: string;
  /** Rename path/query parameters: { oldName: newName }. */
  params?: Record<string, string>;
}

export interface Annotations {
  clientName?: string;
  endpoints?: Record<string, EndpointAnnotation>;
  /** Rename generated types: { GeneratedName: BetterName }. */
  types?: Record<string, string>;
}

/** The annotation file's shape: what a person or a model may write (extra keys are ignored). */
export const ANNOTATIONS_SCHEMA = z.object({
  clientName: z.string().optional(),
  endpoints: z
    .record(
      z.string(),
      z.object({
        name: z.string().optional(),
        description: z.string().optional(),
        tag: z.string().optional(),
        params: z.record(z.string(), z.string()).optional(),
      }),
    )
    .optional(),
  types: z.record(z.string(), z.string()).optional(),
});

export function parseAnnotations(text: string): Annotations {
  // Accept a chat reply as-is: strip prose and ```json fences around the object.
  const fenced = fencedBody(text);
  const body = fenced !== undefined ? fenced : text.slice(Math.max(0, text.indexOf("{")), text.lastIndexOf("}") + 1);
  const data: unknown = JSON.parse(body);
  if (typeof data !== "object" || data === null || Array.isArray(data)) throw new Error("Annotations must be a JSON object");
  // A model's reply can have the wrong types ("name": 123): say where, don't crash later.
  const parsed = ANNOTATIONS_SCHEMA.safeParse(data);
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 5).map((i) => `${pathText(i.path)}: ${i.message}`);
    throw new Error(`Annotations don't match the expected format — ${issues.join("; ")}`);
  }
  return parsed.data as Annotations;
}

/** `["endpoints", "GET /x", "name"]` → `endpoints["GET /x"].name`. */
function pathText(path: readonly PropertyKey[]): string {
  if (!path.length) return "(the object)";
  return path
    .map((p, i) => (typeof p === "number" ? `[${p}]` : isIdentifier(String(p)) ? (i ? "." : "") + String(p) : `[${JSON.stringify(String(p))}]`))
    .join("");
}

/** Mutates the model in place. Returns human-readable warnings. */
export function applyAnnotations(model: ApiModel, ann: Annotations | undefined): string[] {
  const warnings: string[] = [];
  if (!ann?.endpoints) return warnings;
  const byId = new Map(model.endpoints.map((e) => [e.id, e]));
  const taken = new Set(model.endpoints.map((e) => e.name));

  for (const [id, a] of Object.entries(ann.endpoints)) {
    const ep = byId.get(id);
    if (!ep) {
      warnings.push(`Annotation for unknown endpoint "${id}" was ignored.`);
      continue;
    }
    if (a.name && a.name !== ep.name) {
      const name = isIdentifier(a.name) ? a.name : safeIdentifier(a.name);
      if (RESERVED_METHOD_NAMES.has(name)) warnings.push(`Name "${name}" for "${id}" is reserved (the client uses it, or it would make the client a thenable); kept "${ep.name}".`);
      else if (taken.has(name)) warnings.push(`Name "${name}" for "${id}" is already used; kept "${ep.name}".`);
      else {
        taken.delete(ep.name);
        taken.add(name);
        ep.name = name;
      }
    }
    if (a.description) ep.description = a.description.trim();
    if (a.tag) ep.tag = a.tag.trim();
    if (a.params) {
      for (const [from, toRaw] of Object.entries(a.params)) {
        const to = safeIdentifier(toRaw);
        const pp = ep.pathParams.find((p) => p.name === from);
        const qp = ep.queryParams.find((p) => p.name === from);
        const clash = [...ep.pathParams, ...ep.queryParams].some((p) => p.name === to && p.name !== from);
        if (clash) {
          warnings.push(`Can't rename "${from}" to "${to}" on "${id}": name already used.`);
          continue;
        }
        if (pp) {
          pp.name = to;
          pp.wireName = to;
          for (const t of ep.tokens) if (t.kind === "param" && t.name === from) t.name = to;
          ep.path = "/" + ep.tokens.map(tokenText).join("/");
        } else if (qp) {
          qp.name = to; // wireName stays: that's what the server expects
        } else warnings.push(`No parameter "${from}" on "${id}".`);
      }
    }
  }
  return warnings;
}

/** Names the generated module already uses (or that shadow globals it needs). */
const RESERVED_CLASS_NAMES = new Set(
  (
    "ApiError GraphQLError RpcError ClientOptions RequestOptions QueryValue DEFAULT_HEADERS DEFAULT_BASE_URL URL URLSearchParams " +
    "Error Object Array String Number Boolean Promise Record Response Request Headers FormData Blob JSON Map Set Date Symbol " +
    "Parameters NonNullable AbortSignal globalThis fetch enc"
  ).split(" "),
);
const RESERVED_WORDS = new Set("break case catch class const continue debugger default delete do else enum export extends false finally for function if import in instanceof new null return super switch this throw true try typeof var void while with let static yield await implements interface package private protected public".split(" "));

export function isValidClientName(name: string): boolean {
  return isIdentifier(name) && !RESERVED_CLASS_NAMES.has(name) && !RESERVED_WORDS.has(name);
}

export function clientNameFor(model: ApiModel, ann?: Annotations): string {
  if (ann?.clientName && isValidClientName(ann.clientName)) return ann.clientName;
  return defaultClientName(model.primaryOrigin);
}

export function defaultClientName(origin: string): string {
  try {
    const host = new URL(origin).hostname;
    if (host === "localhost" || /^[\d.]+$/.test(host) || host.startsWith("[")) return "ApiClient";
    let parts = host.split(".").filter((p) => !/^(www|api|app|m|web|gateway|backend|prod|staging|dev)$/.test(p));
    // Two-level public suffixes: example.co.uk, acme.com.tr, foo.com.au …
    if (parts.length >= 3 && /^(co|com|org|net|gov|edu|ac|ne|or|gen|biz|info|bel|k12)$/.test(parts[parts.length - 2]!) && parts[parts.length - 1]!.length === 2) {
      parts = parts.slice(0, -1);
    }
    const name = parts.length >= 2 ? parts[parts.length - 2]! : parts[0] ?? "Api";
    let cls = pascal(name) + "Client";
    if (!/^[A-Za-z_]/.test(cls)) cls = "Api" + cls; // 9gag.com → Api9gagClient
    return isValidClientName(cls) ? cls : "ApiClient";
  } catch {
    return "ApiClient";
  }
}
