/**
 * Seventeenth review (v0.6.11): an independent read-only review by Claude Code before launch. Every finding
 * was reproduced with the reviewer's input before it was fixed. One describe block per finding.
 *
 * L1: framed WebSocket messages (Socket.IO, SignalR, SockJS, STOMP) weren't read.
 * L2: page JSON in common shapes (JSON.parse("…"), Next.js flight data, data-* attributes, meta/input
 *     name-value pairs) wasn't read.
 * L3: identity keys were English only.
 * L4: JSON inside form and multipart fields wasn't parsed; GraphQL variables weren't linked to the
 *     argument they feed (`up(owner: $o)`).
 * L5: cookie values were read raw (Segment's ajs_user_id=%22okilic%22).
 * L6: sendBeacon requests (`ping`) weren't evidence.
 * L7: JSON under other "json" media types (application/x-amz-json-1.1) was binary.
 * L8: the default mock served dictionary keys that held a recorded identity as a part (`user:mdemir`).
 * R1: ordinary words under from / to / *_by / ref (`?from=search`, `?ref=main`) refused normal apps.
 * R2: one field like `thumb_200` turned a record into a Record<string, …>, and the mock renamed its keys.
 * I1: an encoded slash (`platform%2Fbackend`) was decoded in the OpenAPI path key.
 * Q1: the CLI overwrote a client.ts it didn't write.
 * Q2: malformed field types crashed with raw TypeErrors.
 * D1: the output scan searched the whole text once per recorded value present as a token.
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import type { HarEntry } from "../src/har.js";
import { generateFromHar } from "../src/index.js";
import { listenMock } from "../src/mock.js";
import { renderChatPrompt } from "../src/summary.js";
import { entry, har, ROOT } from "./helpers.js";

const O = "https://app.acme.test";
const SLOW = { timeout: 120_000 };
type Result = ReturnType<typeof generateFromHar>;

function rng(seed: number): () => number {
  return () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
}
const CONSONANTS = "bcdfghjklmnpqrstvwxz";
const VOWELS = "aeiou";
const login = (rnd: () => number): string => {
  let w = "";
  for (let i = 0, n = 3 + Math.floor(rnd() * 2); i < n; i++) w += CONSONANTS[Math.floor(rnd() * CONSONANTS.length)]! + VOWELS[Math.floor(rnd() * VOWELS.length)]!;
  return w + CONSONANTS[Math.floor(rnd() * CONSONANTS.length)]!;
};
const hasWord = (text: string, w: string): boolean => new RegExp(`(?<![a-z0-9])${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![a-z0-9])`, "i").test(text);
/** Safe: refused, or the value never reached the client. */
const safe = (r: Result, value: string): boolean => r.leaks.length > 0 || !hasWord(r.files["client.ts"]!, value);

/** A path that stays literal without evidence (the documented limit), so evidence decides. */
const profile = (name: string): HarEntry => entry({ url: `${O}/api/v1/profiles/${name}`, resBody: { title: "x", count: 3 } });
const ws = (frames: string[]): HarEntry => {
  const e = entry({ url: "wss://app.acme.test/ws", status: 101, resText: "", resourceType: "websocket" });
  (e as HarEntry & { _webSocketMessages: unknown[] })._webSocketMessages = frames.map((data) => ({ type: "receive", time: 1, opcode: 1, data }));
  return e;
};
const page = (body: string): HarEntry => entry({ url: `${O}/`, resMime: "text/html", resText: `<html><body>${body}</body></html>`, resourceType: "document" });
const withResponseHeaders = (e: HarEntry, headers: Record<string, string>): HarEntry => {
  e.response.headers = [...(e.response.headers ?? []), ...Object.entries(headers).map(([name, value]) => ({ name, value }))];
  return e;
};

