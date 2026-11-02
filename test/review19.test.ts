/**
 * Nineteenth review (v0.6.14): an end-to-end review before launch. Nine findings, each reproduced with the
 * reviewer's input before it was fixed. One describe block per finding.
 *
 * H1: the token, API key, cookie, `headers` and recorded default headers went to every origin in the capture,
 *     third parties included (thirdparty.example.net), and `baseUrl` didn't move those calls.
 * H2: a trailing slash was dropped (`/api/users/` → `/api/users`): Django-style servers redirect or 404.
 * H3: `ApiError.message` held the full URL, API-key query parameter included.
 * H4: the MCP server silently replaced a corrupt `har2sdk.annotations.json`.
 * H5: a hand-written client.ts that mentions "har2sdk" was overwritten.
 * H6: a JSON body was always sent as `application/json`, never the API's own type (`application/vnd.api+json`).
 * H7: a repeated form field (`tag=a&tag=b`) was typed `string`, and an array was sent as `tag=a,b`.
 * H8: an email inside an error sentence wasn't evidence: `/profile/mehmet.yilmaz` became `getMehmetYilmaz()`.
 * H9: package.json claimed npm provenance that no release has.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateFromHar, writtenByHar2sdk } from "../src/index.js";
import { createMcpServer } from "../src/mcp.js";
import { ROOT, entry, har } from "./helpers.js";

const O = "https://app.acme.test";
const THIRD = "https://thirdparty.example.net";
const TOKEN = "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJlLXNpZ25hdHVyZQ";
const CLI = join(ROOT, "dist/cli.js");
const SLOW = { timeout: 120_000 };

function rng(seed: number): () => number {
  return () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
}
const CONSONANTS = "bcdfghjklmnpqrstvwxz";
const VOWELS = "aeiou";
const word = (rnd: () => number, syllables = 3): string => {
  let w = "";
  for (let i = 0; i < syllables; i++) w += CONSONANTS[Math.floor(rnd() * CONSONANTS.length)]! + VOWELS[Math.floor(rnd() * VOWELS.length)]!;
  return w;
};

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "har2sdk-r19-"));
}

async function load(code: string): Promise<any> {
  const dir = tmp();
  writeFileSync(join(dir, "client.ts"), code);
  return import(pathToFileURL(join(dir, "client.ts")).href);
}

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}
function recorder(status = 200, body: unknown = {}) {
  const calls: Call[] = [];
  const fetch = async (url: URL, init: RequestInit) => {
    calls.push({ url: String(url), method: String(init.method), headers: { ...(init.headers as Record<string, string>) }, body: init.body });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  };
  return { calls, fetch };
}

function generate(capture: string) {
  const r = generateFromHar(capture);
  expect(r.leaks).toEqual([]);
  return r;
}

// ── H1 ─────────────────────────────────────────────────────────────────────────

describe("H1 credentials and app headers go only to baseUrl's origin (and trustedOrigins)", () => {
  const auth = { authorization: TOKEN, "x-app-version": "3.4.1" };
  const capture = (third: string) =>
    har([
      entry({ url: `${O}/api/v1/items`, reqHeaders: auth, resBody: [{ id: 1, price: 2 }] }),
      entry({ url: `${O}/api/v1/orders`, reqHeaders: auth, resBody: [{ id: 2, total: 5 }] }),
      entry({ url: `${third}/v1/rates`, reqHeaders: auth, resBody: { usd: 1 } }),
    ]);

  it("the reviewer's capture: the third party gets no token, no default header, no `headers`", async () => {
    const r = generate(capture(THIRD));
    const mod = await load(r.files["client.ts"]!);
    const { calls, fetch } = recorder();
    const client = new mod[r.plan.clientName]({ token: "secret-1", headers: { "x-tenant": "t1" }, fetch });
    await client.listItems();
    await client.listRates();
    const own = calls.find((c) => c.url.startsWith(O))!;
    const third = calls.find((c) => c.url.startsWith(THIRD))!;
    expect(own.headers.authorization).toBe("Bearer secret-1");
    expect(own.headers["x-tenant"]).toBe("t1");
    expect(own.headers["x-app-version"]).toBe("3.4.1");
    expect(third.headers.authorization).toBeUndefined();
    expect(third.headers["x-tenant"]).toBeUndefined();
    expect(third.headers["x-app-version"]).toBeUndefined();
  });

  it("opting in with trustedOrigins, or pointing the origin at baseUrl, sends them", async () => {
    const r = generate(capture(THIRD));
    const mod = await load(r.files["client.ts"]!);
    const a = recorder();
    await new mod[r.plan.clientName]({ token: "s", fetch: a.fetch, trustedOrigins: [THIRD] }).listRates();
    expect(a.calls[0]!.headers.authorization).toBe("Bearer s");
    const b = recorder();
    await new mod[r.plan.clientName]({ token: "s", fetch: b.fetch, baseUrl: "http://localhost:9", origins: { [THIRD]: "http://localhost:9" } }).listRates();
    expect(b.calls[0]!.url).toBe("http://localhost:9/v1/rates");
    expect(b.calls[0]!.headers.authorization).toBe("Bearer s");
  });

  it("per-call options.headers are always sent: the caller chose them", async () => {
    const r = generate(capture(THIRD));
    const mod = await load(r.files["client.ts"]!);
    const { calls, fetch } = recorder();
    await new mod[r.plan.clientName]({ fetch }).listRates({ headers: { "x-explicit": "1" } });
    expect(calls[0]!.headers["x-explicit"]).toBe("1");
  });

  it("an API key in the query and a cookie stay on the own origin too", async () => {
    const r = generate(
      har([
        entry({ url: `${O}/api/v1/items?api_key=k_live_3f9a8b7c6d5e4f3a`, reqHeaders: { cookie: "sid=s3ss10nvalue77" }, resBody: [{ id: 1 }] }),
        entry({ url: `${O}/api/v1/orders?api_key=k_live_3f9a8b7c6d5e4f3a`, reqHeaders: { cookie: "sid=s3ss10nvalue77" }, resBody: [{ id: 1 }] }),
        entry({ url: `${THIRD}/v1/rates`, resBody: { usd: 1 } }),
      ]),
    );
    const mod = await load(r.files["client.ts"]!);
    const { calls, fetch } = recorder();
    const client = new mod[r.plan.clientName]({ apiKey: "KEY", cookie: "sid=x", fetch });
    await client.listRates();
    expect(calls[0]!.url).not.toContain("KEY");
    expect(calls[0]!.headers.cookie).toBeUndefined();
  });

  it("a single-origin client is unchanged: no trustedOrigins option", () => {
    const r = generate(har([entry({ url: `${O}/api/v1/items`, reqHeaders: { authorization: TOKEN }, resBody: [{ id: 1 }] })]));
    expect(r.files["client.ts"]).not.toContain("trustedOrigins");
  });

  it("generated: random third-party hosts never receive the token", SLOW, async () => {
    const rnd = rng(19_1);
    for (let i = 0; i < 12; i++) {
      const third = `https://${word(rnd)}.${word(rnd, 2)}.example`;
      const r = generate(capture(third));
      const mod = await load(r.files["client.ts"]!);
      const { calls, fetch } = recorder();
      const client = new mod[r.plan.clientName]({ token: "tok", fetch });
      for (const op of r.plan.ops) await client[op.ep.name]();
      for (const c of calls) expect(c.headers.authorization === undefined, c.url).toBe(!c.url.startsWith(O));
    }
  });
});

// ── H2 ─────────────────────────────────────────────────────────────────────────

describe("H2 a recorded trailing slash is kept", () => {
  const capture = har([
    entry({ url: `${O}/api/users/`, resBody: [{ id: 7, active: true }] }),
    entry({ url: `${O}/api/users/7/`, resBody: { id: 7, active: true } }),
    entry({ url: `${O}/api/users/8/`, resBody: { id: 8, active: false } }),
  ]);

  it("the reviewer's Django-style capture: client and OpenAPI keep the slash", async () => {
    const r = generate(capture);
    const code = r.files["client.ts"]!;
    expect(code).toContain(`"/api/users/"`);
    expect(code).toContain("`/api/users/${enc(params.userId)}/`");
    const spec = JSON.parse(r.files["openapi.json"]!);
    expect(Object.keys(spec.paths).sort()).toEqual(["/api/users/", "/api/users/{userId}/"]);
    const mod = await load(code);
    const { calls, fetch } = recorder(200, []);
    const client = new mod[r.plan.clientName]({ fetch });
    await client.listUsers();
    await client.getUser({ userId: 9 });
    expect(calls.map((c) => c.url)).toEqual([`${O}/api/users/`, `${O}/api/users/9/`]);
  });

  it("paths without a slash are unchanged, and the endpoint id (annotations) stays the same", () => {
    const r = generate(har([entry({ url: `${O}/api/users`, resBody: [{ id: 7 }] })]));
    expect(r.files["client.ts"]).toContain(`"/api/users"`);
    expect(r.files["client.ts"]).not.toContain(`"/api/users/"`);
    expect(generate(capture).model.endpoints.map((e) => e.id).sort()).toEqual(["GET /api/users", "GET /api/users/{userId}"]);
  });

  it("generated: random paths keep or drop the slash as recorded", () => {
    const rnd = rng(19_2);
    for (let i = 0; i < 40; i++) {
      const segs = Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => word(rnd, 2) + "s");
      const slash = rnd() < 0.5;
      const path = `/api/${segs.join("/")}${slash ? "/" : ""}`;
      const r = generate(har([entry({ url: O + path, resBody: [{ id: 1 }] })]));
      expect(r.files["client.ts"]).toContain(JSON.stringify(path));
      expect(Object.keys(JSON.parse(r.files["openapi.json"]!).paths)).toEqual([path]);
    }
  });
});

// ── H3 ─────────────────────────────────────────────────────────────────────────

describe("H3 ApiError never shows the API key", () => {
  it("the reviewer's `?api_key=`: not in the message, masked in `url`", async () => {
    const r = generate(har([entry({ url: `${O}/api/v1/items?api_key=sk_live_abcdef1234567890`, resBody: [{ id: 1 }] })]));
    const mod = await load(r.files["client.ts"]!);
    const { fetch } = recorder(500, { error: "boom" });
    const err = await new mod[r.plan.clientName]({ apiKey: "MY-SECRET-KEY", fetch }).listItems().catch((e: Error) => e);
    expect(err.name).toBe("ApiError");
    expect(err.message).toBe(`GET ${O}/api/v1/items failed with HTTP 500`);
    expect(String(err.url)).not.toContain("MY-SECRET-KEY");
    expect(String(err.url)).toContain("api_key=REDACTED");
    expect(JSON.stringify(err)).not.toContain("MY-SECRET-KEY");
  });

  it("no query string in any message (it can hold user data)", async () => {
    const r = generate(har([entry({ url: `${O}/api/v1/search?q=shoes`, resBody: [{ id: 1 }] })]));
    const mod = await load(r.files["client.ts"]!);
    const { fetch } = recorder(404);
    const err = await new mod[r.plan.clientName]({ fetch }).search({ q: "mehmet@corp.example" }).catch((e: Error) => e);
    expect(err.message).not.toContain("mehmet");
    expect(err.status).toBe(404);
  });
});

// ── H4 ─────────────────────────────────────────────────────────────────────────

describe("H4 the MCP server never replaces a corrupt annotations file", () => {
  const client = new Client({ name: "test", version: "0.0.0" });
  const server = createMcpServer();
  beforeAll(async () => {
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
  });
  afterAll(async () => {
    await client.close();
  });
  const call = async (name: string, args: Record<string, unknown>) => {
    const res = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
    return { text: res.content.map((c) => c.text).join("\n"), isError: !!res.isError };
  };
  const setup = (annotations: string) => {
    const dir = tmp();
    const path = join(dir, "capture.har");
    writeFileSync(path, har([entry({ url: `${O}/api/v1/items`, resBody: [{ id: 1 }] })]));
    const out = join(dir, "out");
    mkdirSync(out);
    writeFileSync(join(out, "har2sdk.annotations.json"), annotations);
    return { path, out };
  };

  it("the reviewer's case: invalid JSON is refused and left as it was", async () => {
    const broken = `{ "endpoints": { "GET /api/v1/items": { "name": "listAll" } }, `;
    const { path, out } = setup(broken);
    const res = await call("generate_sdk", { har_path: path, out_dir: out });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/isn't valid JSON; nothing was written/);
    expect(readFileSync(join(out, "har2sdk.annotations.json"), "utf8")).toBe(broken);
  });

  it("a file in the wrong format is refused too", async () => {
    const wrong = `{ "endpoints": { "GET /api/v1/items": { "name": 123 } } }`;
    const { path, out } = setup(wrong);
    const res = await call("generate_sdk", { har_path: path, out_dir: out });
    expect(res.isError).toBe(true);
    expect(readFileSync(join(out, "har2sdk.annotations.json"), "utf8")).toBe(wrong);
  });

  it("a valid file is still merged", async () => {
    const { path, out } = setup(`{ "endpoints": { "GET /api/v1/items": { "name": "listAll" } } }`);
    const res = await call("generate_sdk", { har_path: path, out_dir: out });
    expect(res.isError).toBe(false);
    expect(readFileSync(join(out, "client.ts"), "utf8")).toContain("async listAll(");
  });
});

// ── H5 ─────────────────────────────────────────────────────────────────────────

describe("H5 only a file har2sdk wrote is overwritten", () => {
  const capture = har([entry({ url: `${O}/api/v1/items`, resBody: [{ id: 1 }] })]);
  const run = (files: Record<string, string>) => {
    const dir = tmp();
    writeFileSync(join(dir, "c.har"), capture);
    const out = join(dir, "out");
    mkdirSync(out);
    for (const [f, t] of Object.entries(files)) writeFileSync(join(out, f), t);
    const r = spawnSync(process.execPath, [CLI, join(dir, "c.har"), "-o", out], { encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });
    return { status: r.status, out };
  };

  it("the reviewer's hand-written client.ts that imports har2sdk output is kept", () => {
    const mine = `// my wrapper around the har2sdk client\nexport const x = 1;\n`;
    const { status, out } = run({ "client.ts": mine });
    expect(status).toBe(1);
    expect(readFileSync(join(out, "client.ts"), "utf8")).toBe(mine);
  });

  it("an openapi.json that only mentions har2sdk is kept", () => {
    const mine = `{"openapi":"3.1.0","info":{"title":"made with har2sdk later","version":"1"}}`;
    expect(run({ "openapi.json": mine }).status).toBe(1);
  });

  it("files har2sdk wrote are replaced, as before", () => {
    const first = generateFromHar(capture).files;
    expect(writtenByHar2sdk("client.ts", first["client.ts"]!)).toBe(true);
    expect(writtenByHar2sdk("openapi.json", first["openapi.json"]!)).toBe(true);
    expect(run({ "client.ts": first["client.ts"]!, "openapi.json": first["openapi.json"]! }).status).toBe(0);
  });

  it("generated: a file that mentions har2sdk anywhere but the generated header is not ours", () => {
    const rnd = rng(19_5);
    for (let i = 0; i < 50; i++) {
      const lines = Array.from({ length: 1 + Math.floor(rnd() * 5) }, () => `// ${word(rnd)} har2sdk ${word(rnd)}`);
      lines.splice(Math.floor(rnd() * lines.length), 0, "export {};");
      expect(writtenByHar2sdk("client.ts", lines.join("\n"))).toBe(false);
    }
  });
});

// ── H6 ─────────────────────────────────────────────────────────────────────────

describe("H6 a JSON body is sent with the media type the app used", () => {
  it("the reviewer's JSON:API capture sends application/vnd.api+json, in the client and the spec", async () => {
    const r = generate(
      har([
        entry({
          method: "POST",
          url: `${O}/api/v1/articles`,
          reqMime: "application/vnd.api+json",
          reqBody: { data: { type: "articles", attributes: { title: "x" } } },
          resBody: { data: { id: "1" } },
        }),
      ]),
    );
    const mod = await load(r.files["client.ts"]!);
    const { calls, fetch } = recorder();
    await new mod[r.plan.clientName]({ fetch }).createArticle({ data: { type: "articles", attributes: { title: "y" } } });
    expect(calls[0]!.headers["content-type"]).toBe("application/vnd.api+json");
    const spec = JSON.parse(r.files["openapi.json"]!);
    expect(Object.keys(spec.paths["/api/v1/articles"].post.requestBody.content)).toEqual(["application/vnd.api+json"]);
  });

  it("plain JSON, JSON sent as text/plain, and media types with odd characters stay application/json", async () => {
    for (const mime of ["application/json; charset=utf-8", "text/plain", "application/x-evil\r\nx-injected: 1+json", "text/json"]) {
      const r = generate(har([entry({ method: "POST", url: `${O}/api/v1/notes`, reqMime: mime, reqBody: { text: "a" }, resBody: { id: 1 } })]));
      const mod = await load(r.files["client.ts"]!);
      const { calls, fetch } = recorder();
      await new mod[r.plan.clientName]({ fetch }).createNote({ text: "b" });
      expect(calls[0]!.headers["content-type"], mime).toBe("application/json");
    }
  });

  it("generated: any structured-syntax +json type is kept as recorded", () => {
    const rnd = rng(19_6);
    for (let i = 0; i < 30; i++) {
      const mime = `application/vnd.${word(rnd, 2)}.v${1 + Math.floor(rnd() * 3)}+json`;
      const r = generate(har([entry({ method: "PATCH", url: `${O}/api/v1/things/12`, reqMime: mime, reqBody: { a: 1 }, resBody: { a: 1 } })]));
      expect(r.files["client.ts"]).toContain(`contentType: ${JSON.stringify(mime)}`);
    }
  });
});

// ── H7 ─────────────────────────────────────────────────────────────────────────

describe("H7 a repeated form field is a list", () => {
  it("the reviewer's `tag=a&tag=b`: typed string[], sent as two fields", async () => {
    const r = generate(
      har([
        entry({ method: "POST", url: `${O}/api/v1/search`, reqMime: "application/x-www-form-urlencoded", reqBody: "tag=a&tag=b&q=x", resBody: [{ id: 1 }] }),
      ]),
    );
    const code = r.files["client.ts"]!;
    expect(code).toMatch(/tag: string\[\];/);
    const mod = await load(code);
    const { calls, fetch } = recorder(200, []);
    await new mod[r.plan.clientName]({ fetch }).search({ tag: ["red", "blue"], q: "y" });
    expect(String(calls[0]!.body)).toBe("tag=red&tag=blue&q=y");
  });

  it("PHP's `tag[]` is a list even with one value; a single plain field stays a scalar", () => {
    const r = generate(
      har([entry({ method: "POST", url: `${O}/api/v1/filter`, reqMime: "application/x-www-form-urlencoded", reqBody: "tag%5B%5D=a&page=2", resBody: [{ id: 1 }] })]),
    );
    expect(r.files["client.ts"]).toMatch(/"tag\[\]": string\[\];/);
    expect(r.files["client.ts"]).toMatch(/page: number;/);
  });

  it("generated: any key sent n > 1 times is a list of its item type", () => {
    const rnd = rng(19_7);
    for (let i = 0; i < 30; i++) {
      const key = word(rnd, 2);
      const n = 2 + Math.floor(rnd() * 4);
      const nums = rnd() < 0.5;
      const body = Array.from({ length: n }, (_, j) => `${key}=${nums ? j + 1 : word(rnd, 2)}`).join("&");
      const r = generate(har([entry({ method: "POST", url: `${O}/api/v1/form`, reqMime: "application/x-www-form-urlencoded", reqBody: body, resBody: { ok: true } })]));
      expect(r.files["client.ts"]).toContain(`${key}: ${nums ? "number" : "string"}[];`);
    }
  });
});

// ── H8 ─────────────────────────────────────────────────────────────────────────

describe("H8 an email inside a sentence is evidence", () => {
  const capture = (local: string, sentence: (email: string) => string, prev = "profile") =>
    har([
      entry({ url: `${O}/api/v1/errors`, resBody: { message: sentence(`${local}@corp.example`) } }),
      entry({ url: `${O}/api/v1/${prev}/${local}`, resBody: { a: 1 } }),
      entry({ url: `${O}/api/v1/orders`, resBody: [{ id: 1, total: 2 }] }),
    ]);

  it("the reviewer's `/profile/mehmet.yilmaz`: templated, and the name is nowhere in the output", () => {
    const r = generate(capture("mehmet.yilmaz", (e) => `Could not deliver to ${e}, mailbox full`));
    expect(r.model.endpoints.map((e) => e.path)).toContain("/api/v1/profile/{profileId}");
    for (const f of Object.values(r.files)) expect(f.toLowerCase()).not.toMatch(/mehmet|yilmaz/);
  });

  it("the email itself is a recorded value: never in the output", () => {
    const r = generateFromHar(
      har([entry({ url: `${O}/api/v1/errors`, resBody: { message: "Mail to a.kaya@corp.example bounced (550)." } }), entry({ url: `${O}/api/v1/a.kaya@corp.example`, resBody: {} })]),
    );
    for (const f of Object.values(r.files)) expect(f).not.toContain("a.kaya@corp.example");
  });

  it("generated: random logins inside random sentences never reach the output", () => {
    const rnd = rng(19_8);
    const sentences = [
      (e: string) => `Could not deliver to ${e}, mailbox full`,
      (e: string) => `Invite sent to <${e}>.`,
      (e: string) => `"${e}" is already a member`,
      (e: string) => `mailto:${e}`,
      (e: string) => `User (${e}) was locked; contact support`,
    ];
    for (let i = 0; i < 40; i++) {
      const local = rnd() < 0.5 ? `${word(rnd, 2)}.${word(rnd, 3)}` : word(rnd, 4);
      const prev = ["profile", "users", "members", "people"][Math.floor(rnd() * 4)]!;
      const r = generateFromHar(capture(local, sentences[Math.floor(rnd() * sentences.length)]!, prev));
      const out = Object.values(r.files).join("\n").toLowerCase();
      const ident = local.replace(/\W/g, "");
      expect(out.includes(local) || out.replace(/\W/g, "").includes(ident), `${prev}/${local}`).toBe(false);
    }
  });
});

// ── H9 ─────────────────────────────────────────────────────────────────────────

describe("H9 no provenance claim without an attestation", () => {
  it("package.json doesn't ask npm for provenance (releases are published locally)", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    expect(pkg.publishConfig?.provenance).toBeUndefined();
  });

  it("README and SECURITY.md don't claim one", () => {
    for (const f of ["README.md", "SECURITY.md"]) expect(readFileSync(join(ROOT, f), "utf8")).not.toMatch(/provenance (attestation|signed|verified)/i);
  });
});
