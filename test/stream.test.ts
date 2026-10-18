/** Streaming HAR reader: the same exchanges as the in-memory parser, for every accepted shape and any chunking. */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HarError, loadHar, loadHarFile } from "../src/har.js";
import { demoHar, entry, har } from "./helpers.js";

const dir = mkdtempSync(join(tmpdir(), "har2sdk-stream-"));
let n = 0;
const file = (text: string) => {
  const p = join(dir, `c${n++}.har`);
  writeFileSync(p, text);
  return p;
};
const summary = (xs: ReturnType<typeof loadHar>) => xs.map((x) => ({ i: x.index, m: x.method, u: x.url.href, s: x.status, q: x.requestBody, r: x.responseBody, h: [...x.requestHeaders] }));

describe("loadHarFile", () => {
  it("reads the demo capture exactly like loadHar, in big and tiny chunks", async () => {
    const text = demoHar();
    const expected = summary(loadHar(text));
    expect(summary(await loadHarFile(file(text)))).toEqual(expected);
    expect(summary(await loadHarFile(file(text), 7))).toEqual(expected);
  });

  const tricky = [
    entry({ url: "https://a.test/api/x?q=%22%5D%7D", resBody: { s: 'quote " brace } bracket ] backslash \\ "entries": [1]', entries: [{ x: 1 }] } }),
    entry({ method: "POST", url: "https://a.test/api/y", reqBody: { log: { entries: [] } }, resText: "ünïcødé ✓  ", resMime: "text/plain" }),
  ];
  it.each([
    ["log.entries", har(tricky)],
    ["bare array", JSON.stringify(tricky)],
    ["entries", JSON.stringify({ entries: tricky })],
    ["BOM + whitespace", "﻿ \n" + har(tricky)],
  ])("accepts %s", async (_, text) => {
    const expected = summary(loadHar(text));
    expect(expected).toHaveLength(2);
    for (const size of [1 << 20, 3, 64]) expect(summary(await loadHarFile(file(text), size))).toEqual(expected);
  });

  it("skips invalid entries but keeps indices", async () => {
    const text = JSON.stringify({ log: { entries: [{ nope: 1 }, tricky[0]] } });
    expect((await loadHarFile(file(text))).map((x) => x.index)).toEqual(loadHar(text).map((x) => x.index));
  });

  it("rejects what loadHar rejects, without quoting the file", async () => {
    await expect(loadHarFile(file("secret-token-123 not json"))).rejects.toThrow(HarError);
    await expect(loadHarFile(file('{"log": {"pages": []}}'))).rejects.toThrow(/No "log.entries" array/);
    // A file that stops mid-entry says it is cut off (review 7, E11).
    await expect(loadHarFile(file('{"log": {"entries": [{"request": '))).rejects.toThrow(/cut off/);
    await expect(loadHarFile(file(""))).rejects.toThrow(HarError);
    await expect(loadHarFile(file("secret-token-123 not json"))).rejects.not.toThrow(/secret/);
  });
});