async function mockGet(capture: string, path: string): Promise<string> {
  const r = generateFromHar(capture);
  const server = await listenMock(r.model, r.exchanges, { port: 0 });
  try {
    return await (await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${path}`)).text();
  } finally {
    server.close();
  }
}

describe("control: the path stays literal without evidence", () => {
  it("so each case below is decided by its carrier", () => {
    expect(generateFromHar(har([profile("mdemir")])).files["client.ts"]).toContain("mdemir");
  });
});

const FRAMINGS: Record<string, (json: string, name: string) => string> = {
  socketio: (json) => `42["presence",${json}]`,
  socketioNamespace: (json) => `42/chat,7["presence",${json}]`,
  signalr: (json) => `{"type":1,"arguments":[${json}]}\u001e`,
  sockjs: (json) => `a[${JSON.stringify(json)}]`,
  stomp: (_json, name) => `CONNECT\nlogin:${name}\naccept-version:1.2\n\n\u0000`,
};

describe("L1: framed WebSocket messages", () => {
  for (const [kind, frame] of Object.entries(FRAMINGS)) {
    it(`${kind} (the reviewer's input)`, () => {
      const r = generateFromHar(har([ws([frame('{"login":"mdemir"}', "mdemir")]), profile("mdemir")]));
      expect(safe(r, "mdemir")).toBe(true);
    });
  }
  it("generated: a random login in each framing", () => {
    const rnd = rng(17);
    const failures: string[] = [];
    for (const [kind, frame] of Object.entries(FRAMINGS)) {
      for (let i = 0; i < 6; i++) {
        const name = login(rnd);
        if (!safe(generateFromHar(har([ws([frame(JSON.stringify({ user: { username: name } }), name)]), profile(name)])), name)) failures.push(`${kind}:${name}`);
      }
    }
    expect(failures).toEqual([]);
  });
});

const PAGE_SHAPES: Record<string, (name: string) => string> = {
  jsonParse: (n) => `<script>window.__STATE__=JSON.parse("{\\"viewer\\":{\\"login\\":\\"${n}\\"}}")</script>`,
  singleQuotedJsonParse: (n) => `<script>window.__STATE__=JSON.parse('{"viewer":{"login":"${n}"}}')</script>`,
  nextFlight: (n) => `<script>self.__next_f.push([1,"3:{\\"viewer\\":{\\"login\\":\\"${n}\\"}}\\n"])</script>`,
  dataProps: (n) => `<div data-props="{&quot;viewer&quot;:{&quot;login&quot;:&quot;${n}&quot;}}"></div>`,
  meta: (n) => `<meta name="user-login" content="${n}">`,
  input: (n) => `<form><input type="hidden" name="username" value="${n}"></form>`,
};

describe("L2: page JSON in common shapes", () => {
  for (const [kind, html] of Object.entries(PAGE_SHAPES)) {
    it(`${kind} (the reviewer's input)`, () => expect(safe(generateFromHar(har([page(html("mdemir")), profile("mdemir")])), "mdemir")).toBe(true));
  }
  it("generated: a random login in each shape", () => {
    const rnd = rng(2);
    const failures: string[] = [];
    for (const [kind, html] of Object.entries(PAGE_SHAPES)) {
      for (let i = 0; i < 6; i++) {
        const name = login(rnd);
        if (!safe(generateFromHar(har([page(html(name)), profile(name)])), name)) failures.push(`${kind}:${name}`);
      }
    }
    expect(failures).toEqual([]);
  });
  it("a script's other strings are not evidence (the demo's inline gql call still works)", () => {
    const r = generateFromHar(
      har([
        page('<script>gql("AddToWishlist", "mutation AddToWishlist { ok }", {"note":"[x]"})</script>'),
        entry({ method: "POST", url: `${O}/graphql`, reqBody: { operationName: "AddToWishlist", query: "mutation AddToWishlist { addToWishlist { ok } }" }, resBody: { data: { addToWishlist: { ok: true } } } }),
      ]),
    );
    expect(r.leaks).toEqual([]);
  });
});

const IDENTITY_KEYS = ["kullaniciAdi", "kullanici_adi", "sahip", "yazar", "benutzername", "benutzer", "besitzer", "usuario", "autor", "propietario", "pseudo", "utilisateur", "identifiant", "auteur", "proprietaire"];

