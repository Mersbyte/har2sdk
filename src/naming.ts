/**
 * Deterministic, REST-convention method names:
 *
 *   GET    /users                 → listUsers
 *   GET    /users/{userId}        → getUser
 *   POST   /users                 → createUser
 *   PATCH  /users/{userId}        → updateUser
 *   DELETE /users/{userId}        → deleteUser
 *   GET    /users/{userId}/orders → listUserOrders
 *   POST   /orders/{orderId}/cancel → cancelOrder
 *   POST   /graphql (GetCart)     → getCart
 *
 * Claude (via the MCP server) can override any of these with better names.
 */
import type { Endpoint } from "./model.js";
import { camel, isPlural, pascal, safeIdentifier, singular, words } from "./words.js";

const PREFIX = /^(api|apis|rest|v\d+(\.\d+)*|\d{4}-\d{2}|internal|public|ajax|json|graphql|gql|service|services|backend|bff|svc)$/i;

/** "orders.json" names the same resource as "orders". */
function withoutFormat(tokens: Endpoint["tokens"]): Endpoint["tokens"] {
  return tokens.map((t) => (t.kind === "literal" ? { kind: "literal" as const, value: t.value.replace(/\.(json|xml)$/i, "") || t.value } : t));
}

const ACTIONS = new Set(
  (
    "login logout signin signout signup register authenticate authorize search autocomplete suggest lookup verify validate " +
    "refresh cancel confirm approve reject archive unarchive restore publish unpublish subscribe unsubscribe like unlike follow " +
    "unfollow upload download export import reset send resend checkout pay start stop retry sync query batch count ping " +
    "health activate deactivate enable disable invite accept decline submit preview render calculate estimate translate track"
  ).split(" "),
);

function singularPhrase(s: string): string {
  const w = words(s);
  if (!w.length) return s;
  w[w.length - 1] = singular(w[w.length - 1]!);
  return w.join(" ");
}

function returnsArray(ep: Endpoint): boolean {
  return ep.responses.some((r) => r.status >= 200 && r.status < 300 && !!r.shape.array && !r.shape.object);
}

/** True for action endpoints like POST /orders/{id}/cancel or /auth/login. */
export function isActionEndpoint(ep: Endpoint): boolean {
  if (ep.graphql || ep.rpc) return false;
  const lits = ep.tokens.filter((t) => t.kind === "literal") as { value: string }[];
  const last = lits[lits.length - 1]?.value;
  return !!last && ACTIONS.has(words(last)[0] ?? "");
}

export function baseName(ep: Endpoint): string {
  if (ep.rpc) return safeIdentifier(ep.rpc.procedure);
  if (ep.graphql) {
    const op = ep.graphql.operationName;
    if (ep.graphql.anonymous) return camel(`${ep.graphql.operationType} ${op.replace(/[{},]/g, " ")}`);
    return safeIdentifier(op);
  }
  // Drop leading prefixes like /api/v2 so names stay short.
  let toks = withoutFormat(ep.tokens);
  let start = 0;
  while (start < toks.length && toks[start]!.kind === "literal" && PREFIX.test((toks[start] as { value: string }).value)) start++;
  if (start === toks.length && toks.length) start = toks.length - 1;
  toks = toks.slice(start);

  const lastLiteralIdx = findLastIndex(toks, (t) => t.kind === "literal");
  const endsWithParam = toks.length > 0 && toks[toks.length - 1]!.kind === "param";
  if (lastLiteralIdx < 0) {
    return camel(ep.method.toLowerCase() + (endsWithParam ? " item" : " root"));
  }
  const last = (toks[lastLiteralIdx] as { value: string }).value;
  const parents: string[] = [];
  for (let i = 0; i < lastLiteralIdx; i++) {
    const t = toks[i]!;
    if (t.kind === "literal" && toks[i + 1]?.kind === "param") parents.push(pascal(singularPhrase(t.value)));
  }
  const lastWords = words(last);
  if (lastWords.length && ACTIONS.has(lastWords[0]!)) {
    return camel(last) + parents.join("");
  }

  // A plural collection nested directly under another literal (/cart/items)
  // is named after both: listCartItems, createCartItem.
  const prev = toks[lastLiteralIdx - 1];
  const lastIsPlural = isPlural(lastWords[lastWords.length - 1] ?? "");
  if (prev?.kind === "literal" && !PREFIX.test(prev.value) && lastIsPlural && !ACTIONS.has(words(prev.value)[0] ?? "")) {
    parents.push(pascal(singularPhrase(prev.value)));
  }
  const parentStr = parents.join("");

  const resource = parentStr + (endsWithParam ? pascal(singularPhrase(last)) : pascal(last));
  switch (ep.method) {
    case "GET":
      if (endsWithParam) return "get" + resource;
      return lastIsPlural || returnsArray(ep) ? "list" + resource : "get" + resource;
    case "POST":
      if (endsWithParam) return "update" + resource;
      return "create" + parentStr + pascal(singularPhrase(last));
    case "PUT":
    case "PATCH":
      return "update" + resource;
    case "DELETE":
      return "delete" + resource;
    default:
      return camel(ep.method.toLowerCase()) + resource;
  }
}

export function tagFor(ep: Endpoint): string {
  if (ep.graphql) return "graphql";
  if (ep.rpc) return camel(ep.rpc.procedure.split(".")[0] ?? "rpc") || "rpc";
  for (const t of withoutFormat(ep.tokens)) if (t.kind === "literal" && !PREFIX.test(t.value)) return camel(t.value) || "default";
  return "default";
}

/** Members of the generated client class that endpoint methods must not shadow. */
// `then`, `catch` and `finally` would make the client a thenable: `await client` would call them.
export const RESERVED_METHOD_NAMES = new Set(["request", "graphql", "jsonRpc", "trpc", "rpcId", "baseUrl", "options", "constructor", "toString", "valueOf", "hasOwnProperty", "then", "catch", "finally", "__proto__", "prototype", "toJSON"]);

export function assignNames(endpoints: Endpoint[]): void {
  const used = new Set<string>(RESERVED_METHOD_NAMES);
  for (const ep of endpoints) {
    ep.tag = tagFor(ep);
    let base = baseName(ep);
    if (RESERVED_METHOD_NAMES.has(base)) base = camel(ep.method.toLowerCase() + " " + base);
    const lastParam = ep.pathParams[ep.pathParams.length - 1]?.name;
    // A second GraphQL document under the same name: name it by what it adds (feedByAfter).
    const vars = ep.graphql?.query ? [...new Set([...ep.graphql.query.matchAll(/\$([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]!))] : [];
    const candidates = [
      ep.id.includes("@") && vars.length ? base + "By" + vars.slice(0, 2).map((v) => pascal(v)).join("And") : "",
      base,
      camel(ep.method.toLowerCase() + " " + base.replace(/^(get|list|create|update|delete)/, "")),
      lastParam ? base + "By" + pascal(lastParam) : "",
      ep.origin ? base + pascal(new URL(ep.origin).hostname.split(".")[0] ?? "") : "",
    ].filter(Boolean);
    let name = candidates.find((c) => !used.has(c));
    if (!name) {
      let n = 2;
      while (used.has(base + n)) n++;
      name = base + n;
    }
    used.add(name);
    ep.name = name;
  }
}

function findLastIndex<T>(arr: T[], fn: (t: T) => boolean): number {
  for (let i = arr.length - 1; i >= 0; i--) if (fn(arr[i]!)) return i;
  return -1;
}
