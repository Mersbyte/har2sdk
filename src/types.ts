/**
 * Shapes → named types.
 *
 * The {@link TypeRegistry} turns inferred {@link Shape}s into a small type IR
 * where every object becomes a *named* type. Structurally identical objects are
 * de-duplicated, so the `User` returned by `GET /users/{id}` and the items of
 * `GET /users` collapse into one interface when they really are the same.
 * Two printers render the IR: TypeScript and JSON Schema (for OpenAPI 3.1).
 */
import { isDataKey, mergeShapes, stringEnum, stringFormat, type Shape, type StringFormat } from "./infer.js";
import { isAliasRecorded, isDataLike, isIdentity, isLabelOnly, isNamePart, isTainted, type Taint } from "./leak.js";
import { isIdentifier, pascal, propertyKey, singular, words } from "./words.js";

export type TypeNode =
  | { k: "unknown" }
  | { k: "null" }
  | { k: "boolean" }
  | { k: "integer" }
  | { k: "number" }
  | { k: "string"; format?: StringFormat; enum?: string[] }
  | { k: "array"; items: TypeNode }
  | { k: "map"; values: TypeNode }
  | { k: "record" }
  | { k: "ref"; name: string }
  | { k: "union"; options: TypeNode[] };

export interface PropNode {
  name: string;
  type: TypeNode;
  optional: boolean;
}

export interface NamedType {
  name: string;
  props: PropNode[];
  key: string;
  /** Structurally identical to this type: printed as `type Total = Price`. */
  aliasOf?: string;
}

export interface RegistryOptions {
  /** Emit literal unions for enum-like strings (default true). */
  enums?: boolean;
  /** Names that must not be used for generated types. */
  reserved?: Iterable<string>;
  /** Recorded values: never used as enum members or property names. */
  taint?: Taint;
}

const GLOBAL_NAMES = new Set(
  (
    "Array Boolean Date Error Function Map Number Object Promise Record RegExp Set String Symbol URL Response Request Headers " +
    "FormData Blob File Event Element Node Document Window Location History Storage Image Text Comment Range Selection Partial " +
    "Required Readonly Pick Omit Exclude Extract Awaited Uint8Array JSON Math Intl Notification Credential Performance Screen " +
    "Navigator Worker Cache Client Body Animation Position Attr Audio Option Plugin Touch Gamepad Crypto Lock " +
    // Everything the generated runtime refers to by name, plus common lib types.
    "Parameters ReturnType NonNullable InstanceType ConstructorParameters ThisType Uppercase Lowercase Capitalize Uncapitalize " +
    "AbortSignal AbortController URLSearchParams RequestInit BodyInit HeadersInit Iterable AsyncIterable PromiseLike ArrayLike " +
    "ReadonlyArray ReadonlyMap ReadonlySet WeakMap WeakSet BigInt Infinity NaN TextEncoder TextDecoder ReadableStream " +
    "WritableStream WebSocket EventSource EventTarget Buffer Proxy Reflect ArrayBuffer DataView Int8Array Float64Array"
  ).split(" "),
);

const GENERIC_CONTAINERS = new Set([
  "items",
  "data",
  "results",
  "result",
  "records",
  "rows",
  "list",
  "entries",
  "hits",
  "nodes",
  "node",
  "edges",
  "content",
  "payload",
  "objects",
  "elements",
  "values",
]);

export class TypeRegistry {
  readonly types: NamedType[] = [];
  private byName = new Map<string, NamedType>();
  private byKey = new Map<string, NamedType>();
  private reserved: Set<string>;
  private enums: boolean;
  private taint: Taint | undefined;

  constructor(opts: RegistryOptions = {}) {
    this.enums = opts.enums ?? true;
    this.taint = opts.taint;
    this.reserved = new Set([...GLOBAL_NAMES, ...(opts.reserved ?? [])]);
  }

  /** Reserve a name (e.g. a type alias) so no object type takes it. */
  reserve(name: string): void {
    this.reserved.add(name);
  }

  /** Undo {@link reserve} right before the owner of the name claims it. */
  release(name: string): void {
    this.reserved.delete(name);
  }

  isTaken(name: string): boolean {
    return this.reserved.has(name) || this.byName.has(name);
  }

  get(name: string): NamedType | undefined {
    return this.byName.get(name);
  }

