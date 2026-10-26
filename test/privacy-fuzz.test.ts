/**
 * Generated privacy test — random values AND random structure.
 *
 * Each seed builds a synthetic person and a capture assembled from a random
 * subset of "sites" (places a value can hide), each with random key names
 * (English, Turkish, German, Spanish, invented), random nesting, single- or
 * multi-sample endpoints, letter-only and digit-bearing identifiers, random
 * header names, random GraphQL argument names, Rails-style query names,
 * forms, text bodies, RPC inputs, error bodies and sensitive vocabulary in
 * category-like fields, and (review 5) XML / plain-text bodies, usernames under
 * role keys, identities inside cookie names and version metadata, GraphQL
 * number / list / block-string / GET / batched literals, user-named hosts,
 * small name-keyed dictionaries, issue keys, tenant slugs, file names and
 * non-ASCII dotted names in paths, and dates in a person's record; and
 * (review 6) a word of a person's name in a technical field, random tokens
 * without digits in paths, and prototype keys (`__proto__`, `constructor`);
 * (review 7) a username in the file name of a URL (`avatars/<user>.png`).
 * A second suite checks that readable outputs redact slugs, host names and
 * percent-encoded forms of a name wherever the files are refused, and (review 8)
 * show no GraphQL comment or free-text operation name carrying it.
 *
 * Fairness: every value is placed with *some* evidence a careful reader would
 * use — a personal or identity key somewhere in the capture, an id- or
 * email-like shape, a dictionary of same-shaped entries, an echo in the
 * response. Values with no evidence at all (a lowercase word used as a path
 * segment once and nowhere else) are a documented limit and are not placed.
 *
 * Every output is searched: client.ts, openapi.json (± --examples), the chat
 * prompt, the render functions MCP uses, a real MCP client session, the real
 * CLI's `inspect --json` and every response of the mock — on every seed.
 *
 * HAR2SDK_FUZZ_SEEDS=1000 for the long run; HAR2SDK_FUZZ_FROM=<n> to start elsewhere.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { generateFromHar } from "../src/index.js";
import { scanText } from "../src/leak.js";
import { createMcpServer } from "../src/mcp.js";
import { listenMock } from "../src/mock.js";
import { buildPlan } from "../src/plan.js";
import { renderChatPrompt, renderEndpointDetail, renderEndpointList } from "../src/summary.js";
import { words } from "../src/words.js";
import { ROOT, entry, har } from "./helpers.js";

type Entry = ReturnType<typeof entry>;

function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1));
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)]!;
  const chance = (p: number) => next() < p;
  const digits = (n: number) => Array.from({ length: n }, (_, i) => String(i === 0 ? int(1, 9) : int(0, 9))).join("");
  const alnum = (n: number, chars = "abcdefghijkmnpqrstuvwxyz23456789") => Array.from({ length: n }, () => pick([...chars])).join("");
  const shuffle = <T,>(xs: T[]): T[] => xs.map((x) => [next(), x] as const).sort((p, q) => p[0] - q[0]).map(([, x]) => x);
  return { next, int, pick, chance, digits, alnum, shuffle };
}
type R = ReturnType<typeof rng>;

const FIRST = ["Kaan", "Ayşe", "Mehmet", "Zeynep", "Kerem", "Elif", "Burak", "Selin", "Oğuzhan", "Defne", "Jonas", "Ingrid", "Priya", "Mateo", "Chiara", "Søren", "Nkechi", "Haruki", "Ece", "Baran"];
const LAST = ["Çakırtaş", "Yılmaz", "Demirtaş", "Kayaoğlu", "Öztürk", "Arslanbay", "Lindqvist", "Okafor", "Ferreira", "Novakova", "Takahashi", "Kowalczyk"];
const DOMAINS = ["gmail.com", "ornek.com.tr", "proton.me", "firma.de", "uni.edu", "mail.example"];
const SENSITIVE_VOCAB = ["onkoloji", "psikiyatri", "kardiyoloji", "hivtesti", "ivf-tedavisi", "depresyon", "gebelik", "bagimlilik"];

// Key-name pools: the generator picks and recombines, so names vary per seed.
const KEYS = {
  fullName: ["fullName", "full_name", "displayName", "adSoyad", "isim", "customerName", "patientName", "realName", "nombre"],
  first: ["firstName", "first_name", "givenName", "ad", "vorname"],
  email: ["email", "e_mail", "eposta", "contactEmail", "mail", "emailAddress", "correo"],
  phone: ["phone", "phoneNumber", "telefon", "mobile", "gsm", "tel", "cellphone"],
  birth: ["birthDate", "dob", "dateOfBirth", "birth_date", "dogumTarihi", "geburtsdatum", "fechaNacimiento"],
  national: ["nationalId", "tckn", "tcKimlikNo", "national_id_number", "ssn", "kimlikNo"],
  address: ["address", "homeAddress", "street", "adres", "adresse", "direccion", "line1"],
  identity: ["login", "username", "handle", "owner", "author", "createdBy", "assignee", "sender", "userName", "memberLogin"],
  idField: ["id", "orderNumber", "channelId", "sourceRef", "ticketNo", "caseNumber", "refId", "uuid"],
  category: ["category", "specialty", "department", "tag", "segment", "topic", "kategori", "bolum"],
  neutral: ["meta", "info", "detail", "payload", "extra", "context", "attributes", "props"],
  plural: ["people", "users", "members", "profiles", "accounts", "authors", "contacts", "patients"],
  sub: ["repos", "followers", "posts", "settings", "activity", "notes", "files"],
  idHeader: ["x-user", "x-tenant", "x-account", "x-workspace-slug", "x-org", "x-user-name"],
  plainHeader: ["x-client", "x-app", "x-client-name", "x-device-name", "x-source", "x-channel"],
  gqlArg: ["email", "username", "q", "term", "tag", "handle", "search", "keyword", "filter"],
  role: ["reviewer", "approver", "requester", "participant", "editor", "organizer", "invitee", "maintainer"],
  files: ["files", "attachments", "documents", "uploads"],
  xmlTag: ["login", "username", "owner", "author", "userName"],
  technical: ["type", "kind", "channel", "source"],
};

interface Persona {
  values: string[];
  first: string;
  last: string;
  username: string;
  usernames: string[];
  email: string;
  phone: string;
  tckn: string;
  iban: string;
  birth: string;
  orderNos: string[];
  device: string;
  signedUrl: string;
  message: string;
  address: string;
  lat: number;
  tenant: string;
  vocab: string[];
  bigId: string;
  issueKey: string;
  fileStem: string;
  orgSlug: string;
  dotted: string;
  siteSlug: string;
  token: string;
}

function persona(r: R): Persona {
  const first = r.pick(FIRST);
  const last = r.pick(LAST);
  const ascii = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/ı/g, "i").replace(/ø/g, "o").toLowerCase();
  const user = () => {
    const f = ascii(r.pick(FIRST));
    const l = ascii(r.pick(LAST));
    // Letter-only usernames are the hard case; digits only sometimes.
    return r.pick([`${f[0]}${l}`, `${f}${l[0]}`, `${f}.${l}`, `${f}_${l}`, `${f}${r.digits(2)}`, `${l}${f[0]}`]);
  };
  const username = r.pick([`${ascii(first)[0]}${ascii(last)}`, `${ascii(first)}.${ascii(last)}`, `${ascii(first)}_${ascii(last)}`, `${ascii(first)}${r.digits(2)}`]);
  const usernames = [username, ...Array.from({ length: r.int(2, 4) }, user)].filter((u, i, a) => a.indexOf(u) === i);
  const email = `${r.pick([ascii(first) + "." + ascii(last), username.replace(/[._]/g, ""), ascii(first) + r.digits(3)])}@${r.pick(DOMAINS)}`;
  const phone = r.pick([`+90 5${r.digits(2)} ${r.digits(3)} ${r.digits(2)} ${r.digits(2)}`, `+1 (${r.digits(3)}) ${r.digits(3)}-${r.digits(4)}`, `+49${r.digits(10)}`, `05${r.digits(9)}`]);
  const tckn = r.digits(11);
  const iban = `TR${r.digits(2)} ${r.digits(4)} ${r.digits(4)} ${r.digits(4)} ${r.digits(4)} ${r.digits(4)} ${r.digits(2)}`;
  const birth = `${r.int(1950, 2006)}-0${r.int(1, 9)}-${r.int(10, 28)}`;
  const fmt = r.pick([() => `ORD-${r.digits(5)}`, () => `ord_${r.alnum(8)}`, () => `${r.int(2024, 2026)}-${r.digits(6)}`, () => `A${r.alnum(5, "ABCDEFGHJKLMNPQRSTUVWXYZ23456789")}`, () => `C0${r.alnum(7, "ABCDEFGHJKLMNPQRSTUVWXYZ0123456789")}`]);
  const orderNos = [fmt(), fmt(), fmt(), fmt()];
  const hex = "0123456789abcdef";
  const device = `${r.alnum(8, hex)}-${r.alnum(4, hex)}-4${r.alnum(3, hex)}-a${r.alnum(3, hex)}-${r.alnum(12, hex)}`;
  const akia = "AKIA" + r.alnum(16, "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567");
  const signedUrl = `https://files.s.test/u/${r.alnum(6)}/doc.pdf?X-Amz-Credential=${akia}%2F2026&X-Amz-Signature=${r.alnum(40, hex)}`;
  const address = `${r.pick(["Moda", "Bağdat", "Atatürk", "Hauptstraße", "Rua Augusta"])} ${r.pick(["Cd.", "Sk.", "Str.", "Blvd"])} No:${r.int(1, 200)} ${r.pick(["Kadıköy", "Çankaya", "Mitte", "Baixa"])}`;
  const message = r.pick([`Merhaba, ben ${first} ${last}. TC: ${tckn}, IBAN ${iban}. Tel ${phone}`, `Please ship to ${address}; call ${phone} or mail ${email}`, `Refund for ${orderNos[0]} to ${iban} — ${first}`]);
  const lat = Number(`${r.int(10, 60)}.${r.digits(3)}${r.int(1, 9)}`);
  const tenant = `${ascii(first)}s-${r.pick(["clinic", "studio", "shop", "lab"])}`;
  const vocab = r.shuffle([...SENSITIVE_VOCAB]).slice(0, 2);
  const bigId = r.digits(r.int(7, 12));
  const issueKey = `${ascii(last).slice(0, r.int(2, 4)).toUpperCase()}-${r.int(1, 99)}`;
  const fileStem = `${ascii(first)}-${vocab[0]}-${r.pick(["results", "report", "cv", "scan"])}`;
  const orgSlug = `${ascii(last)}${r.pick(["s-labs", "-partners", "-holdings", "s"])}`;
  // A dotted name in its own script ("ayşe.yılmaz"), as a path segment with no other evidence.
  const dotted = `${first.toLowerCase()}.${last.toLowerCase()}`;
  const siteSlug = `${ascii(first)}-${ascii(last)}`;
  // A reset or invite token that happens to have no digit.
  const token = r.alnum(r.int(20, 28), "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ");
  const values = [first, last, `${first} ${last}`, ...usernames, email, phone, tckn, iban, birth, ...orderNos, device, akia, signedUrl.split("?")[1]!, address, message, String(lat), tenant, ...vocab, bigId, issueKey, fileStem, orgSlug, dotted, token];
  return { values, first, last, username, usernames, email, phone, tckn, iban, birth, orderNos, device, signedUrl, message, address, lat, tenant, vocab, bigId, issueKey, fileStem, orgSlug, dotted, siteSlug, token };
}

/** A capture built from a random subset of sites. */
function capture(seed: number): { entries: Entry[]; p: Persona; sites: string[]; origin: string } {
  const r = rng(seed);
  const p = persona(r);
  const origin = `https://api.${r.pick(["acme", "nimbus", "kargo", "atlas", "fjord", "zirve"])}.test`;
  const e: Entry[] = [];
  const k = (pool: keyof typeof KEYS) => r.pick(KEYS[pool]);
  const headers: Record<string, string> = { "accept-language": r.pick(["tr-TR,tr;q=0.9", "en-US", "de-DE"]), "x-app-version": `${r.int(1, 9)}.${r.int(0, 20)}.${r.int(0, 9)}` };
  if (r.chance(0.7)) headers[k("plainHeader")] = r.pick([p.email, `${p.username}-ipad`, p.device, `${p.first}'s iPhone`]);
  if (r.chance(0.6)) headers[k("idHeader")] = r.pick([p.username, p.tenant]);
  const H = () => ({ ...headers, authorization: `Bearer eyJhbGciOiJIUzI1NiJ9.${r.alnum(30)}.${r.alnum(20)}`, cookie: `sid=${r.alnum(24)}; _ga=GA1.1.${r.digits(9)}` });
  const n = (min = 1, max = 3) => r.int(min, max);
  const wrap = (v: unknown) => (r.chance(0.3) ? { [k("neutral")]: v } : r.chance(0.2) ? { data: v } : v);

  // The person is always shown somewhere with their identity and contact keys
  // (the evidence the other sites rely on).
  const profile: Record<string, unknown> = { id: `usr_${r.alnum(8)}`, status: r.pick(["active", "pending"]), [k("identity")]: p.username };
  for (const pool of r.shuffle(["fullName", "first", "email", "phone", "birth", "national", "address"] as const).slice(0, n(3, 6))) {
    const v = { fullName: `${p.first} ${p.last}`, first: p.first, email: p.email, phone: p.phone, birth: p.birth, national: p.tckn, address: p.address }[pool];
    profile[k(pool)] = v;
  }
  if (r.chance(0.5)) profile.geo = { lat: p.lat, lng: 29.0234 };
  for (let i = 0; i < n(1, 2); i++) e.push(entry({ url: `${origin}/api/${r.pick(["me", "profile", "account", "session"])}`, reqHeaders: H(), resBody: wrap(profile) }));
  // Every other username shows up as somebody's identity too (a members list).
  e.push(entry({ url: `${origin}/api/${r.pick(["team", "org", "space"])}/members`, reqHeaders: H(), resBody: p.usernames.map((u, i) => ({ id: i + 1, [k("identity")]: u })) }));

  const sites: Record<string, () => void> = {
    dictByUsername: () => {
      const entryShape = () => r.pick([{ online: r.chance(0.5) }, { emoji: "+1", at: "2026-01-01" }, { role: "member", since: "2025-01-01" }]);
      const shape = entryShape();
      const dict = Object.fromEntries(p.usernames.slice(0, n(1, p.usernames.length)).map((u) => [u, { ...shape }]));
      e.push(entry({ url: `${origin}/api/${r.pick(["presence", "reactions", "prefs", "seen"])}`, reqHeaders: H(), resBody: wrap(r.chance(0.5) ? dict : { [k("neutral")]: dict }) }));
    },
    dictByEmail: () => {
      e.push(entry({ url: `${origin}/api/${r.pick(["invites", "shares"])}`, reqHeaders: H(), resBody: { [p.email]: { ok: true }, ...(r.chance(0.5) ? { [p.phone]: { ok: false } } : {}) } }));
    },
    idsInCategoricalNames: () => {
      const idKey = k("idField");
      const list = Array.from({ length: r.int(6, 10) }, (_, i) => ({ [idKey]: p.orderNos[i % 2]!, state: i % 2 ? "open" : "closed", total: i * 10 }));
      e.push(entry({ url: `${origin}/api/${r.pick(["orders", "tickets", "cases"])}`, reqHeaders: H(), resBody: wrap(list) }));
    },
    sensitiveCategories: () => {
      const field = k("category");
      const list = Array.from({ length: r.int(6, 10) }, (_, i) => ({ id: i, [field]: p.vocab[i % 2]!, status: i % 2 ? "open" : "done" }));
      e.push(entry({ url: `${origin}/api/${r.pick(["appointments", "visits", "referrals"])}`, reqHeaders: H(), resBody: list }));
    },
    idsInPaths: () => {
      const res = r.pick(["orders", "tickets", "invoices"]);
      for (const no of p.orderNos.slice(0, n(1, 3))) e.push(entry({ url: `${origin}/api/${res}/${encodeURIComponent(no)}`, reqHeaders: H(), resBody: { id: no, total: 5 } }));
      e.push(entry({ method: "POST", url: `${origin}/api/${res}/${encodeURIComponent(p.orderNos[3]!)}/${r.pick(["refund", "cancel", "track"])}`, reqHeaders: H(), reqBody: { reason: p.message }, resBody: { ok: true } }));
    },
    usernamesInPaths: () => {
      const u = r.pick(p.usernames);
      const coll = k("plural");
      const sub = r.chance(0.6) ? "/" + k("sub") : "";
      e.push(entry({ url: `${origin}/api/${coll}/${encodeURIComponent(u)}${sub}`, reqHeaders: H(), resBody: sub ? [{ id: 1 }] : { id: 1, bio: "x" } }));
    },
    tenantInPath: () => {
      headers["x-tenant"] = p.tenant;
      e.push(entry({ url: `${origin}/api/${r.pick(["teams", "workspaces", "spaces", "clinics"])}/${p.tenant}/${k("sub")}`, reqHeaders: H(), resBody: [{ id: 1 }] }));
    },
    graphql: () => {
      const arg = k("gqlArg");
      const lit = r.pick([p.email, p.username, `${p.first} ${p.last}`, p.vocab[0]!, p.phone]);
      e.push(entry({ method: "POST", url: `${origin}/graphql`, reqHeaders: H(), reqBody: { query: `query ${r.pick(["Find", "Lookup", "Search"])}${r.int(1, 9)} { ${r.pick(["user", "doctors", "people"])}(${arg}: ${JSON.stringify(lit)}) { id } }` }, resBody: { data: { user: { id: 1 } } } }));
      if (r.chance(0.5)) e.push(entry({ method: "POST", url: `${origin}/graphql`, reqHeaders: H(), reqBody: { query: `{ search(text: ${JSON.stringify(p.message)}) { id } }` }, resBody: { data: { search: [] } } }));
    },
    queryStrings: () => {
      const qs = [`q=${encodeURIComponent(p.first + " " + p.last)}`, `${r.pick(["email", "contact", "eposta"])}=${encodeURIComponent(p.email)}`, `near=${p.lat}`];
      if (r.chance(0.6)) qs.push(`${r.pick(["role", "perm", "acl"])}%5B${encodeURIComponent(p.email)}%5D=admin`);
      e.push(entry({ url: `${origin}/api/search?${r.shuffle(qs).join("&")}&page=1`, reqHeaders: H(), resBody: { hits: [{ id: 1, avatar: p.signedUrl }] } }));
    },
    forms: () => {
      e.push(entry({ method: "POST", url: `${origin}/api/${r.pick(["support", "contact", "feedback"])}`, reqHeaders: H(), reqMime: "application/x-www-form-urlencoded", reqBody: `${k("first")}=${encodeURIComponent(p.first)}&${k("phone")}=${encodeURIComponent(p.phone)}&msg=${encodeURIComponent(p.message)}`, resBody: { ticket: `T-${r.digits(6)}` } }));
    },
    textBodies: () => {
      e.push(entry({ url: `${origin}/api/export.${r.pick(["csv", "txt"])}`, reqHeaders: H(), resMime: "text/plain", resText: `name,email,phone\n${p.first} ${p.last},${p.email},${p.phone}\n${p.message}` }));
    },
    rpc: () => {
      if (r.chance(0.5)) e.push(entry({ method: "POST", url: `${origin}/rpc`, reqHeaders: H(), reqBody: { jsonrpc: "2.0", id: 1, method: "user.lookup", params: { [k("email")]: p.email } }, resBody: { jsonrpc: "2.0", id: 1, result: { id: 7, [k("first")]: p.first } } }));
      else e.push(entry({ method: "POST", url: `${origin}/api/trpc/user.find`, reqHeaders: H(), reqBody: { json: { [k("email")]: p.email } }, resBody: { result: { data: { json: { id: 7, [k("identity")]: p.username } } } } }));
    },
    errors: () => {
      // Evidence: the order number is listed elsewhere, as a real app would.
      e.push(entry({ url: `${origin}/api/orders`, reqHeaders: H(), resBody: [{ id: p.orderNos[0], total: 1 }] }));
      e.push(entry({ url: `${origin}/api/orders/${encodeURIComponent(p.orderNos[0]!)}/invoice`, status: 404, reqHeaders: H(), resBody: { error: "not_found", detail: `No invoice for ${p.email}` } }));
    },
    // ── review 5 placements ──
    xmlBodies: () => {
      const tag = k("xmlTag");
      e.push(entry({ url: `${origin}/api/${r.pick(["legacy", "soap", "feed"])}/me`, resMime: r.pick(["application/xml", "text/xml"]), resText: `<?xml version="1.0"?><user><${tag}>${p.username}</${tag}><fullName>${p.first} ${p.last}</fullName><note><![CDATA[${p.message}]]></note><status>active</status></user>` }));
      e.push(entry({ url: `${origin}/api/whoami.txt`, resMime: "text/plain", resText: `${p.username}\n${p.message}` }));
    },
    roleKeys: () => {
      const u = r.pick(p.usernames);
      e.push(entry({ url: `${origin}/api/reviews/${r.int(1, 999)}`, reqHeaders: H(), resBody: { id: 1, [k("role")]: u, state: "open" } }));
      e.push(entry({ url: `${origin}/api/${k("plural")}/${encodeURIComponent(u)}/${k("sub")}`, reqHeaders: H(), resBody: [{ id: 1 }] }));
    },
    compoundNames: () => {
      headers.cookie = `remember_${p.username}=1`;
      headers["x-app-version"] = `${r.int(1, 9)}.${r.int(0, 9)}.0+${p.username}`;
    },
    graphqlLiterals: () => {
      const docs = [
        `query ${r.pick(["GetUser", "Profile", "Account"])} { user(id: ${p.bigId}) { id } }`,
        `query FindMany { users(${k("gqlArg")}: [${JSON.stringify(p.email)}, ${JSON.stringify(p.username)}]) { id } }`,
        `mutation AddNote { addNote(text: """${p.message}""") { id } }`,
      ];
      for (const q of r.shuffle(docs).slice(0, r.int(1, 3))) e.push(entry({ method: "POST", url: `${origin}/graphql`, reqHeaders: H(), reqBody: { query: q }, resBody: { data: { x: { id: 1 } } } }));
      e.push(entry({ url: `${origin}/graphql?operationName=ByLogin&query=${encodeURIComponent(`query ByLogin { user(login: ${JSON.stringify(p.username)}) { id } }`)}`, reqHeaders: H(), resBody: { data: { user: { id: 1 } } } }));
    },
    graphqlBatch: () => {
      e.push(entry({ method: "POST", url: `${origin}/graphql`, reqHeaders: H(), reqBody: [{ operationName: "Cart", query: "query Cart { cart { id } }" }, { operationName: "Who", query: `query Who { who(handle: ${JSON.stringify(p.username)}) { id } }` }], resBody: [{ data: { cart: { id: 1 } } }, { data: { who: { id: 2 } } }] }));
    },
    hostUrls: () => {
      const slug = /^[a-z0-9-]+$/.test(p.username) ? p.username : p.username.replace(/[^a-z0-9]+/g, r.pick(["-", "_", "."]));
      e.push(entry({ url: `${origin}/api/links`, reqHeaders: H(), resBody: { site: `https://${p.siteSlug}.dev`, blog: `https://${slug.replace(/[._]/g, "-")}.github.io/`, owner: { [k("identity")]: p.username, [k("fullName")]: `${p.first} ${p.last}` } } }));
    },
    smallDicts: () => {
      const a = p.usernames[1] ?? p.username;
      e.push(entry({ url: `${origin}/api/${r.pick(["scores", "votes", "seen"])}`, reqHeaders: H(), resBody: { [p.username]: r.chance(0.5) ? { n: 1 } : 1, [a]: r.chance(0.5) ? { n: 2 } : 2 } }));
    },
    pathShapes: () => {
      e.push(entry({ url: `${origin}/api/issue/${p.issueKey}${r.pick(["", "/comment", "/worklog"])}`, reqHeaders: H(), resBody: { id: r.digits(5), fields: { status: "open" } } }));
      e.push(entry({ url: `${origin}/orgs/${p.orgSlug}/${r.pick(["members", "repos", "teams"])}`, reqHeaders: H(), resBody: [{ id: 1 }] }));
      e.push(entry({ url: `${origin}/api/${k("files")}/${p.fileStem}.${r.pick(["pdf", "png", "docx"])}/${r.pick(["meta", "share", "versions"])}`, reqHeaders: H(), resBody: { size: 3 } }));
      e.push(entry({ url: `${origin}/api/${k("plural")}/${encodeURIComponent(p.dotted)}`, reqHeaders: H(), resBody: { id: 1, bio: "x" } }));
    },
    personRecord: () => {
      e.push(entry({ url: `${origin}/api/${r.pick(["patients", "members", "contacts"])}/${r.int(1, 99)}`, reqHeaders: H(), resBody: { id: 1, [k("email")]: p.email, [r.pick(["born", "joined", "visitDay", "dob"])]: p.birth, updatedAt: "2026-01-01T00:00:00Z" } }));
    },
    nestedPersonal: () => {
      const obj: Record<string, unknown> = { id: 1 };
      obj[k("neutral")] = { [k("identity")]: r.pick(p.usernames), [k("fullName")]: `${p.first} ${p.last}`, contact: { [k("email")]: p.email, [k("phone")]: p.phone } };
      e.push(entry({ url: `${origin}/api/${r.pick(["posts", "comments", "events"])}/${r.int(1, 99)}`, reqHeaders: H(), resBody: obj }));
    },
    // ── review 6 placements ──
    nameInTechnicalField: () => {
      const field = k("technical");
      e.push(entry({ url: `${origin}/api/${r.pick(["contacts", "people", "customers"])}`, reqHeaders: H(), resBody: [{ id: 1, [k("fullName")]: `${p.first} ${p.last}` }] }));
      const list = Array.from({ length: r.int(6, 10) }, (_, i) => ({ id: i, state: i % 3 ? "open" : "closed", [field]: i % 2 ? p.first.toLowerCase() : r.pick(["general", "web"]) }));
      e.push(entry({ url: `${origin}/api/${r.pick(["tickets", "jobs", "tasks"])}`, reqHeaders: H(), resBody: wrap(list) }));
    },
    digitlessTokens: () => {
      e.push(entry({ method: "POST", url: `${origin}/api/${r.pick(["invite", "password-reset", "magic-link", "share"])}/${p.token}/${r.pick(["accept", "confirm", "open"])}`, reqHeaders: H(), reqBody: { ok: 1 }, resBody: { ok: true } }));
    },
    // ── review 7 placements ──
    fileNames: () => {
      // A username in the file name of a URL: avatars/<user>.png, <user>_avatar.jpg, <user>-cover.webp.
      const u = r.pick(p.usernames);
      const name = `${u}${r.pick(["", "_avatar", "-photo", ".thumb"])}.${r.pick(["png", "jpg", "webp"])}`;
      e.push(entry({ url: `${origin}/api/${r.pick(["profile", "people/1", "team/members/1"])}`, reqHeaders: H(), resBody: { id: 1, [k("identity")]: u, [r.pick(["avatar", "photo", "picture", "cover"])]: `https://cdn.${r.pick(["acme", "img"])}.test/${r.pick(["avatars", "u", "media/2026"])}/${name}` } }));
    },
    protoKeys: () => {
      const body = JSON.stringify({ status: "ok" }).replace("{", `{"constructor":{"by":${JSON.stringify(p.username)}},"__proto__":{"email":${JSON.stringify(p.email)}},`);
      e.push(entry({ url: `${origin}/api/${r.pick(["meta", "objects", "schema"])}`, reqHeaders: H(), resText: body }));
    },
  };
  const chosen = r.shuffle(Object.keys(sites)).slice(0, r.int(7, Object.keys(sites).length));
  for (const s of chosen) sites[s]!();
  return { entries: r.shuffle(e), p, sites: chosen, origin };
}