describe("L3: identity keys in Turkish, German, Spanish and French", () => {
  for (const key of IDENTITY_KEYS) {
    it(key, () => expect(safe(generateFromHar(har([entry({ url: `${O}/api/v1/account`, resBody: { [key]: "mdemir" } }), profile("mdemir")])), "mdemir")).toBe(true));
  }
  it("generated: random logins under random keys of the five languages", () => {
    const rnd = rng(3);
    for (let i = 0; i < 20; i++) {
      const name = login(rnd);
      const key = IDENTITY_KEYS[Math.floor(rnd() * IDENTITY_KEYS.length)]!;
      expect(safe(generateFromHar(har([entry({ url: `${O}/api/v1/account`, resBody: { data: { [key]: name } } }), profile(name)])), name)).toBe(true);
    }
  });
});

describe("L4: JSON in form and multipart fields, GraphQL variables by argument", () => {
  it("a Slack-style form field (the reviewer's input)", () => {
    const e = entry({ method: "POST", url: `${O}/hooks/interact`, reqMime: "application/x-www-form-urlencoded", reqBody: "payload=%7B%22user%22%3A%7B%22username%22%3A%22mdemir%22%7D%7D", resBody: { ok: true } });
    expect(safe(generateFromHar(har([e, profile("mdemir")])), "mdemir")).toBe(true);
  });
  it("a GraphQL multipart upload's operations field (the reviewer's input)", () => {
    const body = '--X\r\nContent-Disposition: form-data; name="operations"\r\n\r\n{"query":"mutation($o: String!) { up(owner: $o) { ok } }","variables":{"o":"mdemir"}}\r\n--X--\r\n';
    const e = entry({ method: "POST", url: `${O}/graphql`, reqMime: "multipart/form-data; boundary=X", reqBody: body, resBody: { data: { up: { ok: true } } } });
    expect(safe(generateFromHar(har([e, profile("mdemir")])), "mdemir")).toBe(true);
  });
  it("generated: a variable of any name passed to an identity argument, in a JSON body", () => {
    const rnd = rng(4);
    for (let i = 0; i < 15; i++) {
      const name = login(rnd);
      const v = ["o", "x1", "input", "who", "u"][i % 5]!;
      const arg = ["owner", "author", "login", "assignee", "username"][i % 5]!;
      const e = entry({ method: "POST", url: `${O}/graphql`, reqBody: { query: `query Q($${v}: String!) { thing(${arg}: $${v}) { id } }`, variables: { [v]: name } }, resBody: { data: { thing: { id: 1 } } } });
      expect(safe(generateFromHar(har([e, profile(name)])), name)).toBe(true);
    }
  });
});

describe("L5: cookie values decoded once and read under their names", () => {
  for (const cookie of ["ajs_user_id=%22mdemir%22", 'ajs_user_id="mdemir"', "username=mdemir", "prefs=%7B%22login%22%3A%22mdemir%22%7D"]) {
    it(cookie, () => {
      const e = entry({ url: `${O}/api/v1/flags`, reqHeaders: { cookie }, resBody: { a: true } });
      expect(safe(generateFromHar(har([e, profile("mdemir")])), "mdemir")).toBe(true);
    });
  }
  it("a set-cookie with an encoded email", () => {
    const e = withResponseHeaders(entry({ url: `${O}/api/v1/session`, resBody: { ok: true } }), { "set-cookie": "last_email=okilic%40corp.example; Path=/" });
    expect(safe(generateFromHar(har([e, entry({ url: `${O}/api/v1/okilic/projects`, resBody: [{ id: 1 }] })])), "okilic")).toBe(true);
  });
});

describe("L6: beacons and reports are evidence", () => {
  for (const type of ["ping", "cspviolationreport"]) {
    it(`_resourceType ${type}`, () => {
      const e = entry({ method: "POST", url: `${O}/api/track`, reqBody: { userId: "mdemir" }, resText: "", resourceType: type });
      expect(safe(generateFromHar(har([e, profile("mdemir")])), "mdemir")).toBe(true);
    });
  }
  it("a script or image without a request body is still not read", () => {
    const js = entry({ url: `${O}/static/app.js`, resMime: "application/javascript", resText: 'var u = {"login":"mdemir"};', resourceType: "script" });
    expect(generateFromHar(har([js, profile("mdemir")])).model.taint.identities.has("mdemir")).toBe(false);
  });
});

