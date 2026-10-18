/**
 * Secret & PII redaction.
 *
 * har2sdk only ever needs the *shape* of traffic. Anything that leaves the
 * engine (examples in OpenAPI, text handed to an LLM, the chat prompt) goes
 * through these functions first.
 */
import { setOwn, words } from "./words.js";

export const REDACTED = "<redacted>";

const SENSITIVE_WORDS = new Set([
  "password",
  "passwd",
  "pwd",
  "pass",
  "passphrase",
  "passcode",
  "secret",
  "token",
  "tokens",
  "authorization",
  "auth",
  "cookie",
  "cookies",
  "session",
  "sessionid",
  "sid",
  "csrf",
  "xsrf",
  "signature",
  "sig",
  "credential",
  "credentials",
  "otp",
  "totp",
  "mfa",
  "pin",
  "cvv",
  "cvc",
  "ssn",
  "apikey",
  "jwt",
  "bearer",
  "nonce",
  "privatekey",
  "key",
  "appid",
  "appkey",
  "tckn",
  "passport",
]);

const SENSITIVE_PAIRS: [string, string][] = [
  ["api", "key"],
  ["private", "key"],
  ["access", "key"],
  ["secret", "key"],
  ["client", "secret"],
  ["card", "number"],
  ["account", "number"],
  ["security", "code"],
];

/** Does this header / query / JSON key name look like it carries a secret? */
export function isSensitiveName(name: string): boolean {
  const w = words(name);
  if (w.some((x) => SENSITIVE_WORDS.has(x))) return true;
  for (let i = 0; i < w.length - 1; i++) {
    for (const [a, b] of SENSITIVE_PAIRS) if (w[i] === a && w[i + 1] === b) return true;
  }
  const joined = w.join("");
  return joined === "cardnumber" || joined === "creditcard" || joined === "apikey" || joined === "xapikey";
}

const JWT = /^eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*$/;
const BEARER = /^(bearer|basic|token|digest)\s+\S+/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[A-Za-z]{2,}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX = /^[0-9a-f]+$/i;
const KNOWN_KEY_PREFIX = /^(sk|rk|pk)_(live|test)_|^gh[pousr]_[A-Za-z0-9]{20,}|^xox[abprs]-|^AKIA[0-9A-Z]{16}$|^AIza[0-9A-Za-z_-]{30,}/;

/** Does this value look like a secret regardless of its key name? */
export function isSecretValue(value: string): boolean {
  const v = value.trim();
  if (v.length < 8) return false;
  if (JWT.test(v) || BEARER.test(v) || KNOWN_KEY_PREFIX.test(v)) return true;
  if (looksLikeCardNumber(v)) return true;
  // Long, high-entropy opaque strings are probably tokens. UUIDs and hex ids
  // are kept: they are identifiers and make examples far more useful.
  if (v.length >= 32 && /^[A-Za-z0-9_\-+/=.~]+$/.test(v) && !UUID.test(v) && !HEX.test(v)) {
    if (/[0-9]/.test(v) && /[A-Za-z]/.test(v) && entropy(v) >= 4) return true;
  }
  return false;
}

export function isEmail(value: string): boolean {
  return EMAIL.test(value.trim());
}