/** Every way a value could show up: as written, lower-cased, and as an identifier. */
function forms(v: string): string[] {
  const out = new Set<string>();
  const t = v.trim();
  if (t.length >= 4) out.add(t.toLowerCase());
  const w = words(t.normalize("NFD").replace(/[̀-ͯ]/g, ""));
  if (w.join("").length >= 7) out.add(w.join(""));
  return [...out];
}

function findLeaks(text: string, p: Persona): string[] {
  const lower = text.toLowerCase();
  const flat = words(text.normalize("NFD").replace(/[̀-ͯ]/g, "")).join("");
  const hits: string[] = [];
  for (const v of p.values) {
    for (const f of forms(v)) {
      const found = /[^a-z0-9]/.test(f) ? lower.includes(f) : new RegExp(`(^|[^a-z0-9])${f}([^a-z]|$)`).test(lower) || (f.length >= 7 && flat.includes(f));
      if (found) {
        const at = lower.indexOf(f);
        const context = at >= 0 ? text.slice(Math.max(0, at - 60), at + f.length + 30).replace(/\s+/g, " ") : "(identifier)";
        hits.push(`${JSON.stringify(v)} (as ${JSON.stringify(f)})${process.env.FUZZ_DEBUG ? " … " + context : ""}`);
        break;
      }
    }
  }
  return hits;
}