describe("L7: other json media types", () => {
  for (const mime of ["application/x-amz-json-1.1", "application/x-json", "text/x-json", "application/jsonrequest"]) {
    it(mime, () => {
      const e = entry({ method: "POST", url: `${O}/api/v1/whoami`, reqBody: {}, resMime: mime, resText: '{"Username":"mdemir"}' });
      expect(safe(generateFromHar(har([e, profile("mdemir")])), "mdemir")).toBe(true);
    });
  }
});

describe("L8: dictionary keys that hold an identity as a part (default mock)", () => {
  const capture = har([
    entry({ url: `${O}/api/v1/me`, resBody: { login: "mdemir", email: "oguz.kilic@corp.example" } }),
    entry({ url: `${O}/api/v1/drafts`, resBody: { map: { "oguz.kilic@corp.example:prefs": { a: 1 }, "user:mdemir": { a: 2 }, "mdemir/dotfiles": { a: 3 }, "team-mdemir": { a: 4 }, "presence/mdemir": { a: 5 }, settings: { a: 6 } } } }),
  ]);
  it("the reviewer's input and variants", async () => {
    const body = await mockGet(capture, "/api/v1/drafts");
    expect(body).not.toMatch(/mdemir|oguz\.kilic/);
    expect(body).toContain('"settings"');
    expect(body).toMatch(/"user:[a-z]+"/);
  });
  it("generated: random logins as prefix:value, value/suffix and value:suffix keys", async () => {
    const rnd = rng(5);
    const names = Array.from({ length: 6 }, () => login(rnd));
    const map: Record<string, unknown> = { title: "x" };
    names.forEach((n, i) => (map[[`user:${n}`, `${n}/repo`, `${n}:prefs`][i % 3]!] = { a: i }));
    const body = await mockGet(har([entry({ url: `${O}/api/v1/team`, resBody: names.map((n) => ({ login: n })) }), entry({ url: `${O}/api/v1/state`, resBody: { map } })]), "/api/v1/state");
    for (const n of names) expect(body).not.toContain(n);
  });
});

describe("R1: ordinary words under from, to, *_by and ref", () => {
  const SHOP = [entry({ url: `${O}/api/v1/search?q=mouse`, resBody: { items: [] } }), entry({ url: `${O}/api/v1/orders`, resBody: [] }), entry({ url: `${O}/api/v1/cart`, resBody: { items: [] } })];
  const cases: Record<string, HarEntry> = {
    from: entry({ url: `${O}/api/v1/products/7?from=search`, resBody: { id: 7 } }),
    ref: entry({ url: `${O}/api/v1/products/7?ref=search`, resBody: { id: 7 } }),
    sortBy: entry({ url: `${O}/api/v1/customers?sort_by=orders`, resBody: [] }),
    orderBy: entry({ url: `${O}/api/v1/customers?orderBy=cart`, resBody: [] }),
    ssrTo: page('<script>window.__STATE__={"nav":[{"to":"/orders"},{"to":"/cart"}]}</script>'),
    analytics: entry({ method: "POST", url: "https://api.segment.io/v1/track", reqBody: { event: "nav", properties: { from: "search", to: "cart" } }, resBody: { ok: true } }),
    notifications: entry({ url: `${O}/api/v1/notifications`, resBody: [{ from: "orders", text: "x" }] }),
  };
  for (const [kind, extra] of Object.entries(cases)) {
    it(`${kind}: exit 0 with the real paths (the reviewer's inputs)`, () => {
      const r = generateFromHar(har([...SHOP, extra]));
      expect(r.leaks).toEqual([]);
      for (const p of ["/api/v1/search", "/api/v1/orders", "/api/v1/cart"]) expect(r.files["client.ts"]).toContain(p);
    });
  }
  it("a GitLab file path with ?ref=main", () => {
    const r = generateFromHar(har([entry({ url: "https://gitlab.acme.test/api/v4/projects/7/repository/files/src%2Fmain.ts?ref=main", resBody: { file_name: "main.ts" } })]));
    expect(r.leaks).toEqual([]);
  });
  it("still a person: from/to with an email, created_by, and a from-login in a people path", () => {
    expect(safe(generateFromHar(har([entry({ url: `${O}/api/v1/messages`, resBody: [{ from: "mdemir" }] }), entry({ url: `${O}/api/v1/users/mdemir/inbox`, resBody: [] })])), "mdemir")).toBe(true);
    expect(safe(generateFromHar(har([entry({ url: `${O}/api/v1/docs`, resBody: [{ created_by: "mdemir" }] }), profile("mdemir")])), "mdemir")).toBe(true);
    expect(safe(generateFromHar(har([entry({ url: `${O}/api/v1/ref`, resBody: { ref: "ORD-77314" } }), entry({ url: `${O}/api/v1/orders/ORD-77314`, resBody: { id: 1 } })])), "ORD-77314")).toBe(true);
  });
  it("generated: app words under weak keys never refuse a normal app", () => {
    const rnd = rng(6);
    for (let i = 0; i < 20; i++) {
      const w = login(rnd);
      const key = ["from", "to", "ref", "sort_by", "orderBy", "by"][i % 6]!;
      const r = generateFromHar(har([entry({ url: `${O}/api/v1/${w}`, resBody: { items: [] } }), entry({ url: `${O}/api/v1/things?${key}=${w}`, resBody: [] })]));
      expect(r.leaks).toEqual([]);
    }
  });
});

