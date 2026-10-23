/**
 * One field recorded in three states: a string, null, and left out.
 * "Left out" and "null" are different things to a client, so the generated
 * type must keep both: `nickname?: string | null`.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { generateFromHar } from "../src/index.js";
import { listenMock } from "../src/mock.js";
import { ROOT, entry, har } from "./helpers.js";

const O = "https://api.acme.test";
type Entry = ReturnType<typeof entry>;
const gen = (entries: Entry[]) => generateFromHar(har(entries));

const STRING = { id: 1, nickname: "zebra" };
const NULL = { id: 2, nickname: null };
const OMITTED = { id: 3 };

/** Every order of three items. */
const ORDERS = [
  [0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0],
];

/** As three calls to one endpoint. */
const asCalls = (bodies: object[]) => bodies.map((b, i) => entry({ url: `${O}/api/notes/${i + 1}`, resBody: b }));
/** As the items of one list response. */
const asList = (bodies: object[]) => [entry({ url: `${O}/api/notes`, resBody: bodies })];

const iface = (code: string) => code.match(/export interface Note \{[\s\S]*?\n\}/)?.[0];

function typecheck(code: string): string {
  const dir = mkdtempSync(join(tmpdir(), "har2sdk-null-"));
  writeFileSync(join(dir, "client.ts"), code);
  writeFileSync(join(dir, "package.json"), '{ "type": "module" }');
  writeFileSync(
    join(dir, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: { strict: true, noEmit: true, target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", lib: ["ES2022", "DOM"], types: ["node"], typeRoots: [join(ROOT, "node_modules/@types")], exactOptionalPropertyTypes: true, erasableSyntaxOnly: true, skipLibCheck: true },
      files: ["client.ts"],
    }),
  );
  try {
    execFileSync(process.execPath, [join(ROOT, "node_modules/typescript/bin/tsc"), "-p", join(dir, "tsconfig.json")], { encoding: "utf8" });
    return "";
  } catch (e: any) {
    return String(e.stdout ?? e);
  }
}

describe.each([
  ["three calls to one endpoint", asCalls],
  ["three items of one list", asList],
])("string, null and omitted as %s", (_label, shape) => {
  const samples = [STRING, NULL, OMITTED];
  const runs = ORDERS.map((o) => gen(shape(o.map((i) => samples[i]!))));
  const r = runs[0]!;

  it("types the field as optional and nullable", () => {
    expect(iface(r.files["client.ts"]!)).toBe("export interface Note {\n  id: number;\n  nickname?: string | null;\n}");
  });

  it("describes it the same way in openapi.json", () => {
    const note = JSON.parse(r.files["openapi.json"]!).components.schemas.Note;
    expect(note.properties.nickname).toEqual({ type: ["string", "null"] });
    expect(note.required).toEqual(["id"]);
  });

  it("gives the same files whatever order the samples were recorded in", () => {
    for (const other of runs.slice(1)) {
      expect(other.files["client.ts"]).toBe(r.files["client.ts"]);
      expect(other.files["openapi.json"]).toBe(r.files["openapi.json"]);
    }
  });

  it("accepts all three states and rejects an explicit undefined", () => {
    const usage = `
const a: Note = { id: 1, nickname: "x" };
const b: Note = { id: 2, nickname: null };
const c: Note = { id: 3 };
// @ts-expect-error left out is not the same as undefined under exactOptionalPropertyTypes
const d: Note = { id: 4, nickname: undefined };
export const all = [a, b, c, d];
`;
    expect(typecheck(r.files["client.ts"]! + usage)).toBe("");
  });
});

describe("two of the three states", () => {
  it.each([
    ["string and null", [STRING, NULL], "nickname: string | null;", ["string", "null"], true],
    ["string and omitted", [STRING, OMITTED], "nickname?: string;", "string", false],
    ["null and omitted", [NULL, OMITTED], "nickname?: null;", "null", false],
  ])("%s", (_label, bodies, field, type, required) => {
    const r = gen(asList(bodies));
    expect(iface(r.files["client.ts"]!)).toContain(`  ${field}\n`);
    const note = JSON.parse(r.files["openapi.json"]!).components.schemas.Note;
    expect(note.properties.nickname).toEqual({ type });
    expect(note.required.includes("nickname")).toBe(required);
  });
});

describe("the mock server", () => {
  it("keeps each state: a string stays a string, null stays null, omitted stays omitted", async () => {
    const r = gen(asCalls([STRING, NULL, OMITTED]));
    const server = await listenMock(r.model, r.exchanges, { port: 0 });
    try {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/notes`;
      const [s, n, o] = await Promise.all([1, 2, 3].map(async (i) => (await fetch(`${base}/${i}`)).json()));
      expect(typeof s.nickname).toBe("string");
      expect(n).toHaveProperty("nickname", null);
      expect(o).not.toHaveProperty("nickname");
    } finally {
      server.close();
    }
  });
});