  /**
   * @param hints preferred names for objects found at this level, best first.
   * @param resource the REST resource name (e.g. "Product"), used for items
   *   inside generic envelopes like `{ items: [...] }` or `{ data: {...} }`.
   */
  fromShape(shape: Shape | undefined, hints: string[], resource?: string, field?: string): TypeNode {
    if (!shape || shape.count === 0) return { k: "unknown" };
    const options: TypeNode[] = [];
    if (shape.boolean) options.push({ k: "boolean" });
    // A handful of samples can't tell 10 from 10.5: only say "integer" with evidence.
    if (shape.number) options.push({ k: shape.number.integer && shape.number.count >= 3 ? "integer" : "number" });
    if (shape.string) {
      const format = stringFormat(shape.string);
      // Literal unions only for fields whose *name* says they're categorical:
      // `status: "open" | "closed"` yes, `createdBy: "mdemir" | "okilic"` no.
      let en = this.enums && field && isEnumField(field) ? stringEnum(shape.string) : undefined;
      if (en && en.some((v) => isDataLike(v) || isTainted(this.taint, v) || isIdentity(this.taint, v) || isNamePart(this.taint, v))) en = undefined;
      options.push({ k: "string", ...(format ? { format } : {}), ...(en ? { enum: en } : {}) });
    }
    if (shape.array) options.push({ k: "array", items: this.fromShape(shape.array.items, hints, resource, field) });
    let map = shape.map;
    if (shape.object && this.keysAreData(shape.object)) {
      // Keys that are data (emails, ids, one-off values) make a map, never properties.
      let values: Shape = map?.values ?? { count: 0 };
      for (const v of shape.object.props.values()) values = mergeShapes(values, v);
      map = { count: (map?.count ?? 0) + shape.object.count, values };
    } else if (shape.object) {
      options.push(shape.object.props.size === 0 ? { k: "record" } : this.intern(shape.object, hints, resource, field));
    }
    if (map) options.push({ k: "map", values: this.fromShape(map.values, hints, resource) });
    if (shape.null) options.push({ k: "null" });
    if (options.length === 0) return { k: "unknown" };
    if (options.length === 1) return options[0]!;
    return { k: "union", options };
  }

  /**
   * Object keys that are recorded data: any key that looks like an email/id or
   * was itself recorded as a value, or many keys each seen exactly once across
   * several samples (a dictionary keyed by something that varies).
   */
  private keysAreData(obj: NonNullable<Shape["object"]>): boolean {
    const keys = [...obj.props.keys()];
    if (!keys.length) return false;
    // A key that is shaped like data, or that the capture uses as a user/tenant name.
    if (keys.some((k) => isDataKey(k) || isIdentity(this.taint, k) || isAliasRecorded(this.taint, k))) return true;
    // A key that is, character for character, a secret recorded under a token/password/key field, even when
    // it is the object's only key. (A key that merely shares a word with a recorded name keeps its property.)
    if (keys.some((k) => this.taint?.secrets.has(k.trim().toLowerCase()))) return true;
    // A dictionary: 3+ keys whose values are all objects with the same fields, and at
    // least one of those keys is recorded as data elsewhere ({ okilic: {…}, mdemir: {…} }).
    if (keys.length >= 3) {
      const props = [...obj.props.values()];
      const sig = (p: Shape) => (p.object ? [...p.object.props.keys()].sort().join(",") : "");
      const first = sig(props[0]!);
      if (first && props.every((p) => sig(p) === first) && keys.some((k) => isTainted(this.taint, k))) return true;
    }
    // Two or more same-shaped entries, every key recorded as data: { oguz: {score}, mehmet: {score} }.
    if (keys.length >= 2) {
      const props = [...obj.props.values()];
      const first = shapeSig(props[0]!);
      // Labels (a line item called "Shipping") don't count: they name things, and so do property names.
      if (props.every((p) => shapeSig(p) === first) && keys.every((k) => isTainted(this.taint, k) && !isLabelOnly(this.taint, k))) return true;
    }
    const once = [...obj.props.values()].filter((p) => p.count === 1).length;
    return obj.count >= 3 && keys.length >= 6 && once === keys.length && keys.length >= obj.count * 2;
  }

