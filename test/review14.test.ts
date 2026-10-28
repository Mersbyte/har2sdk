/**
 * Fourteenth review (v0.6.8): an offline source audit by Codex Security, nine findings, each reproduced
 * with the reviewer's input before it was fixed. One describe block per finding.
 *
 * F1/F2: a recorded username of three characters, or of several parts, hidden in a compound path
 *        ("remember_lee", "remember_ece_ak"): the scanner needed four characters or whole parts.
 * F3:    a recorded secret that is also the only key of an object stayed a property, and was written escaped.
 * F4:    a REST body's `extensions` / `query` / `method` keys were skipped as GraphQL or JSON-RPC metadata.
 * F5/F6: cubic time on a property name or URL made of many short pieces.
 * F7:    the mock's superjson `meta.values` paths kept a username the payload keys no longer had.
 * F8:    the mock replayed the recorded Content-Type parameters (profile="…/okilic").
 * F9:    the mock's markup mapper rewrote only quoted attributes.
 */
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { generateFromHar } from "../src/index.js";
import { listenMock } from "../src/mock.js";
import { renderChatPrompt } from "../src/summary.js";
import { entry, har } from "./helpers.js";

const O = "https://api.acme.test";
const SLOW = { timeout: 60_000 };
type Result = ReturnType<typeof generateFromHar>;

const readable = (r: Result): string[] => [r.files["client.ts"]!, r.files["openapi.json"]!, renderChatPrompt(r.plan)];

function rng(seed: number): () => number {
  return () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
}
const CONSONANTS = "bcdfghjklmnpqrstvwxz";
const word = (rnd: () => number, min: number, max: number): string => {
  let w = "";
  for (let i = 0, n = min + Math.floor(rnd() * (max - min + 1)); i < n; i++) w += CONSONANTS[Math.floor(rnd() * CONSONANTS.length)];
  return w;
};

