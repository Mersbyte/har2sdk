/**
 * Twenty-first review (v0.6.16): a security pass by another AI assistant against the published 0.6.16.
 * Five findings fixed here, each reproduced with the reviewer's input first. One describe block per finding.
 *
 * K1: MCP `generate_sdk` accepted any `base_url`. Text in a capture can steer a model, and the client sends
 *     the user's token to its base URL.
 * K2: a username that appeared only inside a JWT payload (`preferred_username: "zeynepkaya"`) was written into
 *     `client.ts` at `/profile/zeynepkaya`.
 * K3: `mock --raw` allowed CORS from every recorded origin, third parties included, so such a site could read
 *     the unscrubbed recorded bodies from the user's browser.
 * K4: the MCP server read a link named `capture.har` whatever its target was ("only reads .har / .json").
 * K5: `--base-url https://u:p@host` wrote the password into `client.ts` (from a later version comparison).
 */
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateFromHar } from "../src/index.js";
import { createMcpServer, mcpBaseUrlProblem } from "../src/mcp.js";
import { listenMock } from "../src/mock.js";
import { entry, har } from "./helpers.js";

const O = "https://app.acme.test";
const THIRD = "https://thirdparty.example.net";

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
const tmp = () => mkdtempSync(join(tmpdir(), "har2sdk-r21-"));
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (claims: Record<string, unknown>) => `${b64({ alg: "HS256", typ: "JWT" })}.${b64(claims)}.c2lnbmF0dXJlc2lnbmF0dXJl`;

const mcp = () => {
  const client = new Client({ name: "test", version: "0.0.0" });
  const server = createMcpServer();
  beforeAll(async () => {
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
  });
  afterAll(async () => {
    await client.close();
  });
  return async (name: string, args: Record<string, unknown>) => {
    const res = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
    return { text: res.content.map((c) => c.text).join("\n"), isError: !!res.isError };
  };
};

const twoOrigins = har([
  entry({ url: `${O}/api/v1/items`, reqHeaders: { authorization: "Bearer opaque-token-7f3k9q2m" }, resBody: [{ id: 1 }] }),
  entry({ url: `${THIRD}/v1/rates`, resBody: { usd: 1 } }),
]);

// ── K1 ─────────────────────────────────────────────────────────────────────────

describe("K1 MCP base_url must be a recorded origin or localhost", () => {
  const call = mcp();
  const setup = () => {
    const dir = tmp();
    const path = join(dir, "capture.har");
    writeFileSync(path, twoOrigins);
    return { path, out: join(dir, "out") };
  };

  it("the reviewer's case: an attacker's URL is refused and nothing is written", async () => {
    const { path, out } = setup();
    const res = await call("generate_sdk", { har_path: path, out_dir: out, base_url: "https://collect.attacker.example" });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/one of the capture's origins or a localhost URL/);
  });

  it("a recorded origin (with a path), a third party in the capture, and localhost are accepted", async () => {
    for (const base of [`${O}/api`, THIRD, "http://localhost:4010", "http://127.0.0.1:8080/v1"]) {
      const { path, out } = setup();
      const res = await call("generate_sdk", { har_path: path, out_dir: out, base_url: base });
      expect(res.isError, base).toBe(false);
    }
  });

  it("look-alikes, userinfo and other schemes are refused", () => {
    const recorded = [O];
    for (const bad of [
      "https://app.acme.test.attacker.example",
      "https://app.acme.test@attacker.example",
      "https://user:pw@app.acme.test",
      "http://app.acme.test",
      "https://app.acme.test:8443",
      "file:///etc/passwd",
      "javascript:alert(1)",
      "not a url",
      "https://localhost.attacker.example",
    ]) {
      expect(mcpBaseUrlProblem(bad, recorded), bad).toBeDefined();
    }
    expect(mcpBaseUrlProblem("https://app.acme.test/v2/", recorded)).toBeUndefined();
    expect(mcpBaseUrlProblem("http://[::1]:3000", recorded)).toBeUndefined();
  });

  it("generated: random hosts are refused unless the capture talked to them", () => {
    const rnd = rng(21_1);
    for (let i = 0; i < 100; i++) {
      const host = `https://${word(rnd)}.${word(rnd, 2)}.example`;
      const recorded = rnd() < 0.5 ? [O, host] : [O];
      expect(mcpBaseUrlProblem(host + "/api", recorded) === undefined, host).toBe(recorded.includes(host));
    }
  });
});

// ── K2 ─────────────────────────────────────────────────────────────────────────