  private intern(obj: NonNullable<Shape["object"]>, hints: string[], resource?: string, field?: string): TypeNode {
    const parent = cleanTypeName(hints[0] ?? "") || "Item";
    const props: PropNode[] = [];
    for (const [name, child] of obj.props) {
      // Only collections get singularised: `items: Item[]`, but `openingHours: OpeningHours`.
      const base = pascal(child.array && !child.object ? singularLast(name) : name);
      let propHints: string[];
      if (GENERIC_CONTAINERS.has(name.toLowerCase()) && resource) propHints = [resource, parent + base];
      else if (base && /^[A-Z]/.test(base)) propHints = [base, parent + base];
      else propHints = [parent + "Item"];
      const childResource = GENERIC_CONTAINERS.has(name.toLowerCase()) ? resource : undefined;
      props.push({ name, type: this.fromShape(child, propHints, childResource, name), optional: child.count < obj.count });
    }
    const key = JSON.stringify(
      [...props].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)).map((p) => [p.name, p.optional, this.typeKey(p.type)]),
    );
    const existing = this.byKey.get(key) ?? this.findCompatible(props);
    if (existing) {
      // Same shape, unrelated meaning (`category` and `brand` are both {id, name}):
      // keep a separately named copy so code reads naturally. Related names
      // (`price` / `unitPrice`) and generic ones share one type.
      const wanted = cleanTypeName(hints[0] ?? "");
      if (field !== undefined && wanted && wanted !== existing.name && !namesRelated(wanted, existing.name)) {
        const same = this.byName.get(wanted);
        if (same && same.key === existing.key) return { k: "ref", name: same.name };
        if (!this.isTaken(wanted)) {
          // An alias, not a copy: `export type Total = Price`.
          const twin: NamedType = { name: wanted, props: existing.props, key: existing.key, aliasOf: existing.name };
          this.types.push(twin);
          this.byName.set(wanted, twin);
          this.noteHint(twin, hints);
          return { k: "ref", name: wanted };
        }
      }
      this.byKey.set(key, existing);
      this.noteHint(existing, hints);
      return { k: "ref", name: existing.name };
    }

    const name = this.pickName(hints);
    const named: NamedType = { name, props, key };
    this.types.push(named);
    this.byName.set(name, named);
    this.byKey.set(key, named);
    this.noteHint(named, hints);
    return { k: "ref", name };
  }

  private hintCounts = new Map<NamedType, Map<string, number>>();

  private noteHint(nt: NamedType, hints: string[]): void {
    const h = cleanTypeName(hints[0] ?? "");
    if (!h) return;
    let m = this.hintCounts.get(nt);
    if (!m) this.hintCounts.set(nt, (m = new Map()));
    m.set(h, (m.get(h) ?? 0) + 1);
  }

  /**
   * Same property names & optionality, and every property either identical or
   * one side unknown (e.g. an empty array seen in one response) → same type.
   * The existing type is upgraded in place with the more specific property types.
   */
  private findCompatible(props: PropNode[]): NamedType | undefined {
    const names = props.map((p) => p.name + (p.optional ? "?" : "")).sort().join(",");
    for (const nt of this.types) {
      if (nt.props.length !== props.length) continue;
      if (nt.props.map((p) => p.name + (p.optional ? "?" : "")).sort().join(",") !== names) continue;
      const pairs = props.map((p) => [nt.props.find((q) => q.name === p.name)!, p] as const);
      const numeric = (x: TypeNode, y: TypeNode) => (x.k === "integer" || x.k === "number") && (y.k === "integer" || y.k === "number");
      const same = (x: TypeNode, y: TypeNode) => this.typeKey(x) === this.typeKey(y);
      if (!pairs.every(([a, b]) => same(a.type, b.type) || isVague(a.type) || isVague(b.type) || numeric(a.type, b.type))) continue;
      if (pairs.every(([a, b]) => same(a.type, b.type))) continue; // exact match is handled by key
      for (const [a, b] of pairs) {
        if (isVague(a.type) && !isVague(b.type)) a.type = b.type;
        else if (numeric(a.type, b.type) && b.type.k === "number") a.type = { k: "number" };
      }
      return nt;
    }
    return undefined;
  }

  /**
   * Rename types to the hint most often used for them (e.g. a money object first
   * seen as `unitPrice` but mostly found under `price` becomes `Price`).
   * Returns the renames so callers can update their own references.
   */
  finalizeNames(): Map<string, string> {
    const renames = new Map<string, string>();
    for (const nt of this.types) {
      const m = this.hintCounts.get(nt);
      if (!m || m.size < 2) continue;
      // Most frequent hint wins; ties go to the shorter, more general name.
      const sorted = [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].length - b[0].length);
      const [best, bestCount] = sorted[0]!;
      const current = m.get(nt.name) ?? 0;
      const better = bestCount > current || (bestCount === current && best.length < nt.name.length);
      if (best === nt.name || !better || this.isTaken(best)) continue;
      renames.set(nt.name, best);
      this.byName.delete(nt.name);
      nt.name = best;
      this.byName.set(best, nt);
    }
    if (renames.size) {
      const visit = (t: TypeNode): void => renameRefs(t, renames);
      for (const nt of this.types) nt.props.forEach((p) => visit(p.type));
      this.renameAliases(renames);
    }
    return renames;
  }

  /** Keep `aliasOf` pointing at the right type after renames. */
  renameAliases(renames: Map<string, string>): void {
    for (const nt of this.types) {
      if (nt.aliasOf) nt.aliasOf = renames.get(nt.aliasOf) ?? nt.aliasOf;
      if (nt.aliasOf === nt.name) delete nt.aliasOf;
    }
  }

  private pickName(hints: string[]): string {
    const clean = hints.map(cleanTypeName).filter(Boolean);
    if (!clean.length) clean.push("Item");
    for (const h of clean) if (!this.isTaken(h)) return h;
    for (const h of clean) if (!this.isTaken(h + "Data")) return h + "Data";
    const base = clean[0]!;
    let n = 2;
    while (this.isTaken(base + n)) n++;
    return base + n;
  }

  /** A short id per distinct type key: a ref's key names its target by id, so keys don't nest. */
  private keyIds = new Map<string, number>();

  private keyId(key: string): number {
    let id = this.keyIds.get(key);
    if (id === undefined) this.keyIds.set(key, (id = this.keyIds.size));
    return id;
  }

  /**
   * A structural key: equal for equal types. A reference contributes its
   * target's key id, not the key itself — embedding it (escaped again by
   * every enclosing level) doubled the key per level of nesting.
   */
  private typeKey(t: TypeNode): string {
    switch (t.k) {
      case "ref": {
        const key = this.byName.get(t.name)?.key;
        return key === undefined ? "@" + t.name : "#" + this.keyId(key);
      }
      case "array":
        return "[" + this.typeKey(t.items) + "]";
      case "map":
        return "{" + this.typeKey(t.values) + "}";
      case "union":
        return t.options.map((o) => this.typeKey(o)).join("|");
      case "string":
        return "s" + (t.format ?? "") + (t.enum ? ":" + t.enum.join(",") : "");
      default:
        return t.k;
    }
  }
}

