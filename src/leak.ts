/**
 * Leak guard.
 *
 * Before anything is generated, every value the capture recorded (bodies,
 * query strings, header values, cookies, path parameters) is collected into a
 * {@link Taint} set. The pipeline consults it while deciding what may become
 * code (a path literal, an enum, a property name, a default header…), and
 * after generation every output — client.ts, openapi.json, the chat prompt,
 * MCP responses, `inspect --json` — is scanned against it.
 *
 * Only values that look like *data* are collected: identifiers with digits,
 * emails, phone numbers, long numbers, free text, URLs with query strings,
 * and anything stored under a personal or secret-sounding key. Plain
 * vocabulary ("shipped", "price_asc", "USD") and version strings are not data:
 * they are what enums and headers are made of.
 */
import type { Exchange } from "./har.js";
import { isObject } from "./har.js";
import { graphqlLiteralMatches, quotedStrings, replacePercentRuns, trimDotsDashesTildes } from "./linear.js";
import { isContactName, isDataKey, isEmail, isPersonalName, isPersonalNameWord, isSecretValue, isSensitiveName, Scrubber } from "./redact.js";
import { singular, words } from "./words.js";

export interface Taint {
  /** Lower-cased recorded values that look like data. */
  values: Set<string>;
  /** Identifier forms ("oguz@kilic.dev" → "oguzkilicdev") of id-like or personal values. */
  aliases: Set<string>;
  /** Hosts and origins the capture talked to: they are meant to appear in the output. */
  allowed: Set<string>;
  /**
   * Values the capture uses to name a person or a tenant — under `login`,
   * `username`, `owner`, `author`, `from`, … or in `x-user` / `x-tenant`
   * headers — whatever they look like ("okilic", "oguzs-clinic").
   */
  identities: Set<string>;
  /** Identifier forms of the identities ("ecekaya" for "ece_kaya"): the same name with other separators. */
  identityForms: Set<string>;
  /**
   * One-word names of things — a category, a plan, a repository — recorded
   * only under a `name`-like key of an object that doesn't describe a person.
   * The generator treats them as data (no enum member, no dictionary key, no
   * path literal where a member id belongs), but finding one in the output is
   * not a leak: "Books" the category and `/api/books` the endpoint are both vocabulary.
   */
  labels: Set<string>;
  /**
   * The words of recorded personal names ("zeynep" and "ak" of "Zeynep Ak" under
   * `fullName`), lower-cased, also without diacritics. Never vocabulary: a word
   * of a person's name is not an enum member and the mock fakes it.
   */
  nameParts: Set<string>;
}

export function emptyTaint(): Taint {
  return { values: new Set(), aliases: new Set(), allowed: new Set(), identities: new Set(), identityForms: new Set(), labels: new Set(), nameParts: new Set() };
}

const IDENTITY_WORDS = new Set(
  (
    "login username user handle nickname nick owner author by sender from recipient to assignee assignees member members uid screenname account tenant org organization workspace team customer creator reporter " +
    // People in a role: they hold a username as often as an object.
    "reviewer reviewers approver approvers requester submitter editor organizer organiser invitee inviter participant participants attendee attendees follower followers friend friends actor maintainer contributor collaborator commenter uploader buyer seller mention mentions"
  ).split(" "),
);

/** Placeholder and role words ("owner", "member", "reviewer"): never a person's name on their own. */
const COMMON = new Set([
  ..."admin root system guest anonymous unknown none null true false default user users public private test demo example".split(" "),
  ...IDENTITY_WORDS,
]);

/** Does this key (or header name) hold an identity: a user, an author, a tenant? */
const IDENTITY_KEY_CACHE = new Map<string, boolean>();

export function isIdentityKey(key: string | undefined): boolean {
  if (!key) return false;
  let r = IDENTITY_KEY_CACHE.get(key);
  if (r === undefined) {
    r = identityKey(key);
    if (IDENTITY_KEY_CACHE.size > 5000) IDENTITY_KEY_CACHE.clear();
    IDENTITY_KEY_CACHE.set(key, r);
  }
  return r;
}

function identityKey(key: string): boolean {
  const w = words(key.replace(/^x-/, ""));
  const last = w[w.length - 1] ?? "";
  if (IDENTITY_WORDS.has(last)) return true;
  // userName, ownerLogin, tenantSlug, authorHandle, teamSlug
  return w.length >= 2 && IDENTITY_WORDS.has(w[w.length - 2]!) && ["name", "login", "slug", "handle", "key"].includes(last);
}

/**
 * Shaped like an identifier rather than a word: three or more digits,
 * a prefixed id, an UPPERCASE code with digits, an email or a phone number.
 * "ord-77314", "C07QW9XHK", "usr_8f3k2l9x" yes; "oauth2", "ipv4", "covid19", "v2" no.
 */
export function isIdShaped(value: string): boolean {
  const v = value.trim();
  if (v.length < 4 || VERSIONISH.test(v) || /^v\d+$/i.test(v)) return false;
  if (isEmail(v) || (PHONE.test(v) && digitCount(v) >= 7)) return true;
  // Issue keys: an upper-case project key and a number (PROJ-7, AB-12).
  if (/^[A-Z][A-Z0-9]{1,9}-\d+$/.test(v)) return true;
  if (/^[a-z]+\d{1,2}[a-z]*$/i.test(v) && !/^[A-Z0-9]+$/.test(v)) return false;
  // Digits of any script: "٠٥٣٢١٢٣٤٥٦٧" and "１２３４" are numbers too.
  if (digitCount(v) >= 3) return true;
  if (/^[A-Za-z]{1,6}[_-](?=[A-Za-z0-9]*\d)[A-Za-z0-9]{5,}$/.test(v)) return true;
  if (looksRandom(v)) return true;
  return /^[A-Z0-9]{6,}$/.test(v) && /\d/.test(v) && /[A-Z]/.test(v);
}