function looksLikeCardNumber(v: string): boolean {
  const digits = v.replace(/[\s-]/g, "");
  if (!/^\d{13,19}$/.test(digits) || !/^[\d\s-]+$/.test(v)) return false;
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

function entropy(s: string): number {
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  for (const c of counts.values()) {
    const p = c / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

/** Redact a single scalar given (optionally) the key it was found under. */
export function redactScalar(value: string, keyName?: string): string {
  if (keyName && isSensitiveName(keyName)) return REDACTED;
  if (isSecretValue(value)) return REDACTED;
  if (isEmail(value)) return "user@example.com";
  if (isPhone(value)) return REDACTED;
  return value;
}

/** "+90 216 000 00 00", "(555) 123-4567" — but not dates, versions or prices. */
function isPhone(value: string): boolean {
  const v = value.trim();
  const digits = v.replace(/\D/g, "").length;
  if (digits < 7 || digits > 15) return false;
  return /^\+\d[\d\s().-]{6,}$/.test(v) || /^\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}$/.test(v);
}

export interface RedactOptions {
  /** Truncate strings longer than this (default 200). */
  maxString?: number;
  /** Keep at most this many array items (default 3). */
  maxArray?: number;
  /** Max depth before replacing with "…" (default 8). */
  maxDepth?: number;
}

/** Deep-redact a JSON value for display / examples. Never mutates input. */
export function redactJson(value: unknown, opts: RedactOptions = {}, key?: string, depth = 0, inContact = false): unknown {
  const maxString = opts.maxString ?? 200;
  const maxArray = opts.maxArray ?? 3;
  const maxDepth = opts.maxDepth ?? 8;
  if (key && isSensitiveName(key) && value !== null && typeof value !== "object") {
    return typeof value === "string" ? REDACTED : typeof value === "number" ? 0 : value;
  }
  // Contact details (an address object, a phone field) are masked whole.
  const contact = inContact || (!!key && isContactName(key));
  if (contact && typeof value === "string") return REDACTED;
  if (typeof value === "string") {
    const r = redactScalar(value);
    return r.length > maxString ? r.slice(0, maxString) + "…" : r;
  }
  if (value === null || typeof value !== "object") return value;
  if (depth >= maxDepth) return "…";
  if (Array.isArray(value)) {
    return value.slice(0, maxArray).map((v) => redactJson(v, opts, key, depth + 1, contact));
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    setOwn(out, k, key && isSensitiveName(key) && typeof v !== "object" ? REDACTED : redactJson(v, opts, k, depth + 1, contact));
  }
  return out;
}

const CONTACT_WORDS = new Set([
  "email",
  "mail",
  "phone",
  "mobile",
  "tel",
  "telephone",
  "fax",
  "address",
  "street",
  "zip",
  "postal",
  "postcode",
  "iban",
  "birthday",
  "birthdate",
  "birth",
  "dob",
  "ip",
  "username",
  "nickname",
  "location",
  "lat",
  "lng",
  "lon",
  "latitude",
  "longitude",
  "geo",
  "coords",
  "coordinates",
  "passport",
  "tckn",
  "ssn",
  "diagnosis",
  "diagnoses",
  // tr, de, es, fr
  "dogum",
  "telefon",
  "adres",
  "adresse",
  "eposta",
  "kimlik",
  "tc",
  "gsm",
  "geburt",
  "geburtsdatum",
  "nacimiento",
  "naissance",
  "direccion",
  "correo",
  "telefono",
]);

/** Keys whose values identify or locate a person: masked in every example we show. */
export function isContactName(name: string): boolean {
  const w = words(name);
  if (w.some((x) => CONTACT_WORDS.has(x))) return true;
  for (let i = 0; i < w.length - 1; i++) {
    if (["first", "last", "full", "display", "middle", "given", "family", "real", "legal"].includes(w[i]!) && w[i + 1] === "name") return true;
    if (w[i] === "national" && ["id", "number", "no"].includes(w[i + 1]!)) return true;
  }
  return false;
}

const PERSONAL_WORDS = new Set([
  "name",
  "names",
  "username",
  "user",
  "login",
  "email",
  "mail",
  "phone",
  "mobile",
  "address",
  "street",
  "city",
  "zip",
  "postal",
  "postcode",
  "author",
  "owner",
  "first",
  "last",
  "display",
  "nick",
  "nickname",
  "handle",
  "ip",
  "birthday",
  "dob",
  "iban",
  "customer",
  "by",
  "assignee",
  "assignees",
  "reporter",
  "sender",
  "recipient",
  "member",
  "contact",
  "person",
  "patient",
  "employee",
  "birth",
  "location",
  "national",
  "passport",
  "isim",
  "ad",
  "soyad",
  "soyadi",
  "vorname",
  "nachname",
  "nombre",
  "apellido",
  "prenom",
  "nom",
  "hasta",
]);

/**
 * Keys that usually hold personal data. Their literal values are never
 * collected as enum candidates (so a list of orders by two customers doesn't
 * turn `customerName` into `"Ayse" | "Mehmet"`).
 */
export function isPersonalName(name: string): boolean {
  return words(name).some((w) => PERSONAL_WORDS.has(w));
}

/**
 * Mask personal data inside free text (CSV, HTML, plain text, messages):
 * emails, URL query strings (signed URLs carry credentials), IBANs, phone
 * numbers, long digit runs (national ids, card and account numbers) and
 * token-looking words.
 */
export function redactFreeText(text: string): string {
  return text
    .replace(/[^\s@"'<>,;]+@[^\s@"'<>,;]+\.[A-Za-z]{2,}/g, "user@example.com")
    .replace(/(https?:\/\/[^\s?#"'<>]+)[?#][^\s"'<>]*/gi, "$1")
    .replace(/\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){3,7}(?:[ ]?[A-Z0-9]{1,3})?\b/g, REDACTED)
    .replace(/\+?\d[\d ().-]{8,}\d/g, (m) => (m.replace(/\D/g, "").length >= 7 ? REDACTED : m))
    .replace(/\b\d{6,}\b/g, REDACTED)
    .replace(/[A-Za-z0-9_\-+/=.~]{20,}/g, (w) => (isSecretValue(w) || /AKIA[0-9A-Z]{12,}/.test(w) ? REDACTED : w));
}

// --- Data keys ------------------------------------------------------------------

/** "usr_8f3k2l9x", "cus_9s6XKzkN": prefixed ids with at least one digit. */
const PREFIXED_KEY = /^[A-Za-z]{1,6}_(?=[A-Za-z0-9]*\d)[A-Za-z0-9]{6,}$/;
const ID_KEY = /^(\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{24})$/i;

const PROPERTYISH = /^([a-z]+\d{0,3}([A-Z][a-z]+\d{0,3})*|([A-Z][a-z]+\d{0,3})+|[a-z]+\d{0,3}([_-][a-z]+\d{0,3})*|[A-Z]+\d{0,3}(_[A-Z]+\d{0,3})*)$/;

/** A key that is a datum (an email, a phone number, an id), not a property name. */
export function isDataKey(k: string): boolean {
  if (ID_KEY.test(k) || PREFIXED_KEY.test(k) || isEmail(k)) return true;
  if (/^\+?[\d\s().-]{7,}$/.test(k) && k.replace(/\D/g, "").length >= 7) return true;
  if (/\s/.test(k.trim())) return true;
  return k.length >= 5 && /\d/.test(k) && /[A-Za-z]/.test(k) && /^[A-Za-z0-9_.:@-]+$/.test(k) && !PROPERTYISH.test(k);
}

// --- Scrubbing: realistic but fake data for mocks and examples ----------------

const VOCAB = /^([a-z][a-z_.-]{0,31}|[A-Z][A-Z_.-]{0,31}|[a-z]{2}(-[A-Z]{2})?)$/;
const DATEISH = /^\d{4}-\d{2}-\d{2}([T ][\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/;
const IDISH = /^[A-Za-z0-9][A-Za-z0-9_.:~-]{0,63}$/;

/**
 * Turns recorded JSON into shape-preserving fake data. Vocabulary (enum-like
 * strings), dates, numbers and booleans are kept; identifiers are replaced
 * with consistent fakes of the same shape (`ord-77314` → `ord-40196`, the same
 * fake every time within one scrubber, so lists and details still line up);
 * everything else — names, free text, emails, URLs' query strings — is masked.
 */
export class Scrubber {
  private fakes = new Map<string, string>();
  private salt: Uint8Array<ArrayBuffer>;
  private recorded: ((s: string) => boolean) | undefined;
  private identity: ((s: string) => boolean) | undefined;
  private alias: ((s: string) => boolean) | undefined;
  private keptHost: ((host: string) => boolean) | undefined;
  private label: ((s: string) => boolean) | undefined;

  /**
   * @param opts.recorded tells whether a string was recorded as data anywhere
   *   in the capture (see leak.ts); such strings are never kept verbatim.
   * @param opts.identity tells whether a string names a user or tenant in the capture.
   * @param opts.alias tells whether a slug is the identifier form of a recorded value ("oguz-kilic" for "Oguz Kilic").
   * @param opts.keptHost tells whether a host is one the capture talked to (kept in URLs).
   * @param opts.label tells whether a string is recorded only as the name of a thing (not a dictionary key).
   */
  constructor(
    opts: { seed?: number; recorded?: (s: string) => boolean; identity?: (s: string) => boolean; alias?: (s: string) => boolean; keptHost?: (host: string) => boolean; label?: (s: string) => boolean } = {},
  ) {
    // A random salt per scrubber: fakes can't be reversed by hashing guesses.
    this.salt = new Uint8Array(new ArrayBuffer(16));
    if (opts.seed === undefined) globalThis.crypto.getRandomValues(this.salt);
    else for (let i = 0; i < 16; i++) this.salt[i] = (opts.seed * (i + 7) * 2654435761) >>> 24;
    this.recorded = opts.recorded;
    this.identity = opts.identity;
    this.alias = opts.alias;
    this.keptHost = opts.keptHost;
    this.label = opts.label;
  }

  /** Recorded as data, used as a user/tenant name, or the slug form of a recorded name. */
  private known(s: string): boolean {
    return !!(this.recorded?.(s) || this.identity?.(s) || this.alias?.(s));
  }

  /** @param inRecord the value is a field of a person's record (an object with contact fields). */
  json(value: unknown, key?: string, depth = 0, inPersonal = false, inRecord = false): unknown {
    if (depth > 64) return null;
    // A calendar date in a person's record (born, joined, visit day) is personal; timestamps stay.
    if (inRecord && typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) return "1970-01-01";
    const personal = inPersonal || (!!key && (isContactName(key) || isPersonalName(key)));
    if (key && isSensitiveName(key) && (value === null || typeof value !== "object")) return typeof value === "string" ? REDACTED : typeof value === "number" ? 0 : value;
    if (typeof value === "string") return idKeyName(key) && !DATEISH.test(value) && !isEmail(value) && value.length >= 3 ? this.fake(value) : this.string(value, personal, key);
    if (typeof value === "number") {
      if (personal) return 0;
      return Number.isInteger(value) && Math.abs(value) >= 100000 ? Number(this.fake(String(Math.abs(value)))) * Math.sign(value) : value;
    }
    if (value === null || typeof value !== "object") return value;
    if (Array.isArray(value)) return value.map((v) => this.json(v, key, depth + 1, personal, inRecord));
    const out: Record<string, unknown> = {};
    const entries = Object.entries(value);
    const record = entries.some(([k, v]) => (typeof v === "string" || typeof v === "number") && isContactName(k));
    // A dictionary keyed by data (any key an email, id or username, or every key of
    // same-shaped entries recorded as data): every key is data.
    const sig = (v: unknown) => (isObject(v) ? Object.keys(v as object).sort().join(",") : Array.isArray(v) ? "[]" : typeof v);
    const dict =
      entries.some(([k]) => isEmail(k) || isDataKey(k) || this.identity?.(k) || this.alias?.(k)) ||
      (entries.length >= 2 && entries.every(([k, v]) => this.recorded?.(k) && !this.label?.(k) && sig(v) === sig(entries[0]![1])));
    for (const [k, v] of entries) setOwn(out, dict ? (isEmail(k) ? this.fakeEmail(k) : this.fake(k)) : k, this.json(v, k, depth + 1, personal && isObject(v), record));
    return out;
  }

  /**
   * Property names are never changed — the mock must keep the JSON shape.
   * Only keys that are themselves data (an email, an id, a username used as
   * a dictionary key) are replaced.
   */
  key(k: string): string {
    if (isEmail(k)) return this.fakeEmail(k);
    if (isDataKey(k) || this.identity?.(k) || this.alias?.(k)) return this.fake(k);
    return k;
  }

  string(v: string, personal = false, key?: string): string {
    if (isSecretValue(v)) return REDACTED;
    if (DATEISH.test(v)) return personal ? v.replace(/^\d{4}-\d{2}-\d{2}/, "1970-01-01") : v;
    if (isEmail(v)) return this.fakeEmail(v);
    if (/^https?:\/\//i.test(v)) {
      if (personal) return REDACTED;
      try {
        const u = new URL(v);
        u.search = "";
        u.hash = "";
        u.username = "";
        u.password = "";
        // A host named after a user (mdemir.github.io, oguz-kilic.dev): fake that label.
        if (!this.keptHost?.(u.hostname.toLowerCase())) {
          const labels = u.hostname.split(".");
          u.hostname = labels.map((l, i) => (i < labels.length - 1 && l.length >= 3 && this.known(l) ? this.fake(l).toLowerCase() : l)).join(".");
        }
        u.pathname = this.path(u.pathname);
        return u.toString();
      } catch {
        return REDACTED;
      }
    }
    // The API's own relative links ("/v1/customers?page=2"): the same rules as a URL's path.
    if (/^\/[^\s]*$/.test(v) && !v.startsWith("//")) return personal ? REDACTED : this.path(v.replace(/[?#].*$/, ""));
    // IP addresses become documentation addresses (RFC 5737 / 3849).
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(v)) return `192.0.2.${(Number.parseInt(this.fake(v).replace(/\D/g, "").slice(0, 3) || "1", 10) % 254) + 1}`;
    if (/^[0-9a-f]{0,4}(:[0-9a-f]{0,4}){2,7}$/i.test(v) && v.includes("::") || /^[0-9a-f]{1,4}(:[0-9a-f]{1,4}){7}$/i.test(v)) return "2001:db8::" + (this.fakes.size + 1).toString(16);
    const idLike = IDISH.test(v) && /\d/.test(v);
    const identity = this.identity?.(v) ?? false;
    // A username is personal whatever it looks like ("chiara50" too); other recorded values unless they are ids.
    if (!personal && (identity || (!idLike && this.recorded?.(v)))) personal = true;
    if (personal) {
      if (isPhone(v) || /\d{4,}/.test(v)) return REDACTED;
      // One word (a username, a first name): a distinct fake, so list items stay distinct.
      return /\s/.test(v.trim()) ? lorem(v) : this.fake(v);
    }
    if (v === "") return v;
    // Vocabulary stays only under technical keys (status, type, currency, brand,
    // protocol…): a lone word under "category" or "tag" can be a diagnosis.
    const technical = key === undefined || TECHNICAL_KEY.test(words(key).pop() ?? "");
    if (VOCAB.test(v) || /^[a-z]{2,8}\d{1,3}$|^[A-Z]{2,6}\d{1,3}$/.test(v)) return technical ? v : this.fake(v);
    // Type names under a discriminator ("__typename": "Product", "type": "OrganizationMember").
    if (key !== undefined && DISCRIMINATOR_KEY.test(words(key).pop() ?? "") && /^[A-Z][a-z]+(?:[A-Z][a-z0-9]*)*$/.test(v)) return v;
    // Times, opening hours, decimal amounts sent as strings: "09:00-18:00", "19.99".
    if (/^\d{1,2}:\d{2}(:\d{2})?(\s*[-–]\s*\d{1,2}:\d{2}(:\d{2})?)?$/.test(v) || /^-?\d{1,6}\.\d{1,2}$/.test(v)) return v;
    if (isPhone(v)) return REDACTED;
    if (IDISH.test(v) && (/\d/.test(v) || /^[0-9a-f-]{8,}$/i.test(v))) return this.fake(v);
    if (/\d{6,}/.test(v) || /AKIA|[?&](sig|signature|token|key)=/i.test(v)) return REDACTED;
    return lorem(v);
  }

  /** URL path: ids and anything recorded as data (a username in /in/oguz-c) are faked; versions stay. */
  private path(pathname: string): string {
    return pathname
      .split("/")
      .map((s) => {
        let d = s;
        try {
          d = decodeURIComponent(s);
        } catch {
          /* keep */
        }
        if (/^v\d+(\.\d+)*$/i.test(d)) return s;
        // Keep the file extension: a fake avatar is still a .jpg.
        const ext = d.match(/\.[A-Za-z0-9]{1,5}$/)?.[0] ?? "";
        if ((/\d/.test(d) && IDISH.test(d)) || this.known(d) || /@|\s/.test(d)) return this.fake(d.slice(0, d.length - ext.length).replace(/[^A-Za-z0-9._-]/g, "")) + ext;
        // A recorded name inside a file name: avatars/mehmet.yilmaz.png, mehmet.yilmaz_avatar.jpg.
        const named = this.fileStem(d.slice(0, d.length - ext.length));
        return named === undefined ? s : named + ext;
      })
      .join("/");
  }

  /**
   * The file stem with the runs of pieces that spell a recorded value faked
   * ("mehmet.yilmaz_avatar" → "xkqrtb.pmnvcz_avatar"), or undefined if none does.
   */
  private fileStem(stem: string): string | undefined {
    if (stem.length >= 3 && this.known(stem)) return this.fake(stem);
    const parts = stem.split(/([._-]+)/);
    if (parts.length < 3) return undefined;
    let changed = false;
    const out: string[] = [];
    for (let i = 0; i < parts.length; i += 2) {
      // The longest run starting here that is a recorded value.
      let end = -1;
      for (let j = parts.length - 1; j >= i && end < 0; j -= 2) {
        const run = parts.slice(i, j + 1).join("");
        if (run.length >= 3 && this.known(run)) end = j;
      }
      if (end < 0) {
        out.push(parts[i]!, parts[i + 1] ?? "");
        continue;
      }
      out.push(this.fake(parts.slice(i, end + 1).join("")), parts[end + 1] ?? "");
      changed = true;
      i = end;
    }
    return changed ? out.join("") : undefined;
  }

  /** A path parameter's value is an identifier by definition: always a fake (small numbers and dates stay). */
  id(v: string): string {
    if (DATEISH.test(v) || /^\d{1,3}$/.test(v)) return v;
    if (isEmail(v) || /\s/.test(v)) return this.string(v);
    return this.fake(v);
  }

  /** Same-shape fake: letters stay letters, digits stay digits, separators and a short alphabetic prefix stay. */
  fake(v: string): string {
    let f = this.fakes.get(v);
    if (f !== undefined) return f;
    // Keep a short type prefix ("usr_", "ord-") only when an id follows it, never a name ("ingrid_…").
    // Stripe-style base62 ids (cus_NffrFeUfNV2Hib) may have a single digit or none: mixed case says "id".
    let prefix = v.match(/^[a-z]{1,4}[_-](?=(?:[A-Za-z]*\d){2}|(?=[A-Za-z0-9]*[A-Z])(?=[A-Za-z0-9]*[a-z])[A-Za-z0-9]{10,}$)|^[A-Za-z]{1,4}[_-](?=(?:[A-Za-z]*\d){2})/)?.[0] ?? "";
    // ...unless the prefix is itself recorded (a Jira project key: PROJ-12 for project PROJ).
    if (prefix && this.known(prefix.slice(0, -1))) prefix = "";
    let h = 2166136261;
    for (const b of this.salt) h = Math.imul(h ^ b, 16777619);
    for (let i = 0; i < v.length; i++) h = Math.imul(h ^ v.charCodeAt(i), 16777619);
    const next = () => {
      h ^= h << 13;
      h ^= h >>> 17;
      h ^= h << 5;
      return h >>> 0;
    };
    const body = [...v.slice(prefix.length)].map((ch, i) => {
      if (/[0-9]/.test(ch)) return String((next() % 9) + (i === 0 ? 1 : 0));
      if (/[a-f]/.test(ch) && /^[0-9a-f-]+$/i.test(v)) return "abcdef"[next() % 6]!;
      if (/[a-z]/.test(ch)) return String.fromCharCode(97 + (next() % 26));
      if (/[A-Z]/.test(ch)) return String.fromCharCode(65 + (next() % 26));
      return ch;
    });
    f = prefix + body.join("");
    if (f === v) f = prefix + body.reverse().join("");
    // Still the recorded value (a palindrome like "66"): bump the first digit or letter.
    if (f === v) f = prefix + body.join("").replace(/[0-9a-zA-Z]/, (c) => (/\d/.test(c) ? String((Number(c) + 1) % 10) : c === "z" ? "a" : c === "Z" ? "A" : String.fromCharCode(c.charCodeAt(0) + 1)));
    this.fakes.set(v, f);
    return f;
  }

  private fakeEmail(v: string): string {
    return `user.${this.fake(v.toLowerCase()).replace(/[^a-z0-9]/gi, "").slice(0, 6).toLowerCase()}@example.com`;
  }
}

/** Keys whose value names a type: "__typename": "Product", "kind": "OrganizationMember". */
const DISCRIMINATOR_KEY = /^(type|typename|kind|object|class|entity|resource|model)$/;

const TECHNICAL_KEY =
  /^(status|state|type|kind|role|level|tier|mode|stage|phase|priority|severity|method|currency|unit|format|variant|plan|visibility|sort|order|direction|channel|platform|action|locale|lang|language|country|size|interval|period|frequency|permission|access|strategy|availability|environment|env|brand|network|scheme|protocol|proto|mime|encoding|algorithm|algo|codec|version|source|provider|color|colour|theme|icon|align|position|layout|style|target|rel|lifecycle|outcome|result|code|error|err|errcode|event|op|operation|object|typename)$/;

function idKeyName(key: string | undefined): boolean {
  if (!key) return false;
  const w = words(key);
  return ["id", "ids", "uuid", "guid", "number", "no", "nr", "num", "ref", "reference", "sku", "serial"].includes(w[w.length - 1] ?? "");
}

const LOREM = "lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua".split(" ");

/** Placeholder text with the same number of words and the same capitalisation: "Trail Pro" → "Lorem Ipsum". */
export function lorem(v: string): string {
  const parts = v.trim().split(/\s+/).slice(0, 40);
  const out = parts.map((w, i) => {
    const word = LOREM[i % LOREM.length]!;
    const tail = w.match(/[.,;:!?)]+$/)?.[0] ?? "";
    const letters = w.replace(/[^A-Za-z]/g, "");
    if (letters.length > 1 && letters === letters.toUpperCase()) return word.toUpperCase() + tail;
    return (/^[A-ZÀ-Þ]/.test(w) ? word[0]!.toUpperCase() + word.slice(1) : word) + tail;
  });
  return out.join(" ") + (v.trim().split(/\s+/).length > 40 ? " …" : "");
}

function isObject(v: unknown): boolean {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Header names that are always stripped from anything we output. */
export function isSensitiveHeader(name: string): boolean {
  const n = name.toLowerCase();
  return n === "cookie" || n === "set-cookie" || n === "authorization" || n === "proxy-authorization" || isSensitiveName(n);
}