/** What kind of value a shape holds, for comparing dictionary entries: object fields, or scalar kinds. */
function shapeSig(p: Shape): string {
  if (p.object) return "{" + [...p.object.props.keys()].sort().join(",") + "}";
  return ["null", "boolean", "number", "string", "array", "map"].filter((k) => p[k as keyof Shape] !== undefined).join("|");
}

const ENUM_WORDS = new Set(
  (
    // Technical, low-risk categories only. "category", "source", "reason", "condition", "provider"… often hold
    // sensitive vocabulary (a medical specialty, a username) and stay plain strings.
    "status state type kind role level tier mode stage phase priority severity method currency unit format variant plan " +
    "visibility sort order direction channel platform action locale lang language country size " +
    "interval period frequency permission access strategy availability environment env"
  ).split(" "),
);

/** Fields that hold identifiers even if another word sounds categorical: orderNumber, channelId, sourceRef. */
const ID_WORDS = new Set("id ids uuid guid number num no nr code key ref reference slug name token hash handle sku serial".split(" "));

export function isEnumField(name: string): boolean {
  const w = words(name);
  if (ID_WORDS.has(w[w.length - 1] ?? "")) return false;
  return w.some((x) => ENUM_WORDS.has(x));
}

const GENERIC_NAMES = new Set(["item", "data", "response", "result", "value", "entry", "node", "body", "input", "info", "detail", "details"]);

/** Do two type names talk about the same thing? ("UnitPrice"/"Price" yes, "Brand"/"Category" no) */
function namesRelated(a: string, b: string): boolean {
  const wa = words(a).map(singular);
  const wb = new Set(words(b).map(singular));
  if (wa.some((w) => GENERIC_NAMES.has(w)) || [...wb].some((w) => GENERIC_NAMES.has(w))) return true;
  return wa.some((w) => wb.has(w));
}

function isVague(t: TypeNode): boolean {
  return t.k === "unknown" || (t.k === "array" && t.items.k === "unknown") || t.k === "record" || (t.k === "map" && t.values.k === "unknown");
}