/**
 * Letter pairs that are rare inside words: under 1 in 20,000 of the pairs in the
 * identifiers and English of TypeScript's own declaration files (lib.*.d.ts,
 * @types/node), minus pairs common in Turkish, German, Spanish and French
 * words ("ji", "ko", "uk"…). Random letters land on one of them almost half the time.
 */
const RARE_BIGRAMS = new Set(
  (
    "aj aq az bb bd bf bg bh bk bm bn bq bv bw bx bz cf cg cj cn cq cv cw cx cz dc dj dk dm dq dt dv dw dx dz ek " +
    "ez fb fg fh fj fk fm fp fq fv fw fx fz gb gd gf gj gk gp gq gw gx gy gz hb hc hd hf hg hh hj hk hl hn hp hq " +
    "hv hw hx hz iu iw jb jc jd jf jg jh jj jk jl jm jn jo jp jq jr jt ju jv jw jx jy jz kb kc kf kg kh kj kl km " +
    "kq kr kt kv kw kx ky kz lc lh lj lk ln lq lx lz mc md mf mg mh mj mq mr mv mw mx mz nb nj nq nw nx nz oq pb " +
    "pc pf pg pj pm pn pq pw px pz qa qb qc qd qe qf qg qh qi qj qk qm qn qo qp qq qr qs qt qv qw qx qy qz rh rj " +
    "rq rx rz sb sd sg sj sx sz tb tj tk tq tv tz uh uj uo uq uu uv uw vb vc vd vf vg vh vj vk vl vn vp vq vr vs " +
    "vt vu vv vw vx vy vz wb wc wd wf wg wj wk wl wm wp wq wt wu wv wx wy wz xb xd xf xg xh xj xk xl xm xn xo xq " +
    "xr xs xu xv xw xx xz yb yd yf yg yh yj yk yq yr yv yw yx yy yz zb zc zd zf zg zh zj zk zm zn zp zq zr zt zv " +
    "zw zx zy zz"
  ).split(" "),
);

/**
 * Letters only, but random rather than words: a token that happens to have no
 * digit ("KfTqLmZxRwPbNvYc", "dQwUvXyZaBc"), or a code without vowels
 * ("qzxkvbtrplmw", "xkq-bvzt-rmn"). Judged by rare letter pairs and, for mixed
 * case, by how often the case flips. Words, acronyms and camel-case names
 * ("strengths", "XMLHttpRequest", "iOSAppID", "siparisler") are not.
 */
export function looksRandom(value: string): boolean {
  const v = value.trim();
  if (!/^[A-Za-z]+(?:[-_][A-Za-z]+)*$/.test(v)) return false;
  const letters = v.replace(/[-_]/g, "");
  if (letters.length < 8) return false;
  const lower = letters.toLowerCase();
  if (!/[aeiouy]/.test(lower)) return true;
  let pairs = 0;
  let rare = 0;
  for (const part of v.toLowerCase().split(/[-_]/)) {
    for (let i = 1; i < part.length; i++) {
      pairs++;
      if (RARE_BIGRAMS.has(part[i - 1]! + part[i]!)) rare++;
    }
  }
  const share = rare / pairs;
  if (letters === lower || letters === letters.toUpperCase()) return pairs >= 7 && share >= 0.4;
  let flips = 0;
  for (let i = 1; i < letters.length; i++) if (/[A-Z]/.test(letters[i]!) !== /[A-Z]/.test(letters[i - 1]!)) flips++;
  const flipRate = flips / (letters.length - 1);
  const upper = (letters.match(/[A-Z]/g) ?? []).length / letters.length;
  return (
    share >= (letters.length >= 16 ? 0.2 : 0.3) ||
    (flipRate >= 0.4 && share >= 0.15) ||
    // Long, about half upper case, flipping all the time: no camel-case name does that.
    (letters.length >= 20 && flipRate >= 0.3 && upper >= 0.3 && upper <= 0.7)
  );
}

const VERSIONISH = /^v?\d+(\.\d+){1,3}([-+][0-9A-Za-z.-]+)?$/i;
/** Decimal digits of any script (\p{Nd}): Arabic-Indic, Devanagari, full-width… as well as 0-9. */
const PHONE = /^\+?[\p{Nd}\s().-]{7,20}$/u;

/** How many decimal digits, of any script, the value has. */
export function digitCount(v: string): number {
  return (v.match(/\p{Nd}/gu) ?? []).length;
}


const UNCASED_LETTER = /^\p{Lo}$/u;

/**
 * Length for the "long enough to be data" thresholds. A letter without case
 * (\p{Lo}: a logogram, a syllable, a consonant of an abjad) counts twice: in
 * those scripts two or three letters are a whole name ("李娜", "김민준", "علي"),
 * where two or three letters of a cased alphabet are not ("Li", "Ali", "Лев").
 * Judged by Unicode category, so no script is listed; ASCII counts as before.
 */
export function dataLength(v: string): number {
  if (/^[\x00-\x7f]*$/.test(v)) return v.length;
  let n = 0;
  for (const ch of v) n += UNCASED_LETTER.test(ch) ? 2 : 1;
  return n;
}

