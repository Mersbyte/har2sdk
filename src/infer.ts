/**
 * Structural type inference from many JSON samples.
 *
 * Every observed value is folded into a {@link Shape}. A Shape is a union of
 * "variants" (null / boolean / number / string / array / object / map), so
 * merging two samples is just merging variant by variant. Optional object
 * properties fall out naturally: a property seen in fewer samples than its
 * parent object is optional.
 */
import { isDataKey, isPersonalName, isSecretValue, isSensitiveName } from "./redact.js";

export type StringFormat = "date-time" | "date" | "uuid" | "email" | "uri";

export interface StringInfo {
  count: number;
  /** How many observations matched each format. */
  formats: Partial<Record<StringFormat, number>>;
  /** Distinct values seen (null once we've seen too many, or if sensitive). */
  distinct: Map<string, number> | null;
}

export interface Shape {
  /** Total observations folded into this shape. */
  count: number;
  null?: number;
  boolean?: number;
  number?: { count: number; integer: boolean };
  string?: StringInfo;
  array?: { count: number; items: Shape };
  object?: { count: number; props: Map<string, Shape> };
  /** Objects whose keys are ids (e.g. `{ "1042": {...}, "1043": {...} }`). */
  map?: { count: number; values: Shape };
}

const MAX_DISTINCT = 24;
const MAX_ARRAY_ITEMS = 200;

export function emptyShape(): Shape {
  return { count: 0 };
}

export interface ObserveOptions {
  /** Treat this value as sensitive: never record its literal values. */
  sensitive?: boolean;
}

export function observe(shape: Shape, value: unknown, opts: ObserveOptions = {}): Shape {
  shape.count++;
  if (value === null || value === undefined) {
    shape.null = (shape.null ?? 0) + 1;
  } else if (typeof value === "boolean") {
    shape.boolean = (shape.boolean ?? 0) + 1;
  } else if (typeof value === "number") {
    const n = (shape.number ??= { count: 0, integer: true });
    n.count++;
    if (!Number.isInteger(value)) n.integer = false;
  } else if (typeof value === "string") {
    observeString((shape.string ??= { count: 0, formats: {}, distinct: new Map() }), value, opts.sensitive);
  } else if (Array.isArray(value)) {
    const a = (shape.array ??= { count: 0, items: emptyShape() });
    a.count++;
    for (const item of value.slice(0, MAX_ARRAY_ITEMS)) observe(a.items, item, opts);
  } else if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (looksLikeIdKeyedMap(entries.map(([k]) => k))) {
      const m = (shape.map ??= { count: 0, values: emptyShape() });
      m.count++;
      for (const [, v] of entries.slice(0, MAX_ARRAY_ITEMS)) observe(m.values, v, opts);
    } else {
      const o = (shape.object ??= { count: 0, props: new Map() });
      o.count++;
      for (const [k, v] of entries) {
        let child = o.props.get(k);
        if (!child) o.props.set(k, (child = emptyShape()));
        observe(child, v, { sensitive: opts.sensitive || isSensitiveName(k) || isPersonalName(k) });
      }
    }
  }
  return shape;
}

/** Observe a value that arrived as text (query string, path segment, form field). */
export function observeText(shape: Shape, value: string, opts: ObserveOptions = {}): Shape {
  // ≤ 15 digits: larger ids (tweet ids, snowflakes) would lose precision as numbers.
  if (/^-?(0|[1-9]\d{0,14})$/.test(value)) return observe(shape, Number(value), opts);
  if (/^-?\d+\.\d+$/.test(value) && value.length < 18) return observe(shape, Number(value), opts);
  if (value === "true" || value === "false") return observe(shape, value === "true", opts);
  return observe(shape, value, opts);
}

const RE = {
  dateTime: /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/,
  date: /^\d{4}-\d{2}-\d{2}$/,
  uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  email: /^[^\s@]+@[^\s@]+\.[A-Za-z]{2,}$/,
  uri: /^https?:\/\/[^\s]+$/,
};

function observeString(s: StringInfo, value: string, sensitive?: boolean): void {
  s.count++;
  if (RE.dateTime.test(value)) bump(s.formats, "date-time");
  else if (RE.date.test(value)) bump(s.formats, "date");
  if (RE.uuid.test(value)) bump(s.formats, "uuid");
  if (RE.email.test(value)) bump(s.formats, "email");
  if (RE.uri.test(value)) bump(s.formats, "uri");
  if (s.distinct) {
    if (sensitive || isSecretValue(value) || value.length > 40) {
      s.distinct = null;
    } else {
      s.distinct.set(value, (s.distinct.get(value) ?? 0) + 1);
      if (s.distinct.size > MAX_DISTINCT) s.distinct = null;
    }
  }
}