async function mockGet(capture: string, path: string, init?: RequestInit): Promise<{ text: string; type: string | null }> {
  const r = generateFromHar(capture);
  const server = await listenMock(r.model, r.exchanges, { port: 0 });
  try {
    const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${path}`, init);
    return { text: await res.text(), type: res.headers.get("content-type") };
  } finally {
    server.close();
  }
}

/** The login standing alone between non-letters, with any separators between its parts: "remember_ece-ak" has ece_ak. */
const hasLogin = (text: string, login: string): boolean =>
  new RegExp(`(?<![a-z0-9])${login.split(/[._-]/).map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[._+\\-~]*")}(?![a-z0-9])`, "i").test(text);

describe("F1/F2: short and multi-part usernames inside compound paths", () => {
  const compound = (login: string, tail: string) =>
    har([entry({ url: `${O}/api/me`, resBody: { login } }), entry({ url: `${O}/api/preferences/${tail}`, resBody: { enabled: true } })]);

  it("F1: ece_ak in remember_ece_ak is found by the guard and redacted from the prompt", () => {
    const r = generateFromHar(compound("ece_ak", "remember_ece_ak"));
    expect(r.leaks.length).toBeGreaterThan(0);
    const prompt = renderChatPrompt(r.plan);
    expect(prompt).not.toMatch(/ece_ak|ece-ak|eceak/i);
    expect(prompt).not.toContain("EceAk"); // the method and type names built from the path
    expect(r.warnings.join("\n")).toMatch(/Leak guard/i);
  });

  it("F2: lee in remember_lee is found by the guard and redacted from the prompt", () => {
    const r = generateFromHar(compound("lee", "remember_lee"));
    expect(r.leaks.length).toBeGreaterThan(0);
    const prompt = renderChatPrompt(r.plan);
    expect(prompt).not.toMatch(/remember_lee|remember-lee/i);
    expect(prompt).not.toContain("RememberLee");
  });

  it("a longer word that merely contains the name is not a finding", () => {
    const r = generateFromHar(compound("lee", "sleeve_color"));
    expect(r.leaks).toEqual([]);
    expect(renderChatPrompt(r.plan)).toContain("sleeve");
  });

  it("other separators and a prefix or suffix still count: found by the guard, or not written at all", () => {
    for (const tail of ["remember-lee", "lee.settings", "x_lee_y", "lee+tag"]) {
      const r = generateFromHar(compound("lee", tail));
      if (hasLogin(r.files["client.ts"]!, "lee")) expect(r.leaks.length, tail).toBeGreaterThan(0);
      expect(hasLogin(renderChatPrompt(r.plan), "lee"), tail).toBe(false);
    }
  });

  it("generated: 300 logins of 3 to 6 letters (one or two parts), hidden in a compound path: found by the guard or generalised, never in the prompt", () => {
    const rnd = rng(14);
    for (let i = 0; i < 300; i++) {
      const parts = rnd() < 0.5 ? [word(rnd, 3, 6)] : [word(rnd, 2, 3), word(rnd, 2, 3)];
      const login = parts.join("_");
      const tail = `${word(rnd, 5, 8)}_${parts.join(rnd() < 0.5 ? "_" : "-")}`;
      const r = generateFromHar(compound(login, tail));
      // Where the path stays literal the guard must see it (the CLI then writes nothing); the prompt never has it.
      if (hasLogin(r.files["client.ts"]!, login) || hasLogin(r.files["openapi.json"]!, login)) expect(r.leaks.length, `${login} in ${tail}`).toBeGreaterThan(0);
      expect(hasLogin(renderChatPrompt(r.plan), login), `${login} in ${tail}`).toBe(false);
    }
  });
});

describe("F3: a recorded secret that is the only key of an object", () => {
  const secret = 'synthetic"secret';
  const capture = (s: string) => har([entry({ url: `${O}/api/x`, resBody: { token: s, catalog: { [s]: true } } })]);

  it("is not a property of client.ts, openapi.json or the prompt, escaped or not", () => {
    const r = generateFromHar(capture(secret));
    for (const t of readable(r)) expect(t).not.toMatch(/synthetic\\?"secret/);
    expect(r.files["client.ts"]).toMatch(/Record<string, /);
  });

  it("the mock serves a fake key", async () => {
    const { text } = await mockGet(capture(secret), "/api/x");
    expect(text).not.toContain("synthetic");
  });

  it("the scanner finds a secret written escaped", () => {
    const r = generateFromHar(capture(secret), { enums: false });
    expect(r.leaks).toEqual([]); // generalised, so nothing to find
  });

  it("an object whose only key merely shares a word with a recorded name keeps its property", () => {
    const r = generateFromHar(har([entry({ url: `${O}/api/t`, resBody: [{ id: 1, firstName: "Status", email: "t@x.io" }] }), entry({ url: `${O}/api/x`, resBody: { catalog: { status: "ok" } } })]));
    expect(r.files["client.ts"]).toMatch(/status: string;/);
  });

  it("generated: 150 secrets with quotes, backslashes and slashes never reach a readable output", () => {
    const rnd = rng(31);
    const specials = ['"', "\\", "/", "'", "$", "\n"];
    for (let i = 0; i < 150; i++) {
      const s = `${word(rnd, 4, 6)}${specials[Math.floor(rnd() * specials.length)]}${word(rnd, 4, 6)}`;
      const r = generateFromHar(capture(s));
      const escaped = JSON.stringify(s).slice(1, -1);
      for (const t of readable(r)) {
        expect(t, JSON.stringify(s)).not.toContain(s);
        expect(t, JSON.stringify(s)).not.toContain(escaped);
      }
    }
  });
});

describe("F4: REST bodies with extensions, query and method keys", () => {
  const withRoute = (body: unknown, login = "okilic") =>
    har([entry({ url: `${O}/api/me`, resBody: body }), entry({ url: `${O}/api/people/${login}/settings`, resBody: { theme: "dark" } })]);

  it("extensions.username is evidence like any other field", () => {
    const r = generateFromHar(withRoute({ extensions: { username: "okilic" } }));
    for (const t of readable(r)) expect(t).not.toContain("okilic");
  });

  it("a REST search term under `query` is evidence", () => {
    const r = generateFromHar(har([entry({ method: "POST", url: `${O}/api/search`, reqBody: { query: "okilic" }, resBody: { login: "okilic" } }), entry({ url: `${O}/api/people/okilic/settings`, resBody: { theme: "dark" } })]));
    for (const t of readable(r)) expect(t).not.toContain("okilic");
  });

  it("a REST `method` field is evidence unless the body is a JSON-RPC envelope", () => {
    const r = generateFromHar(withRoute({ method: { username: "okilic" } }));
    for (const t of readable(r)) expect(t).not.toContain("okilic");
  });

  it("a GraphQL request's extensions (persisted query hash) are still structure", () => {
    const hash = "ecf4edb46db40b5132295c0291d62fb65d6759a9eedfa4d5d612dd5ec54a6b38";
    const r = generateFromHar(
      har([entry({ method: "POST", url: `${O}/graphql`, reqBody: { operationName: "Me", variables: {}, extensions: { persistedQuery: { version: 1, sha256Hash: hash } } }, resBody: { data: { me: { id: "u1" } } } })]),
    );
    expect(r.leaks).toEqual([]);
  });

  it("generated: 200 usernames under extensions, later echoed in a path, never reach a readable output", () => {
    const rnd = rng(77);
    for (let i = 0; i < 200; i++) {
      const login = word(rnd, 5, 9);
      const r = generateFromHar(withRoute({ extensions: { username: login } }, login));
      for (const t of readable(r)) expect(t, login).not.toContain(login);
    }
  });
});

describe("F5/F6: pieces in a long name cost linear time", () => {
  const N = 4000;
  const long = "a_".repeat(N) + "a";

  it("F5: a property named a_a_a_… (prompt rendering)", SLOW, () => {
    const r = generateFromHar(har([entry({ url: `${O}/api/p`, resBody: { fullName: "Zeynep Kaya", ZeynepKayaMarker: 1, [long]: 1 } })]));
    const t0 = performance.now();
    renderChatPrompt(r.plan);
    expect(performance.now() - t0).toBeLessThan(2_000);
  });

  it("F6: a URL whose file name is a_a_a_… (analysis and generation)", SLOW, () => {
    const t0 = performance.now();
    generateFromHar(har([entry({ url: `${O}/api/p`, resBody: { fullName: "Zeynep Kaya", img: `https://cdn.example.test/${long}` } })]));
    expect(performance.now() - t0).toBeLessThan(4_000);
  });

  it("an alias in a long compound is still redacted, and only where it stands", () => {
    const r = generateFromHar(har([entry({ url: `${O}/api/p`, resBody: { fullName: "Zeynep Kaya", email: "zeynep.kaya@acme.test", ["x_" + "a_".repeat(50) + "zeynep_kaya_" + "b_".repeat(50) + "b"]: 1 } })]));
    const t = renderChatPrompt(r.plan).toLowerCase();
    expect(t).not.toContain("zeynep_kaya");
    expect(t).toContain("a_a_a_a");
  });
});

describe("F7: the mock's superjson meta paths", () => {
  it("do not keep a username the payload keys no longer have", async () => {
    const me = entry({ url: `${O}/trpc/me.get`, resBody: { result: { data: { json: { login: "okilic" } } } } });
    const stats = entry({ url: `${O}/trpc/stats.get`, resBody: { result: { data: { json: { okilic: { since: "2026-01-01T00:00:00.000Z" } }, meta: { values: { "okilic.since": ["Date"] } } } } } });
    const { text } = await mockGet(har([me, stats]), "/trpc/stats.get");
    expect(text).not.toContain("okilic");
    const body = JSON.parse(text).result.data;
    const key = Object.keys(body.json)[0]!;
    expect(Object.keys(body.meta.values)).toEqual([`${key}.since`]); // the path still points at the member
  });
});

describe("F8: the mock's Content-Type", () => {
  it("replays the media type and its charset, not other parameters", async () => {
    const capture = har([
      entry({ url: `${O}/api/me`, resBody: { login: "okilic" } }),
      entry({ url: `${O}/api/doc`, resBody: { a: 1 }, resMime: 'application/json; charset=utf-8; profile="https://profiles.example.test/okilic"' }),
    ]);
    const { type } = await mockGet(capture, "/api/doc");
    expect(type).toBe("application/json; charset=utf-8");
  });
});

describe("F9: the mock's markup, unquoted attributes", () => {
  it("are scrubbed like quoted ones", async () => {
    const capture = har([
      entry({ url: `${O}/api/me`, resBody: { login: "okilic" } }),
      entry({ method: "POST", url: `${O}/api/fragment`, reqBody: { a: 1 }, resText: "<input name=username value=okilic><div data-username=okilic></div>", resMime: "text/html" }),
    ]);
    const { text } = await mockGet(capture, "/api/fragment", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(text).not.toContain("okilic");
    expect(text).toMatch(/^<input name="[^"]+" value="[^"]+"><div data-username="[^"]+"><\/div>$/);
  });

  it("generated: 100 usernames in unquoted, single- and double-quoted attributes never reach the mock", async () => {
    const rnd = rng(5);
    for (let i = 0; i < 100; i++) {
      const login = word(rnd, 5, 9);
      const q = ["", '"', "'"][Math.floor(rnd() * 3)]!;
      const capture = har([
        entry({ url: `${O}/api/me`, resBody: { login } }),
        entry({ method: "POST", url: `${O}/api/fragment`, reqBody: { a: 1 }, resText: `<a data-user=${q}${login}${q} title=${q}${login}${q}>x</a>`, resMime: "text/html" }),
      ]);
      const { text } = await mockGet(capture, "/api/fragment", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      expect(text, login).not.toContain(login);
    }
  });
});