/** Does this string look like a recorded datum rather than vocabulary? */
export function isDataLike(value: string): boolean {
  const v = value.trim();
  if (dataLength(v) < 4 || v.length > 4000) return false;
  if (VERSIONISH.test(v)) return false;
  if (isEmail(v)) return true;
  if (PHONE.test(v) && digitCount(v) >= 7) return true;
  if (/^https?:\/\//i.test(v)) return /[?#]/.test(v) || /\d{4,}|@/.test(v);
  // A relative path ("/v1/customers") is the API's own structure, unless it carries an id or a query.
  if (/^\/[^\s]*$/.test(v)) return /[?#@]/.test(v) || v.split("/").some((s) => isIdShaped(s) || /\d{4,}/.test(s) || (s.length >= 16 && /\d/.test(s)));
  if (/\s/.test(v)) return v.split(/\s+/).filter(Boolean).length >= 2 && /[\p{L}\p{N}]/u.test(v);
  if (/^-?\p{Nd}{6,}$/u.test(v) || /^-?\p{Nd}+\.\p{Nd}{4,}$/u.test(v)) return true;
  if (dataLength(v) >= 5 && /\p{Nd}/u.test(v) && /\p{L}/u.test(v)) return true;
  if (looksRandom(v)) return true;
  if (isSecretValue(v)) return true;
  return false;
}

/** "oguz@kilic.dev" → "oguzkilicdev", "ord-77314" → "ord77314". */
export function aliasOf(value: string): string {
  return words(value).join("");
}

/** Keys whose values are identifiers: `id`, `orderNumber`, `channelId`, `sourceRef`. */
const KEY_CACHE = new Map<string, number>();

/** 1 = personal key, 2 = id key, 0 = neither (memoised: keys repeat a lot). */
function keyKind(key: string | undefined): number {
  if (!key) return 0;
  let k = KEY_CACHE.get(key);
  if (k === undefined) {
    k = personalKey(key) ? 1 : isIdKey(key) ? 2 : 0;
    if (KEY_CACHE.size > 5000) KEY_CACHE.clear();
    KEY_CACHE.set(key, k);
  }
  return k;
}

export function isIdKey(key: string | undefined): boolean {
  if (!key) return false;
  const w = words(key);
  return ["id", "ids", "uuid", "guid", "number", "no", "nr", "num", "ref", "reference", "sku", "serial"].includes(w[w.length - 1] ?? "");
}

/** Keys whose values are personal no matter what they look like. */
function personalKey(key: string | undefined): boolean {
  return !!key && (isContactName(key) || isPersonalName(key) || isSensitiveName(key) || /birth|national|passport|patient|diagnos/i.test(key));
}

/** `name`, `productName`, `repo_name`: personal only because of the word "name". */
function nameOnlyKey(key: string | undefined): boolean {
  if (!key) return false;
  const w = words(key);
  if (!["name", "names", "title"].includes(w[w.length - 1] ?? "")) return false;
  const rest = w.slice(0, -1).join(" ");
  return !rest || !(isContactName(key) || isPersonalName(rest) || isIdentityKey(key) || isSensitiveName(key) || /birth|national|passport|patient|diagnos/i.test(key));
}

/** A key that holds (part of) a person's name, not their email, phone or address: `firstName`, `familyName`, `nachname`. */
function nameFieldKey(k: string): boolean {
  return (isContactName(k) || isPersonalName(k)) && !nameOnlyKey(k) && !isIdentityKey(k) && !isEmail(k) && isPersonalNameWord(k);
}

/** Keys and collections that hold people: an object under them describes a person. */
export function personWord(word: string | undefined): boolean {
  if (!word) return false;
  const w = singular(word.toLowerCase());
  return isIdentityKey(w) || isPersonalName(w) || /^(people|person|users?|me|self|whoami|viewer|current|profile|account|session|contact|patient|employee|staff|student|friend|follower|participant|attendee|guest)$/.test(w);
}

const PERSON_FIELD = new Map<string, boolean>();

/** A field that says its object is a person: an email, a phone, a login, a birth date (memoised: keys repeat). */
function personField(k: string): boolean {
  let r = PERSON_FIELD.get(k);
  if (r === undefined) {
    r = !nameOnlyKey(k) && (isContactName(k) || isIdentityKey(k) || /birth|national|passport|patient/i.test(k));
    if (PERSON_FIELD.size > 5000) PERSON_FIELD.clear();
    PERSON_FIELD.set(k, r);
  }
  return r;
}

/** Does this object describe a person? A scalar field says so. */
function personObject(obj: Record<string, unknown>): boolean {
  for (const k in obj) {
    const v = obj[k];
    if ((typeof v === "string" || typeof v === "number") && personField(k)) return true;
  }
  return false;
}

export class TaintCollector {
  readonly taint: Taint = emptyTaint();

  /** @param person false when the value sits in an object known not to describe a person. */
  add(value: string, key?: string, person = true): void {
    const v = value.trim();
    if (!v || v.length > 4000) return;
    const lower = v.toLowerCase();
    const len = dataLength(v);
    const usable = len >= 3 && !COMMON.has(lower) && !VERSIONISH.test(v);
    // Identities: user/tenant names, and string ids ("ACPVVW" under `id`) — whatever they look like, in any script.
    if (usable && (isIdentityKey(key) || keyKind(key) === 2) && !/\s/.test(v) && /\p{L}/u.test(v) && !/^\d{4}-\d{2}/.test(v) && !(!isIdentityKey(key) && /^[A-Z]{2,4}$/.test(v))) this.identity(lower);
    const personal = len >= 4 && usable && keyKind(key) !== 0;
    // A thing's one-word name (a category "Books", a repository "dotfiles"): a label, not personal data.
    if (personal && !person && nameOnlyKey(key) && !/\s/.test(v) && !isDataLike(v)) {
      this.taint.labels.add(lower);
      return;
    }
    if (!personal && !isDataLike(v)) return;
    this.taint.values.add(lower);
    if (personal && (person || !nameOnlyKey(key)) && (isPersonalName(key!) || isContactName(key!))) this.nameParts_(v);
    // Identifier forms catch a value that became a type or method name.
    // Only distinctive values: emails, ids with 3+ digits, personal multi-word names.
    // (Recorded before under a neutral key, ?q=Kerem Okafor, doesn't make it less personal now.)
    if (this.aliased.has(lower)) return;
    const distinctive = isEmail(v) || digitCount(v) >= 3 || (personal && (/\s/.test(v) || isIdentityKey(key)));
    if (!distinctive) return;
    this.aliased.add(lower);
    const a = aliasOf(v);
    if (a.length >= 8) this.taint.aliases.add(a);
  }

  /**
   * A name recorded in parts: sibling fields under personal-name keys
   * (`firstName` + `lastName`, `vorname` + `nachname`…), each one word. An app
   * builds slugs from the parts ("zeynep-kaya", "zeynep_kaya", "zeynepkaya"),
   * so their joins are identities, as the words of a multi-word name are.
   */
  private joinedNames(obj: Record<string, unknown>): void {
    const parts: string[] = [];
    for (const k in obj) {
      const v = obj[k];
      if (typeof v !== "string" || !nameFieldKey(k)) continue;
      const w = v.trim().toLowerCase();
      if (/^\p{L}[\p{L}\p{M}'’]*$/u.test(w) && dataLength(w) >= 2 && !COMMON.has(w)) parts.push(w);
      if (parts.length > 4) return;
    }
    for (let i = 0; i < parts.length; i++)
      for (let j = 0; j < parts.length; j++) {
        if (i === j || parts[i] === parts[j]) continue;
        for (const sep of ["-", "_", ""]) this.identity(parts[i] + sep + parts[j]);
        const a = aliasOf(parts[i]! + " " + parts[j]!);
        if (a.length >= 8) this.taint.aliases.add(a);
      }
  }

  /** Values whose identifier form was already decided. */
  private aliased = new Set<string>();

  /** The words of a personal name of two to four words ("Zeynep Ak", "Gülşen Öztürk"). */
  private nameParts_(v: string): void {
    const parts = v.split(/\s+/).filter(Boolean);
    if (parts.length < 2 || parts.length > 4 || !parts.every((p) => /^\p{L}[\p{L}'’.-]*$/u.test(p))) return;
    for (const p of parts) {
      const w = p.toLowerCase().replace(/[.'’]+$/, "");
      if (dataLength(w) < 3 || COMMON.has(w)) continue;
      this.taint.nameParts.add(w);
      this.taint.nameParts.add(w.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/ı/g, "i"));
    }
  }

  private identity(lower: string): void {
    if (this.taint.identities.has(lower)) return;
    this.taint.identities.add(lower);
    const form = aliasOf(lower);
    if (form.length >= 5 && /[._\-]/.test(lower)) this.taint.identityForms.add(form);
  }

  /** Always data, whatever it looks like (inline GraphQL values, identity headers). */
  addAlways(value: string, identity = false): void {
    const v = value.trim();
    const lower = v.toLowerCase();
    if (dataLength(v) < 3 || COMMON.has(lower) || VERSIONISH.test(v)) return;
    if (identity) this.identity(lower);
    if (dataLength(v) >= 4) this.taint.values.add(lower);
  }

  addNumber(n: number, key?: string): void {
    if (Number.isInteger(n) && Math.abs(n) < 1000 && !key) return;
    const s = String(n);
    if (s.replace(/[-.]/g, "").length >= 6 || (s.length >= 4 && keyKind(key) === 1)) this.taint.values.add(s);
  }

  /**
   * Walk a JSON value: leaves are values, and keys that look like data (emails, ids) are values too.
   * @param person whether this value describes a person (from its container or the request path).
   */
  json(value: unknown, key?: string, depth = 0, skip?: (key: string, depth: number) => boolean, person = false): void {
    if (depth > 64) return;
    if (typeof value === "string") this.add(value, key, person);
    else if (typeof value === "number") this.addNumber(value, key);
    else if (Array.isArray(value)) for (const item of value.slice(0, 2000)) this.json(item, key, depth + 1, skip, person);
    else if (isObject(value)) {
      const here = person || personObject(value);
      this.joinedNames(value);
      for (const [k, v] of Object.entries(value)) {
        if (skip?.(k, depth)) continue;
        if (isDataKey(k)) this.add(k, "key");
        this.json(v, k, depth + 1, skip, here || (typeof v === "object" && v !== null && personWord(k)));
      }
    }
  }
}

/** Headers whose values are about the browser, not the user or the app. */
const BROWSER_VALUE_HEADERS = /^(accept|accept-encoding|accept-language|cache-control|connection|content-type|content-length|pragma|priority|te|upgrade-insecure-requests|user-agent|sec-.*|:.*|host|origin|referer|dnt)$/;

/** GraphQL documents, persisted-query hashes and RPC method names are code, not data. */
function skipProtocolKeys(k: string, depth: number): boolean {
  return depth === 0 && /^(query|operationName|extensions|jsonrpc|method)$/.test(k);
}

export function collectTaint(exchanges: Exchange[]): Taint {
  const c = new TaintCollector();
  for (const ex of exchanges) {
    c.taint.allowed.add(ex.origin.toLowerCase());
    c.taint.allowed.add(ex.url.hostname.toLowerCase());
    for (const [k, v] of ex.query) {
      // GraphQL over GET: the document is code, its inline literals are data.
      if (k === "query") graphqlLiterals(v, c);
      if (/^(query|operationName|extensions)$/.test(k)) continue;
      // Names can carry data too: ?role[oguz@kilic.dev]=admin
      for (const part of k.split(/[[\]]+/)) if (part && (isDataKey(part) || isDataLike(part))) c.add(part, "key");
      c.add(v, k);
      if (/^[[{]/.test(v)) {
        try {
          c.json(JSON.parse(v), k, 0, skipProtocolKeys, true);
        } catch {
          /* not JSON */
        }
      }
    }
    for (const [name, value] of ex.requestHeaders) {
      if (BROWSER_VALUE_HEADERS.test(name)) continue;
      if (name === "cookie") {
        for (const part of value.split(";")) {
          const i = part.indexOf("=");
          if (i > 0) c.add(part.slice(i + 1), "cookie");
        }
        continue;
      }
      c.add(value, name);
      if (isIdentityKey(name)) c.addAlways(value, true);
      const token = value.match(/^\S+\s+(\S{8,})$/)?.[1];
      if (token) c.add(token, name);
    }
    for (const body of [ex.requestBody, ex.responseBody]) {
      if (!body) continue;
      if (body.kind === "json") {
        const v = body.value;
        // A batch (GraphQL, JSON-RPC) is a list of requests: each has its own protocol keys.
        // Responses of a people collection (/api/users, /api/me) describe people.
        const person = personPath(ex.pathname);
        if (Array.isArray(v)) for (const item of v.slice(0, 2000)) c.json(item, undefined, 0, skipProtocolKeys, person);
        else c.json(v, undefined, 0, skipProtocolKeys, person);
        // Inline literals in GraphQL documents are data too.
        for (const doc of graphqlDocs(v)) graphqlLiterals(doc, c);
      } else if (body.kind === "form") {
        for (const [k, v] of body.fields) {
          for (const part of k.split(/[[\]]+/)) if (part && (isDataKey(part) || isDataLike(part))) c.add(part, "key");
          c.add(v, k);
        }
      } else if ((body.kind === "text" || body.kind === "unparsed") && csvRows(body.raw)) {
        // CSV: cells under personal columns are data whatever they look like.
        const rows = csvRows(body.raw)!;
        const head = rows[0]!;
        for (const row of rows.slice(1, 5000)) row.forEach((cell, i) => c.add(cell, head[i]));
      } else if (body.kind === "text" || body.kind === "unparsed") {
        // XML / HTML / truncated JSON: values under their element, attribute or key name.
        mapTextFields(body.raw.slice(0, 200_000), (v, k) => {
          if (typeof v === "string") c.add(v, k);
          else if (typeof v === "number") c.addNumber(v, k);
          return v;
        });
        for (const w of body.raw.slice(0, 200_000).match(/[^\s"'<>,;()[\]{}]{5,}/g) ?? []) if (isDataLike(w)) c.add(w);
      }
    }
    for (const [name, value] of ex.responseHeaders) {
      if (name === "set-cookie") {
        const i = value.indexOf("=");
        if (i > 0) c.add(value.slice(i + 1).split(";")[0] ?? "", "cookie");
      }
    }
  }
  return c.taint;
}

/** Parse simple CSV (header row + rows, no quoted newlines); undefined if it isn't CSV. */
export function csvRows(text: string): string[][] | undefined {
  const lines = text.split(/\r?\n/).filter((l) => l.length);
  if (lines.length < 2) return undefined;
  const sep = [",", ";", "\t"].find((d) => lines[0]!.split(d).length >= 2 && lines[0]!.split(d).every((h) => /^[\w .-]{1,40}$/.test(h.trim().replace(/^"|"$/g, ""))));
  if (!sep) return undefined;
  return lines.map((l) => l.split(sep).map((c) => c.trim().replace(/^"|"$/g, "")));
}

/**
 * Rewrite the values of a structured text body — XML / HTML (element text and
 * attribute values, keyed by their tag or attribute name) or JSON that didn't
 * parse (string and number literals, keyed by the nearest preceding key) —
 * and keep everything else: tags, attribute names, keys, punctuation.
 * Returns undefined for text that is neither (plain text).
 */
export function mapTextFields(text: string, fn: (value: string | number, key: string | undefined) => unknown): string | undefined {
  const t = text.trimStart();
  if (t.startsWith("<") && t.includes(">")) return mapMarkup(text, fn);
  if (t.startsWith("{") || t.startsWith("[")) return mapJsonish(text, fn);
  return undefined;
}

const MARKUP_TOKEN = /<!\[CDATA\[[\s\S]*?(?:\]\]>|$)|<!--[\s\S]*?(?:-->|$)|<[!?][^>]*>?|<\/?[A-Za-z][^>]*>?|[^<]+|</g;

function mapMarkup(text: string, fn: (value: string | number, key: string | undefined) => unknown): string {
  const stack: string[] = [];
  const str = (v: unknown) => (typeof v === "string" ? v : String(v));
  return text.replace(MARKUP_TOKEN, (tok) => {
    if (tok.startsWith("<![CDATA[")) {
      const inner = tok.slice(9).replace(/\]\]>$/, "");
      return `<![CDATA[${inner.trim() ? str(fn(inner, stack[stack.length - 1])) : inner}]]>`;
    }
    if (tok.startsWith("<!--")) return "<!-- -->";
    if (tok.startsWith("<!") || tok.startsWith("<?")) return tok;
    const tag = tok.match(/^<(\/?)([A-Za-z][\w:.-]*)/);
    if (tag) {
      const name = tag[2]!.replace(/^.*:/, "");
      if (tag[1]) {
        const at = stack.lastIndexOf(name);
        if (at >= 0) stack.length = at;
        return tok;
      }
      if (!/\/>$/.test(tok) && !/^(br|hr|img|input|meta|link|area|base|col|embed|source|track|wbr)$/i.test(name)) stack.push(name);
      // Attribute values; namespace declarations are structure.
      // An attribute starts after white space: anchoring there keeps this linear on a
      // tag with a huge run of name characters (no backtracking from every position).
      return tok.replace(/(\s)([\w:.-]+)(\s*=\s*)(?:"([^"]*)"|'([^']*)')/g, (m, lead: string, attr: string, eq: string, dq?: string, sq?: string) => {
        if (/^xmlns(:|$)/.test(attr)) return m;
        const out = str(fn(decodeEntities(dq ?? sq ?? ""), attr.replace(/^.*:/, ""))).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
        return `${lead}${attr}${eq}"${out}"`;
      });
    }
    if (tok === "<" || !tok.trim()) return tok;
    // Text between tags: keep the surrounding whitespace.
    const lead = tok.match(/^\s*/)![0];
    const trail = tok.match(/\s*$/)![0];
    const out = str(fn(decodeEntities(tok.trim()), stack[stack.length - 1]));
    return lead + out.replace(/&/g, "&amp;").replace(/</g, "&lt;") + trail;
  });
}

function decodeEntities(s: string): string {
  return s.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);/gi, (m, e: string) => {
    const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
    if (named[e.toLowerCase()]) return named[e.toLowerCase()]!;
    const code = e[1] === "x" || e[1] === "X" ? Number.parseInt(e.slice(2), 16) : Number.parseInt(e.slice(1), 10);
    return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
  });
}

function mapJsonish(text: string, fn: (value: string | number, key: string | undefined) => unknown): string {
  let key: string | undefined;
  return text.replace(/"((?:[^"\\]|\\.)*)("?)(\s*:)?|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g, (m, inner?: string, close?: string, colon?: string) => {
    if (inner === undefined) {
      const n = Number(m);
      const out = fn(Number.isFinite(n) ? n : m, key);
      return typeof out === "number" ? String(out) : JSON.stringify(out);
    }
    let value: string;
    try {
      value = JSON.parse(`"${inner}"`);
    } catch {
      value = inner;
    }
    if (colon) {
      key = value;
      return m;
    }
    const v = fn(value, key);
    const out = JSON.stringify(typeof v === "string" ? v : String(v));
    // A truncated body ends inside a string: leave it unterminated.
    return close ? out : out.slice(0, -1);
  });
}

/** String literals (block strings too) and long numbers inside a GraphQL document. */
function graphqlLiterals(doc: string, c: TaintCollector): void {
  for (const m of graphqlLiteralMatches(doc)) {
    // `login: "mdemir"`: the argument name says what the value is.
    const identity = !!m[1] && (isIdentityKey(m[1]) || isIdKey(m[1]));
    if (m[0].startsWith("#")) {
      // Comments stay in the document: anything data-like in them is data.
      for (const [start, end] of quotedStrings(m[0])) c.addAlways(m[0].slice(start + 1, end - 1));
      for (const w of m[0].match(/[^\s"'<>,;()[\]{}]{4,}/g) ?? []) if (isDataLike(w)) c.add(w);
    } else if (m[2] !== undefined) c.addAlways(m[2].trim(), identity);
    else if (m[3] !== undefined) c.addAlways(m[3], identity);
    else if (m[4] !== undefined && isGraphqlDataNumber(m[1], Number(m[4])) && digitCount(m[4]) >= 4) c.taint.values.add(m[4].toLowerCase());
  }
}

/** A GraphQL argument that names a thing by id (`id`, `userId`, `orderNumber`). */
export function isGraphqlIdArg(arg: string): boolean {
  return /^(id|ids)$|(Id|_id|Ids|_ids)$/.test(arg) || isIdKey(arg);
}

/**
 * Is this inline number in a GraphQL document data (lifted into a variable,
 * and recorded by the leak guard) rather than query logic (`first: 20`)?
 * Under an id argument always; under an identity argument (`customer`,
 * `account`, `owner`) with three digits or more; elsewhere an integer of six
 * digits or more, or a decimal of five digits or more or under a location or
 * contact argument (`lat: 41.0123`).
 */
export function isGraphqlDataNumber(arg: string | undefined, n: number): boolean {
  if (!Number.isFinite(n)) return false;
  const digits = String(Math.abs(n)).replace(/[.e+-]/g, "").length;
  if (arg && isGraphqlIdArg(arg)) return true;
  if (arg && isIdentityKey(arg) && digits >= 3) return true;
  if (Number.isInteger(n)) return digits >= 6;
  return digits >= 5 || (!!arg && isContactName(arg));
}

function graphqlDocs(v: unknown): string[] {
  const list = Array.isArray(v) ? v : [v];
  return list.filter(isObject).map((o) => o.query).filter((q): q is string => typeof q === "string");
}

/** The last word of a path that names a collection of people: /api/users, /api/team/members, /api/me. */
function personPath(pathname: string): boolean {
  const segs = pathname.split("/").filter((s) => /^[A-Za-z][A-Za-z_-]*$/.test(s));
  return personWord(segs[segs.length - 1]);
}

/** Is this exact string a recorded datum? */
export function isTainted(taint: Taint | undefined, value: string): boolean {
  if (!taint) return false;
  const lower = value.trim().toLowerCase();
  if (taint.allowed.has(lower)) return false;
  return taint.values.has(lower) || isIdentity(taint, lower) || taint.labels.has(lower) || (lower.length >= 8 && taint.aliases.has(aliasOf(lower)) && /\d|@/.test(value));
}

/** Is this slug the identifier form of a distinctive recorded value ("oguz-kilic" for "Oguz Kilic")? */
export function isAliasRecorded(taint: Taint | undefined, value: string): boolean {
  if (!taint) return false;
  const a = aliasOf(value);
  return a.length >= 8 && taint.aliases.has(a);
}

/** A word of a recorded personal name (see {@link Taint.nameParts}). */
export function isNamePart(taint: Taint | undefined, value: string): boolean {
  return !!taint && taint.nameParts.has(value.trim().toLowerCase());
}

/** Recorded only as the one-word name of a thing (see {@link Taint.labels}). */
export function isLabelOnly(taint: Taint | undefined, value: string): boolean {
  const l = value.trim().toLowerCase();
  return !!taint && taint.labels.has(l) && !taint.values.has(l) && !taint.identities.has(l);
}

/** Is this string used to name a person or tenant somewhere in the capture (with these or other separators)? */
export function isIdentity(taint: Taint | undefined, value: string): boolean {
  if (!taint) return false;
  const l = value.trim().toLowerCase();
  return taint.identities.has(l) || (/[._\-]/.test(l) && taint.identityForms.has(aliasOf(l)));
}

function* recordedValues(taint: Taint): Iterable<string> {
  yield* taint.values;
  for (const v of taint.identities) if (dataLength(v) >= 4 && !taint.values.has(v)) yield v;
}

export interface LeakFinding {
  /** Where it was found, e.g. "client.ts". */
  where: string;
  /** A masked preview ("ta…ev", 18 chars) — the value itself is never repeated. */
  preview: string;
  kind: "value" | "identifier";
}

/** Masked description of a value that is safe to print (and to show an LLM). */
export function maskPreview(value: string): string {
  const v = value.trim();
  const kind = isEmail(v) ? "email" : /^\+?[\d\s().-]+$/.test(v) ? "number" : /\s/.test(v) ? "text" : "value";
  const head = v.length > 8 ? v.slice(0, 2) + "…" + v.slice(-2) : v[0] + "…";
  return `${head} (${kind}, ${v.length} chars)`;
}

const TOKEN_SPLIT = /[^\p{L}\p{N}@._+\-~%]+/u;

/** The text plus its percent-decoded form: a path literal is written encoded ("y%C4%B1lmaz"). */
function withDecoded(text: string): string {
  if (!/%[0-9A-Fa-f]{2}/.test(text)) return text;
  return (
    text +
    "\n" +
    text.replace(/(?:%[0-9A-Fa-f]{2})+/g, (m) => {
      try {
        return decodeURIComponent(m);
      } catch {
        return m;
      }
    })
  );
}

/**
 * All lower-cased tokens of a text, the camel-case word runs of every
 * identifier in it, and the pieces of compound tokens ("remember_mdemir",
 * "2.0.0+mdemir") — except the API's own host names, which are meant to appear.
 */
function index(text: string, taint: Taint): { tokens: Set<string>; grams: Set<string>; pieces: Set<string> } {
  const tokens = new Set<string>();
  const grams = new Set<string>();
  const pieces = new Set<string>();
  for (const raw of text.split(TOKEN_SPLIT)) {
    if (!raw) continue;
    const t = trimDotsDashesTildes(raw).toLowerCase();
    if (!t || tokens.has(t)) continue;
    tokens.add(t);
    if (!taint.allowed.has(t) && !hostLabels(taint).has(t)) for (const p of t.split(/[._+\-~%@]+/)) if (dataLength(p) >= 3 && p !== t) pieces.add(p);
    const w = words(raw).slice(0, 12);
    for (let i = 0; i < w.length; i++) {
      let s = "";
      for (let j = i; j < w.length; j++) {
        s += w[j];
        if (s.length >= 8) grams.add(s);
      }
    }
  }
  return { tokens, grams, pieces };
}

const LABELS = new WeakMap<Taint, Set<string>>();

/** Labels of the hosts the capture talked to ("mdemir" for mdemir.myshop.test): the base URL shows them anyway. */
function hostLabels(taint: Taint): Set<string> {
  let out = LABELS.get(taint);
  if (!out) {
    out = new Set();
    for (const a of taint.allowed) for (const l of a.replace(/^[a-z]+:\/\//, "").split(/[.:]/)) if (l) out.add(l);
    LABELS.set(taint, out);
  }
  return out;
}

/**
 * Identifier forms of recorded values that occur in the text, with the form
 * found: whole, or with the "s" a singularised name lost ("OguzDemirtaSetting"
 * from the path segment "oguz-demirtas" followed by "settings").
 */
function aliasesIn(taint: Taint, grams: Set<string>): [alias: string, forms: string[]][] {
  const out: [string, string[]][] = [];
  for (const a of taint.aliases) {
    const forms = [a, ...(a.length >= 9 && a.endsWith("s") ? [a.slice(0, -1)] : [])].filter((f) => grams.has(f));
    if (forms.length) out.push([a, forms]);
  }
  return out;
}

/** An identity found inside a compound token, unless it is a label of the API's own host. */
function inPieces(taint: Taint, pieces: Set<string>, v: string): boolean {
  return taint.identities.has(v) && pieces.has(v) && !hostLabels(taint).has(v);
}

/**
 * Find recorded values in an output. Returns one finding per distinct value;
 * whitespace-free values match whole tokens, longer values must occur verbatim.
 */
export function scanText(input: string, taint: Taint | undefined, where: string, ignore?: Set<string>): LeakFinding[] {
  if (!taint || (!taint.values.size && !taint.aliases.size)) return [];
  const text = withDecoded(input);
  const lower = text.toLowerCase();
  const { tokens, grams, pieces } = index(text, taint);
  const found: LeakFinding[] = [];
  const hit = new Set<string>();
  for (const v of recordedValues(taint)) {
    if (taint.allowed.has(v) || ignore?.has(v)) continue;
    const parts = v.split(TOKEN_SPLIT).filter(Boolean);
    if (!parts.length) continue;
    if (
      parts.length === 1
        ? (tokens.has(trimDotsDashesTildes(parts[0]!)) || inPieces(taint, pieces, v)) && lower.includes(v)
        : parts.every((p) => tokens.has(trimDotsDashesTildes(p))) && lower.includes(v)
    ) {
      found.push({ where, preview: maskPreview(v), kind: "value" });
      hit.add(aliasOf(v));
    }
  }
  for (const [a, forms] of aliasesIn(taint, grams)) {
    if (hit.has(a) || ignore?.has(a)) continue;
    found.push({ where, preview: maskPreview(forms[0]!), kind: "identifier" });
  }
  // An identity with other separators: "ece.kaya" for "ece_kaya".
  for (const t of tokens) {
    if (!/[._\-]/.test(t) || taint.allowed.has(t) || hostLabels(taint).has(t) || taint.identities.has(t)) continue;
    const form = aliasOf(t);
    if (taint.identityForms.has(form) && !hit.has(form)) {
      hit.add(form);
      found.push({ where, preview: maskPreview(t), kind: "identifier" });
    }
  }
  return found;
}

/**
 * Replace recorded values in text meant for reading (prompts, MCP responses,
 * `inspect --json`). Code is never rewritten this way — see {@link scanText}.
 * Everything {@link scanText} would report is replaced: values, identities
 * inside longer tokens, identifier forms in names, slugs and host names
 * ("zeynep-ak.s3…" for "Zeynep Ak"), and percent-encoded forms of all of them.
 */
export function scrubText(text: string, taint: Taint | undefined): string {
  if (!taint) return text;
  const decoded = withDecoded(text);
  const findings = new Set<string>();
  const lower = decoded.toLowerCase();
  const { tokens, grams, pieces } = index(decoded, taint);
  for (const v of recordedValues(taint)) {
    if (taint.allowed.has(v)) continue;
    const parts = v.split(TOKEN_SPLIT).filter(Boolean);
    if (parts.length && (parts.every((p) => tokens.has(trimDotsDashesTildes(p))) || (parts.length === 1 && inPieces(taint, pieces, v))) && lower.includes(v)) findings.add(v);
  }
  for (const t of tokens) if (/[._\-]/.test(t) && !taint.allowed.has(t) && !hostLabels(taint).has(t) && taint.identityForms.has(aliasOf(t))) findings.add(t);
  // Longest first, so "a b c" is replaced before "a b".
  const values = [...findings].sort((a, b) => b.length - a.length).map((v) => new RegExp(escapeRe(v), "gi"));
  const aliasHits = aliasesIn(taint, grams).flatMap(([, forms]) => forms);
  if (!values.length && !aliasHits.length) return text;
  const redact = (s: string): string => {
    let out = s;
    for (const re of values) out = out.replace(re, "<redacted>");
    if (aliasHits.length) {
      // Slugs and host names: the shortest run of pieces that spells the value.
      out = out.replace(/[\p{L}\p{N}]+(?:[._+\-~@][\p{L}\p{N}]+)+/gu, (tok) => redactRuns(tok, aliasHits));
      // Identifier forms (a type named after an email) become a neutral name.
      out = out.replace(/[A-Za-z_$][A-Za-z0-9_$]*/g, (id) => {
        const flat = words(id).join("");
        return aliasHits.some((a) => flat.includes(a)) ? "Redacted" : id;
      });
    }
    return out;
  };
  // Percent-encoded tokens are matched in their decoded form ("G%C3%BCl%C5%9Fen").
  return replacePercentRuns(redact(text), (tok) => {
    let d: string;
    try {
      d = decodeURIComponent(tok);
    } catch {
      return tok;
    }
    const r = redact(d);
    return r === d ? tok : r;
  });
}

/** Replace, inside "zeynep-ak.s3.amazonaws.com", the pieces that spell a recorded value. */
function redactRuns(tok: string, aliases: string[]): string {
  const parts = tok.split(/([._+\-~@])/);
  const out: string[] = [];
  for (let i = 0; i < parts.length; i += 2) {
    let end = -1;
    for (let j = i; j < parts.length && end < 0; j += 2) {
      const flat = words(parts.slice(i, j + 1).join("")).join("");
      if (aliases.some((a) => flat.includes(a))) end = j;
    }
    if (end < 0) {
      out.push(parts[i]!, parts[i + 1] ?? "");
      continue;
    }
    out.push("<redacted>", parts[end + 1] ?? "");
    i = end;
  }
  return out.join("");
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A scrubber that knows what the capture recorded: the one behind the mock and `--examples`. */
export function scrubberFor(taint: Taint): Scrubber {
  return new Scrubber({
    recorded: (s) => isTainted(taint, s) || isNamePart(taint, s),
    identity: (s) => isIdentity(taint, s),
    alias: (s) => isAliasRecorded(taint, s),
    keptHost: (h) => taint.allowed.has(h),
    label: (s) => isLabelOnly(taint, s),
  });
}