export function renameRefs(t: TypeNode, renames: Map<string, string>): void {
  if (t.k === "ref") t.name = renames.get(t.name) ?? t.name;
  else if (t.k === "array") renameRefs(t.items, renames);
  else if (t.k === "map") renameRefs(t.values, renames);
  else if (t.k === "union") t.options.forEach((o) => renameRefs(o, renames));
}

function singularLast(name: string): string {
  const w = words(name);
  if (!w.length) return "";
  w[w.length - 1] = singular(w[w.length - 1]!);
  return w.join(" ");
}

function cleanTypeName(s: string): string {
  let n = pascal(s);
  if (!n) return "";
  if (/^[0-9]/.test(n)) n = "T" + n;
  return isIdentifier(n) ? n : "";
}

// --- TypeScript printer --------------------------------------------------------

export function printTs(t: TypeNode): string {
  switch (t.k) {
    case "unknown":
      return "unknown";
    case "null":
      return "null";
    case "boolean":
      return "boolean";
    case "integer":
    case "number":
      return "number";
    case "string":
      // Open union: autocomplete for values we saw, but any string still type-checks.
      return t.enum ? t.enum.map((v) => JSON.stringify(v)).join(" | ") + " | (string & {})" : "string";
    case "array": {
      const inner = printTs(t.items);
      return t.items.k === "union" || (t.items.k === "string" && t.items.enum) ? `Array<${inner}>` : `${inner}[]`;
    }
    case "map":
      return `Record<string, ${printTs(t.values)}>`;
    case "record":
      return "Record<string, unknown>";
    case "ref":
      return t.name;
    case "union":
      return t.options.map(printTs).join(" | ");
  }
}

export function printTsInterface(nt: NamedType, doc?: string): string {
  const lines: string[] = [];
  if (doc) lines.push(`/** ${doc} */`);
  if (nt.aliasOf) {
    lines.push(`export type ${nt.name} = ${nt.aliasOf};`);
    return lines.join("\n");
  }
  lines.push(`export interface ${nt.name} {`);
  for (const p of nt.props) {
    const fmt = formatOf(p.type);
    if (fmt) lines.push(`  /** @format ${fmt} */`);
    lines.push(`  ${propertyKey(p.name)}${p.optional ? "?" : ""}: ${printTs(p.type)};`);
  }
  lines.push("}");
  return lines.join("\n");
}

function formatOf(t: TypeNode): string | undefined {
  if (t.k === "string") return t.format;
  if (t.k === "union") {
    for (const o of t.options) if (o.k === "string" && o.format) return o.format;
  }
  return undefined;
}

// --- JSON Schema printer (OpenAPI 3.1) ----------------------------------------------

export type JsonSchema = Record<string, unknown>;

export function toJsonSchema(t: TypeNode, refPrefix = "#/components/schemas/"): JsonSchema {
  switch (t.k) {
    case "unknown":
      return {};
    case "null":
      return { type: "null" };
    case "boolean":
      return { type: "boolean" };
    case "integer":
      return { type: "integer" };
    case "number":
      return { type: "number" };
    case "string": {
      const s: JsonSchema = { type: "string" };
      if (t.format) s.format = t.format;
      if (t.enum) {
        s.examples = t.enum;
        s.description = `Observed values: ${t.enum.join(", ")}`;
      }
      return s;
    }
    case "array":
      return { type: "array", items: toJsonSchema(t.items, refPrefix) };
    case "map":
      return { type: "object", additionalProperties: toJsonSchema(t.values, refPrefix) };
    case "record":
      return { type: "object" };
    case "ref":
      return { $ref: refPrefix + t.name };
    case "union": {
      const simple = t.options.every((o) => ["null", "boolean", "integer", "number", "string"].includes(o.k) && !(o.k === "string" && (o.format || o.enum)));
      if (simple) return { type: t.options.map((o) => o.k) };
      return { anyOf: t.options.map((o) => toJsonSchema(o, refPrefix)) };
    }
  }
}

export function namedToJsonSchema(nt: NamedType, refPrefix = "#/components/schemas/"): JsonSchema {
  if (nt.aliasOf) return { $ref: refPrefix + nt.aliasOf };
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  for (const p of nt.props) {
    properties[p.name] = toJsonSchema(p.type, refPrefix);
    if (!p.optional) required.push(p.name);
  }
  const s: JsonSchema = { type: "object", properties };
  if (required.length) s.required = required;
  return s;
}