function bump(rec: Partial<Record<StringFormat, number>>, f: StringFormat): void {
  rec[f] = (rec[f] ?? 0) + 1;
}

export { isDataKey } from "./redact.js";

function looksLikeIdKeyedMap(keys: string[]): boolean {
  if (!keys.length) return false;
  // One email- or id-keyed entry is already a map: its key must never become a property name.
  if (keys.length === 1) return isDataKey(keys[0]!) && !/^\d{1,3}$/.test(keys[0]!);
  return keys.every(isDataKey);
}

/** The single format every observed string matched, if any. */
export function stringFormat(s: StringInfo): StringFormat | undefined {
  for (const f of ["date-time", "date", "uuid", "email", "uri"] as StringFormat[]) {
    if (s.formats[f] === s.count) return f;
  }
  return undefined;
}

/**
 * A small set of literal values that repeat a lot → enum-ish.
 * Deliberately conservative: we only see a sample of real traffic.
 */
export function stringEnum(s: StringInfo): string[] | undefined {
  if (!s.distinct || s.count < 6) return undefined;
  const values = [...s.distinct.keys()];
  if (values.length < 2 || values.length > 8 || values.length * 2 > s.count) return undefined;
  if (stringFormat(s)) return undefined;
  // Enum-ish casing only: "shipped", "price_asc", "in-stock", "USD", "ADMIN".
  if (!(values.every((v) => /^[a-z][a-z0-9_.-]{0,31}$/.test(v)) || values.every((v) => /^[A-Z][A-Z0-9_.-]{0,31}$/.test(v)))) return undefined;
  // "ord-77314", "C07QW9XHK": identifiers, not categories.
  if (values.some((v) => /\d{3,}/.test(v) || (/\d/.test(v) && v.length >= 7))) return undefined;
  return values.sort();
}

export function mergeShapes(a: Shape, b: Shape): Shape {
  const out: Shape = { count: a.count + b.count };
  if (a.null || b.null) out.null = (a.null ?? 0) + (b.null ?? 0);
  if (a.boolean || b.boolean) out.boolean = (a.boolean ?? 0) + (b.boolean ?? 0);
  if (a.number || b.number) {
    out.number = {
      count: (a.number?.count ?? 0) + (b.number?.count ?? 0),
      integer: (a.number?.integer ?? true) && (b.number?.integer ?? true),
    };
  }
  if (a.string || b.string) {
    const blank: StringInfo = { count: 0, formats: {}, distinct: new Map() };
    const sa: StringInfo = a.string ?? blank;
    const sb: StringInfo = b.string ?? { ...blank, distinct: new Map() };
    const formats: Partial<Record<StringFormat, number>> = {};
    for (const f of new Set([...Object.keys(sa.formats), ...Object.keys(sb.formats)]) as Set<StringFormat>) {
      formats[f] = (sa.formats[f] ?? 0) + (sb.formats[f] ?? 0);
    }
    let distinct: Map<string, number> | null = null;
    if (sa.distinct && sb.distinct) {
      distinct = new Map(sa.distinct);
      for (const [k, v] of sb.distinct) distinct.set(k, (distinct.get(k) ?? 0) + v);
      if (distinct.size > MAX_DISTINCT) distinct = null;
    }
    out.string = { count: sa.count + sb.count, formats, distinct };
  }
  if (a.array || b.array) {
    out.array = {
      count: (a.array?.count ?? 0) + (b.array?.count ?? 0),
      items: mergeShapes(a.array?.items ?? emptyShape(), b.array?.items ?? emptyShape()),
    };
  }
  if (a.object || b.object) {
    const props = new Map<string, Shape>();
    for (const src of [a.object, b.object]) {
      if (!src) continue;
      for (const [k, v] of src.props) {
        const prev = props.get(k);
        props.set(k, prev ? mergeShapes(prev, v) : v);
      }
    }
    out.object = { count: (a.object?.count ?? 0) + (b.object?.count ?? 0), props };
  }
  if (a.map || b.map) {
    out.map = {
      count: (a.map?.count ?? 0) + (b.map?.count ?? 0),
      values: mergeShapes(a.map?.values ?? emptyShape(), b.map?.values ?? emptyShape()),
    };
  }
  return out;
}

/** Top-level keys of an object shape (or of array items), used for similarity. */
export function topLevelKeys(shape: Shape | undefined): Set<string> {
  const keys = new Set<string>();
  if (!shape) return keys;
  if (shape.object) for (const k of shape.object.props.keys()) keys.add(k);
  if (shape.array?.items.object) for (const k of shape.array.items.object.props.keys()) keys.add("[]." + k);
  if (shape.map) keys.add("{map}");
  return keys;
}

export function isEmptyShape(shape: Shape | undefined): boolean {
  return !shape || shape.count === 0;
}