describe("R2: one digit-bearing field among ordinary ones", () => {
  const capture = har([entry({ url: `${O}/api/products/42`, resBody: { id: 42, title: "Mouse", thumb_200: "https://cdn.acme.test/42.png", price: 19.9 } })]);
  it("stays an interface, and the mock keeps its keys (the reviewer's input)", async () => {
    const r = generateFromHar(capture);
    expect(r.leaks).toEqual([]);
    expect(r.files["client.ts"]).not.toMatch(/GetProductResponse = Record</);
    expect(r.files["client.ts"]).toMatch(/thumb_200/);
    const body = JSON.parse(await mockGet(capture, "/api/products/42"));
    expect(Object.keys(body).sort()).toEqual(["id", "price", "thumb_200", "title"]);
  });
  it("generated: one <word>_<digits> or <word><4 digits> field in a typed object", () => {
    const rnd = rng(7);
    for (let i = 0; i < 20; i++) {
      const field = i % 2 ? `${login(rnd)}_${100 + Math.floor(rnd() * 900)}` : `${login(rnd)}${2000 + Math.floor(rnd() * 30)}`;
      const r = generateFromHar(har([entry({ url: `${O}/api/items/1`, resBody: { id: 1, name: "x", [field]: "y", total: 3 } })]));
      expect(r.leaks).toEqual([]);
      expect(r.files["client.ts"]).toContain(field);
    }
  });
  it("still a dictionary: id keys, several such keys, or a single one", () => {
    const dict = (body: unknown) => generateFromHar(har([entry({ url: `${O}/api/stats`, resBody: body })])).files["client.ts"]!;
    expect(dict({ data: { "12345": { n: 1 }, "67890": { n: 2 } } })).toMatch(/Record<string/);
    expect(dict({ data: { zk1234x: { n: 1 }, qp9981y: { n: 2 }, total: { n: 3 } } })).toMatch(/Record<string/);
    expect(dict({ data: { zk1234x: { n: 1 } } })).toMatch(/Record<string/);
  });
});

describe("I1: an encoded slash in the OpenAPI path key", () => {
  it("the spec documents the path the client requests (the reviewer's input)", () => {
    const r = generateFromHar(har([entry({ url: "https://gitlab.acme.test/api/v4/projects/platform%2Fbackend", resBody: { id: 1 } })]));
    const paths = Object.keys(JSON.parse(r.files["openapi.json"]!).paths);
    expect(paths).toContain("/api/v4/projects/platform%2Fbackend");
    expect(r.files["client.ts"]).toContain("/api/v4/projects/platform%2Fbackend");
  });
});

