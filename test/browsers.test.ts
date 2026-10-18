/**
 * The demo shop recorded by every browser available to the maintainers'
 * Playwright install (see examples/demo-shop/record.mjs): each recording must
 * give the same SDK as the reference capture, with no recorded secret in any
 * output, through the streaming reader as well as the in-memory one.
 * Firefox and WebKit could not be installed where these were recorded: see
 * docs/KNOWN-ISSUES.md.
 */
import { readFileSync, readdirSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadHarFile } from "../src/har.js";
import { generateFromHar, generateFromModel } from "../src/index.js";
import { listenMock } from "../src/mock.js";
import { analyzeExchanges } from "../src/model.js";
import { buildPlan } from "../src/plan.js";
import { renderChatPrompt } from "../src/summary.js";
import { DEMO_SECRETS, ROOT } from "./helpers.js";

const DIR = join(ROOT, "test/fixtures/browsers");
const fixtures = readdirSync(DIR).filter((f) => f.endsWith(".har"));
const want = JSON.parse(readFileSync(join(ROOT, "test/fixtures/demo-snapshot.json"), "utf8"));
const snapshot = (r: ReturnType<typeof generateFromHar>) => ({
  endpoints: r.plan.ops.map((o) => `${o.ep.id} → ${o.ep.name}`),
  types: Object.fromEntries(r.plan.registry.types.map((t) => [t.name, t.aliasOf ? `= ${t.aliasOf}` : t.props.map((p) => p.name + (p.optional ? "?" : "")).join(", ")])),
});

describe.each(fixtures)("browser recording %s", (name) => {
  const text = readFileSync(join(DIR, name), "utf8");

  it("gives the demo's endpoints and types", () => {
    expect(snapshot(generateFromHar(text))).toEqual(want);
  });

  it("the streaming reader gives the same SDK", async () => {
    const exchanges = await loadHarFile(join(DIR, name));
    const r = generateFromModel(analyzeExchanges(exchanges), exchanges);
    expect(r.files).toEqual(generateFromHar(text).files);
  });

  it("no recorded secret in the files, the prompt or the mock, and no leak-guard refusal", async () => {
    const r = generateFromHar(text, { examples: true });
    expect(r.leaks).toEqual([]);
    const server = await listenMock(r.model, r.exchanges, { port: 0 });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const bodies: string[] = [];
    try {
      for (const ex of r.exchanges) if (/^\/(api|graphql)/.test(ex.pathname)) bodies.push(await (await fetch(base + ex.pathname + ex.url.search)).text());
    } finally {
      server.close();
    }
    const all = [...Object.values(r.files), renderChatPrompt(buildPlan(structuredClone(r.model))), ...bodies].join("\n");
    for (const s of DEMO_SECRETS) expect(all).not.toContain(s);
  });
});

it("at least one recording per browser family that was available", () => {
  expect(fixtures.some((f) => f.startsWith("chromium"))).toBe(true);
});
