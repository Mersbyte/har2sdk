/** Small, dependency-free helpers for turning URL fragments into identifiers. */

/** Split "userId", "user_id", "user-id", "UserID" into ["user", "id"]. */
const WORDS_CACHE = new Map<string, string[]>();

export function words(input: string): string[] {
  const hit = WORDS_CACHE.get(input);
  if (hit) return hit.slice();
  const out = ascii(input)
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
  if (input.length <= 64) {
    if (WORDS_CACHE.size > 20000) WORDS_CACHE.clear();
    WORDS_CACHE.set(input, out);
    return out.slice();
  }
  return out;
}

/** "Kılıç" → "Kilic", "Søren" → "Soren": identifiers and identifier forms are ASCII. */
export function ascii(input: string): string {
  if (/^[\x00-\x7f]*$/.test(input)) return input;
  return input
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/ı/g, "i")
    .replace(/İ/g, "I")
    .replace(/ß/g, "ss")
    .replace(/[øØ]/g, (c) => (c === "ø" ? "o" : "O"))
    .replace(/[łŁ]/g, (c) => (c === "ł" ? "l" : "L"))
    .replace(/[æÆ]/g, (c) => (c === "æ" ? "ae" : "Ae"))
    .replace(/[đĐ]/g, (c) => (c === "đ" ? "d" : "D"));
}

export function pascal(input: string): string {
  return words(input)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join("");
}

export function camel(input: string): string {
  const p = pascal(input);
  return p ? p[0]!.toLowerCase() + p.slice(1) : p;
}

const IRREGULAR = new Map<string, string>(Object.entries({
  people: "person",
  children: "child",
  men: "man",
  women: "woman",
  feet: "foot",
  teeth: "tooth",
  mice: "mouse",
  data: "data",
  media: "media",
  news: "news",
  series: "series",
  species: "species",
  status: "status",
  analysis: "analysis",
  address: "address",
  business: "business",
  cookies: "cookie",
  movies: "movie",
  pies: "pie",
  ties: "tie",
}));

/** Naive English singulariser — good enough for REST resource names. */
export function singular(word: string): string {
  const lower = word.toLowerCase();
  const irregular = IRREGULAR.get(lower);
  if (irregular) return matchCase(word, irregular);
  if (/(ss|us|is)$/i.test(word)) return word;
  if (/ies$/i.test(word) && word.length > 4) return word.slice(0, -3) + "y";
  if (/(ches|shes|xes|zes|sses)$/i.test(word)) return word.slice(0, -2);
  if (/oes$/i.test(word)) return word.slice(0, -2);
  if (/s$/i.test(word) && word.length > 2) return word.slice(0, -1);
  return word;
}

export function isPlural(word: string): boolean {
  return singular(word).toLowerCase() !== word.toLowerCase();
}

function matchCase(original: string, replacement: string): string {
  return original[0] === original[0]!.toUpperCase() ? replacement[0]!.toUpperCase() + replacement.slice(1) : replacement;
}

const RESERVED = new Set(
  (
    "break case catch class const continue debugger default delete do else enum export extends false finally for " +
    "function if import in instanceof new null return super switch this throw true try typeof var void while with " +
    "as implements interface let package private protected public static yield await constructor"
  ).split(" "),
);

export function isIdentifier(name: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name);
}

/** A safe variable name for a free-form string (falls back to "value"). */
export function safeIdentifier(name: string, fallback = "value"): string {
  let id = camel(name);
  if (!id) id = fallback;
  if (/^[0-9]/.test(id)) id = "_" + id;
  if (RESERVED.has(id)) id = id + "_";
  return id;
}

/** Quote an object key only if needed. */
export function propertyKey(name: string): string {
  return isIdentifier(name) ? name : JSON.stringify(name);
}

/** `obj[key] = value`, but "__proto__" stays an own property (as `JSON.parse` makes it) instead of replacing the prototype. */
export function setOwn(obj: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true });
}
