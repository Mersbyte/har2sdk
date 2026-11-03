/**
 * Twenty-second review (v0.6.17): the MCP server, as a model drives it. A capture is untrusted input, and
 * text in it can steer the model that calls the tools. One describe block per finding.
 *
 * M1: `base_url` could be any origin recorded in the capture, so a crafted HAR that also called an attacker's
 *     site could have the model point the client (and the user's token) there.
 * M2: `hosts` moved the client's default address: `hosts: ["evil.example"]` made `DEFAULT_BASE_URL`
 *     `https://evil.example`, with no warning.
 * M3: `generate_sdk` had an `allow_leaks` parameter, so a model could write files the leak guard refused.
 *     The CLI's `--allow-leaks` stays: there the user types it.
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMcpServer } from "../src/mcp.js";
import { entry, har } from "./helpers.js";

const O = "https://app.acme.test";
const EVIL = "https://evil.example";
const AUTH = { authorization: "Bearer opaque-token-7f3k9q2m" };

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

/** The app's API (with credentials) plus a site a crafted capture also "called", with more endpoints. */
const crafted = (evil = EVIL) =>
  har([
    entry({ url: `${O}/api/v1/items`, reqHeaders: AUTH, resBody: [{ id: 1 }] }),
    entry({ url: `${O}/api/v1/orders`, reqHeaders: AUTH, resBody: [{ id: 2 }] }),
    entry({ url: `${evil}/collect/a`, resBody: { ok: true } }),
    entry({ url: `${evil}/collect/b`, resBody: { ok: true } }),
    entry({ url: `${evil}/collect/c`, resBody: { ok: true } }),
  ]);

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
const setup = (capture: string) => {
  const dir = mkdtempSync(join(tmpdir(), "har2sdk-r22-"));
  const path = join(dir, "capture.har");
  writeFileSync(path, capture);
  return { path, out: join(dir, "out") };
};
const baseOf = (out: string) => /DEFAULT_BASE_URL = "([^"]*)"/.exec(readFileSync(join(out, "client.ts"), "utf8"))?.[1];

// ── M1 ─────────────────────────────────────────────────────────────────────────

describe("M1 base_url: only the capture's own API origin or localhost", () => {
  it("the reviewer's case: a crafted HAR + base_url=evil is refused, pointing to the CLI", async () => {
    const { path, out } = setup(crafted());
    const res = await call("generate_sdk", { har_path: path, out_dir: out, base_url: EVIL });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/--base-url/);
  });

  it("the API's own origin (any path) and localhost are accepted", async () => {
    for (const base of [O, `${O}/api`, "http://localhost:4010", "http://127.0.0.1:8080/v1"]) {
      const { path, out } = setup(crafted());
      const res = await call("generate_sdk", { har_path: path, out_dir: out, base_url: base });
      expect(res.isError, base).toBe(false);
      expect(baseOf(out), base).toBe(base.replace(/\/+$/, ""));
    }
  });

  it("without base_url the default is the origin that got the credentials, not the busiest one", async () => {
    const { path, out } = setup(crafted());
    expect((await call("generate_sdk", { har_path: path, out_dir: out })).isError).toBe(false);
    expect(baseOf(out)).toBe(O);
  });

  it("generated: a random recorded origin other than the API's is never accepted", async () => {
    const rnd = rng(22_1);
    for (let i = 0; i < 8; i++) {
      const evil = `https://${word(rnd)}.${word(rnd, 2)}.example`;
      const { path, out } = setup(crafted(evil));
      const res = await call("generate_sdk", { har_path: path, out_dir: out, base_url: `${evil}/v1` });
      expect(res.isError, evil).toBe(true);
    }
  });
});

// ── M2 ─────────────────────────────────────────────────────────────────────────

describe("M2 hosts doesn't move the client's address", () => {
  it("the reviewer's case: hosts=[evil.example] without base_url is refused", async () => {
    const { path, out } = setup(crafted());
    const res = await call("generate_sdk", { har_path: path, out_dir: out, hosts: ["evil.example"] });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/--host/);
  });

  it("no false refusal: hosts for the API's own host still works", async () => {
    const { path, out } = setup(crafted());
    const res = await call("generate_sdk", { har_path: path, out_dir: out, hosts: ["app.acme.test"] });
    expect(res.isError).toBe(false);
    expect(baseOf(out)).toBe(O);
  });

  it("hosts for another host with a localhost base_url is fine (nothing goes to that host)", async () => {
    const { path, out } = setup(crafted());
    const res = await call("generate_sdk", { har_path: path, out_dir: out, hosts: ["evil.example"], base_url: "http://localhost:3000" });
    expect(res.isError).toBe(false);
    expect(baseOf(out)).toBe("http://localhost:3000");
  });

  it("generated: hosts naming any other recorded host is refused", async () => {
    const rnd = rng(22_2);
    for (let i = 0; i < 8; i++) {
      const evil = `https://${word(rnd)}.${word(rnd, 2)}.example`;
      const { path, out } = setup(crafted(evil));
      const res = await call("generate_sdk", { har_path: path, out_dir: out, hosts: [new URL(evil).host] });
      expect(res.isError, evil).toBe(true);
    }
  });
});

// ── M3 ─────────────────────────────────────────────────────────────────────────

describe("M3 MCP has no allow_leaks", () => {
  it("the generate_sdk schema has no allow_leaks", async () => {
    const { tools } = await client.listTools();
    const gen = tools.find((t) => t.name === "generate_sdk")!;
    expect(Object.keys((gen.inputSchema as { properties?: object }).properties ?? {})).not.toContain("allow_leaks");
  });

  it("a refusal doesn't suggest a way around the leak guard", async () => {
    // An email in a GraphQL comment stays in the document: the guard refuses it.
    const { path, out } = setup(
      har([entry({ method: "POST", url: `${O}/graphql`, reqBody: { query: "# asked by zeynep.ak@posteo.de\nquery Dash { dash { id } }" }, resBody: { data: { dash: { id: 1 } } } })]),
    );
    const res = await call("generate_sdk", { har_path: path, out_dir: out, allow_leaks: true });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/Nothing written/);
    expect(res.text).not.toMatch(/allow[_-]leaks/i);
    expect(res.text).not.toContain("zeynep");
  });
});