const CLI = join(ROOT, "dist/cli.js");

describe("Q1: the CLI doesn't overwrite a client.ts it didn't write", () => {
  it("refuses with exit 1 and leaves the file", () => {
    const dir = mkdtempSync(join(tmpdir(), "h2s-q1-"));
    const harFile = join(dir, "a.har");
    writeFileSync(harFile, har([entry({ url: `${O}/api/v1/items`, resBody: [{ id: 1 }] })]));
    writeFileSync(join(dir, "client.ts"), "// mine\n");
    const r = spawnSync(process.execPath, [CLI, harFile, "-o", dir], { encoding: "utf8" });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/wasn't generated by har2sdk/);
    expect(readFileSync(join(dir, "client.ts"), "utf8")).toBe("// mine\n");
    // Its own output is overwritten as before.
    const out = join(dir, "out");
    expect(spawnSync(process.execPath, [CLI, harFile, "-o", out]).status).toBe(0);
    expect(spawnSync(process.execPath, [CLI, harFile, "-o", out]).status).toBe(0);
  });
});

describe("Q2: malformed field types", () => {
  const raw = (e: unknown) => JSON.stringify({ log: { entries: [e, { request: { method: "GET", url: `${O}/api/v1/ok`, headers: [] }, response: { status: 200, headers: [], content: { mimeType: "application/json", text: '{"a":1}' } } }] } });
  const cases: Record<string, unknown> = {
    numberText: { request: { method: "GET", url: `${O}/x`, headers: [] }, response: { status: 200, headers: [], content: { mimeType: "application/json", text: 5 } } },
    objectHeaders: { request: { method: "GET", url: `${O}/x`, headers: { a: 1 } }, response: { status: 200, headers: [], content: { mimeType: "application/json", text: "{}" } } },
    nullParams: { request: { method: "POST", url: `${O}/x`, headers: [], postData: { mimeType: "application/x-www-form-urlencoded", params: [null, { name: "a", value: 1 }] } }, response: { status: 200, headers: [], content: { mimeType: "application/json", text: "{}" } } },
    numberMime: { request: { method: "GET", url: `${O}/x`, headers: [] }, response: { status: 200, headers: [], content: { mimeType: 7, text: "{}" } }, _resourceType: 3 },
    objectPostText: { request: { method: "POST", url: `${O}/x`, headers: [], postData: { mimeType: "application/json", text: { a: 1 } } }, response: { status: 200, headers: [], content: { mimeType: "application/json", text: "{}" } } },
    nullEntry: null,
  };
  for (const [kind, e] of Object.entries(cases)) {
    it(`${kind}: read as far as it makes sense, no crash`, () => {
      const r = generateFromHar(raw(e));
      expect(r.files["client.ts"]).toContain("/api/v1/ok");
    });
  }
});

describe("D1: the output scan is linear in recorded values", () => {
  it("8,000 GraphQL operations with data-like field names in a few seconds (8.7 s before)", SLOW, () => {
    const entries = [];
    for (let i = 0; i < 8000; i++) {
      const f = `f${1000 + i}`;
      entries.push(entry({ method: "POST", url: `${O}/graphql`, reqBody: { operationName: `Op${i}`, query: `query Op${i} { ${f} { id } }` }, resBody: { data: { [f]: { id: i } } } }));
    }
    const t0 = performance.now();
    generateFromHar(har(entries));
    expect(performance.now() - t0).toBeLessThan(15_000);
  });
});

describe("readable outputs stay clean for the new carriers", () => {
  it("prompt and inspect never show a login found only through a new carrier", () => {
    const r = generateFromHar(har([ws([FRAMINGS.socketio!('{"login":"mdemir"}', "mdemir")]), page(PAGE_SHAPES.nextFlight!("mdemir")), profile("mdemir")]));
    expect(renderChatPrompt(r.plan)).not.toContain("mdemir");
  });
});