async function mockResponses(r: ReturnType<typeof generateFromHar>, entries: Entry[]): Promise<string> {
  const server = await listenMock(r.model, r.exchanges, { port: 0 });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const bodies: string[] = [];
  try {
    for (const en of entries) {
      const u = new URL(en.request.url);
      const res = await fetch(base + u.pathname + u.search, {
        method: en.request.method,
        ...(en.request.postData ? { body: en.request.postData.text, headers: { "content-type": en.request.postData.mimeType ?? "application/json" } } : {}),
      });
      bodies.push(await res.text());
    }
  } finally {
    server.close();
  }
  return bodies.join("\n");
}

/** A real MCP session: analyze_har, inspect_endpoint for every id, generate_sdk. */
async function mcpSession(file: string, outDir: string): Promise<string> {
  const server = createMcpServer();
  const client = new Client({ name: "fuzz", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown>) => ((await client.callTool({ name, arguments: args })) as any).content.map((c: any) => c.text).join("\n") as string;
  const out = [await call("analyze_har", { har_path: file })];
  for (const id of [...out[0]!.matchAll(/^\| `([^`]+)` \|/gm)].map((m) => m[1]!)) out.push(await call("inspect_endpoint", { har_path: file, endpoint_id: id }));
  out.push(await call("generate_sdk", { har_path: file, out_dir: outDir }));
  await client.close();
  return out.join("\n");
}

const FROM = Number(process.env.HAR2SDK_FUZZ_FROM ?? 1);
const SEEDS = Number(process.env.HAR2SDK_FUZZ_SEEDS ?? 30);
// Each seed runs the CLI and a real MCP session as child processes: seconds each when the
// whole suite runs in parallel, over vitest's 5 s default on a loaded machine.
const SLOW = { timeout: 60_000 };

describe(`privacy fuzz (${SEEDS} generated captures, random structure)`, () => {
  for (let seed = FROM; seed < FROM + SEEDS; seed++) {
    it(`seed ${seed}: no recorded personal value in any output`, SLOW, async () => {
      const { entries, p, sites } = capture(seed);
      const text = har(entries);
      const r = generateFromHar(text);
      const rx = generateFromHar(text, { examples: true });
      const plan = buildPlan(structuredClone(r.model));
      const outputs: Record<string, string> = {
        "client.ts": r.files["client.ts"]!,
        "openapi.json": r.files["openapi.json"]!,
        "openapi.json --examples": rx.files["openapi.json"]!,
        prompt: renderChatPrompt(plan),
        "render list": renderEndpointList(plan),
        "render detail": plan.ops.map((o) => renderEndpointDetail(plan, o)).join("\n"),
        mock: await mockResponses(r, entries),
      };
      // The real CLI and a real MCP session, on every seed.
      const dir = mkdtempSync(join(tmpdir(), "har2sdk-fuzz-"));
      writeFileSync(join(dir, "c.har"), text);
      outputs["inspect --json"] = execFileSync(process.execPath, [join(ROOT, "dist/cli.js"), "inspect", join(dir, "c.har"), "--json"], { encoding: "utf8" });
      outputs["MCP session"] = await mcpSession(join(dir, "c.har"), join(dir, "out"));
      const leaks = Object.entries(outputs).flatMap(([where, t]) => findLeaks(t, p).map((l) => `${where}: ${l}`));
      expect({ sites, leaks }).toEqual({ sites, leaks: [] });
      // The engine's own guard agrees (it found nothing it would refuse).
      expect(r.leaks).toEqual([]);
      // And the result is still a working SDK.
      expect(r.plan.ops.length).toBeGreaterThan(4);
    });
  }
});

describe(`readable outputs redact what the scanner finds (${SEEDS} generated captures)`, () => {
  for (let seed = FROM; seed < FROM + SEEDS; seed++) {
    it(`seed ${seed}: slugs, host names and encoded forms of a name are redacted where the files are refused`, SLOW, async () => {
      const { entries, p, origin } = capture(seed);
      const r = rng(seed + 1_000_003);
      const name = `${p.first} ${p.last}`;
      const slug = words(name).join(r.pick(["-", "_", "."]));
      const extra = [
        entry({ url: `${origin}/api/${r.pick(["contacts", "people", "customers"])}`, resBody: [{ id: 1, [r.pick(KEYS.fullName)]: name }] }),
        entry({ url: `${origin}/api/${r.pick(["u", "in", "p"])}/${encodeURIComponent(slug)}/${r.pick(KEYS.sub)}`, resBody: { theme: "dark" } }),
        entry({ url: `https://${words(name).join("-")}${r.pick(["", "-uploads", "-files"])}.${r.pick(["s3.amazonaws.com", "myshopify.com", "vercel.app"])}/manifest.json`, resBody: { files: [{ key: "a", size: 1 }] } }),
        entry({ url: `${origin}/api/${r.pick(["notes", "files"])}/${encodeURIComponent(r.pick([name, name.replace(" ", "-")]))}/meta`, resBody: { size: 1 } }),
        // (review 8) The name in a GraphQL comment and in a free-text operationName: what a model sees must not show them.
        entry({ method: "POST", url: `${origin}/graphql`, reqBody: { operationName: `${r.pick(["Load", "Dashboard for", "Ask"])} ${name}`, query: `# ${r.pick(["requested by", "owner:", "for"])} ${name} <${p.email}>\nquery ${r.pick(["Dash", "Feed", "Home"])} { ${r.pick(["dash", "feed", "home"])} { id } }` }, resBody: { data: { dash: { id: 1 } } } }),
      ];
      const text = har(r.shuffle([...entries, ...extra]));
      const g = generateFromHar(text, { allowLeaks: true });
      const plan = buildPlan(structuredClone(g.model));
      const outputs: Record<string, string> = {
        prompt: renderChatPrompt(plan),
        "render list": renderEndpointList(plan),
        "render detail": plan.ops.map((o) => renderEndpointDetail(plan, o)).join("\n"),
      };
      const dir = mkdtempSync(join(tmpdir(), "har2sdk-fuzz-"));
      writeFileSync(join(dir, "c.har"), text);
      outputs["inspect --json"] = execFileSync(process.execPath, [join(ROOT, "dist/cli.js"), "inspect", join(dir, "c.har"), "--json"], { encoding: "utf8" });
      outputs["MCP session"] = await mcpSession(join(dir, "c.har"), join(dir, "out"));
      const leaks = Object.entries(outputs).flatMap(([where, t]) => [...findLeaks(t, p), ...scanText(t, g.model.taint, where).map((f) => f.preview)].map((l) => `${where}: ${l}`));
      expect(leaks).toEqual([]);
    });
  }
});