describe("K2 a JWT's claims are evidence about its user", () => {
  const capture = (token: string, segment: string, where: "header" | "cookie" | "body" = "header") => {
    const reqHeaders: Record<string, string> =
      where === "header" ? { authorization: `Bearer ${token}` } : where === "cookie" ? { cookie: `session=${token}` } : {};
    return har([
      ...(where === "body" ? [entry({ method: "POST", url: `${O}/api/v1/auth/refresh`, reqBody: { x: 1 }, resBody: { access_token: token } })] : []),
      entry({ url: `${O}/api/v1/profile/${segment}`, reqHeaders, resBody: { bio: "x" } }),
      entry({ url: `${O}/api/v1/orders`, reqHeaders, resBody: [{ id: 1, total: 2 }] }),
    ]);
  };

  it("the reviewer's case: `zeynepkaya` from the token's payload is a parameter, and in no output", () => {
    const token = jwt({ sub: "8f2c1a", preferred_username: "zeynepkaya", name: "Zeynep Kaya", iss: "https://auth.acme.test", aud: "api" });
    const r = generateFromHar(capture(token, "zeynepkaya"));
    expect(r.model.endpoints.map((e) => e.path)).toContain("/api/v1/profile/{profileId}");
    for (const f of Object.values(r.files)) expect(f.toLowerCase()).not.toContain("zeynepkaya");
  });

  it("in a cookie and in a response body too", () => {
    const token = jwt({ username: "mdemir77", exp: 1 });
    for (const where of ["cookie", "body"] as const) {
      const r = generateFromHar(capture(token, "mdemir77", where));
      expect(Object.values(r.files).join("\n"), where).not.toContain("mdemir77");
    }
  });

  it("ordinary claims don't refuse a normal app", () => {
    const token = jwt({ iss: "https://auth.acme.test", aud: "orders", scope: "read write", role: "admin", exp: 1, iat: 1 });
    const r = generateFromHar(capture(token, "settings"));
    expect(r.leaks).toEqual([]);
    expect(r.model.endpoints.map((e) => e.path)).toContain("/api/v1/profile/settings");
  });

  it("not a JWT: junk that starts with eyJ is ignored", () => {
    const r = generateFromHar(capture("eyJnotbase64.eyJ!!!.x", "settings"));
    expect(r.leaks).toEqual([]);
  });

  it("generated: a random username under a random claim never reaches the output", () => {
    const rnd = rng(21_2);
    const claims = ["preferred_username", "username", "login", "nickname", "upn", "unique_name"];
    for (let i = 0; i < 40; i++) {
      const user = rnd() < 0.5 ? word(rnd, 4) : `${word(rnd, 2)}.${word(rnd, 3)}`;
      const claim = claims[Math.floor(rnd() * claims.length)]!;
      const where = (["header", "cookie", "body"] as const)[Math.floor(rnd() * 3)]!;
      const r = generateFromHar(capture(jwt({ sub: String(1000 + i), [claim]: user }), user, where));
      const out = Object.values(r.files).join("\n").toLowerCase();
      expect(out.includes(user) || out.includes(user.replace(/\W/g, "")), `${claim} ${where} ${user}`).toBe(false);
    }
  });
});

// ── K3 ─────────────────────────────────────────────────────────────────────────

describe("K3 `mock --raw` allows CORS from localhost only", () => {
  const corsFor = async (raw: boolean, origin: string) => {
    const r = generateFromHar(twoOrigins);
    const server = await listenMock(r.model, r.exchanges, { port: 0, raw });
    try {
      const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/items`, { headers: { origin } });
      return res.headers.get("access-control-allow-origin");
    } finally {
      server.close();
    }
  };

  it("the reviewer's case: a recorded third party can't read raw bodies", async () => {
    expect(await corsFor(true, THIRD)).toBeNull();
    expect(await corsFor(true, O)).toBeNull();
    expect(await corsFor(true, "http://localhost:5173")).toBe("http://localhost:5173");
  });

  it("the default (scrubbed) mock still allows the recorded origins", async () => {
    expect(await corsFor(false, O)).toBe(O);
  });
});

// ── K4 ─────────────────────────────────────────────────────────────────────────

describe("K4 the MCP server reads a link only if its target is a capture", () => {
  const call = mcp();

  it.skipIf(process.platform === "win32")("the reviewer's case: capture.har → a .txt file is refused", async () => {
    const dir = tmp();
    const secret = join(dir, "notes.txt");
    writeFileSync(secret, twoOrigins);
    const link = join(dir, "capture.har");
    symlinkSync(secret, link);
    const res = await call("analyze_har", { har_path: link });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/isn't a \.har/);
  });

  it.skipIf(process.platform === "win32")("a link to a real .har still works", async () => {
    const dir = tmp();
    mkdirSync(join(dir, "real"));
    const target = join(dir, "real", "x.har");
    writeFileSync(target, twoOrigins);
    const link = join(dir, "capture.har");
    symlinkSync(target, link);
    const res = await call("analyze_har", { har_path: link });
    expect(res.isError).toBe(false);
  });
});

// ── K5 ─────────────────────────────────────────────────────────────────────────

describe("K5 a base URL with a user name or password is refused (it would be written into client.ts)", () => {
  it("the reviewer's `--base-url https://u:p@host`: refused, and the password isn't echoed", () => {
    let message = "";
    try {
      generateFromHar(twoOrigins, { baseUrl: "https://u:s3cr3tpass@api.acme.test" });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/user name or password/);
    expect(message).not.toContain("s3cr3tpass");
  });

  it("a plain base URL with a path is still fine", () => {
    expect(generateFromHar(twoOrigins, { baseUrl: "https://api.acme.test/v2" }).files["client.ts"]).toContain("https://api.acme.test/v2");
  });

  it("generated: any userinfo is refused", () => {
    const rnd = rng(21_5);
    for (let i = 0; i < 30; i++) {
      const user = word(rnd, 2);
      const url = rnd() < 0.5 ? `https://${user}@api.acme.test` : `http://${user}:${word(rnd, 3)}@localhost:${3000 + i}`;
      expect(() => generateFromHar(twoOrigins, { baseUrl: url }), url).toThrow(/user name or password/);
    }
  });
});
