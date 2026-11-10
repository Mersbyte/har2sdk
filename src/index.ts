/**
 * har2sdk — turn browser network traffic (HAR) into an OpenAPI spec and a
 * typed TypeScript SDK. Local, deterministic, no API key.
 */
import { randomBytes } from "node:crypto";
import { lstat, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Annotations } from "./annotations.js";
import { generateTypeScript } from "./codegen.js";
import type { Exchange } from "./har.js";
import { analyzeExchanges, analyzeHarText, type AnalyzeOptions, type ApiModel } from "./model.js";
import { generateOpenApi, type OpenApiOptions } from "./openapi.js";
import { aliasOf, scanText, type LeakFinding } from "./leak.js";
import { buildPlan, type Plan } from "./plan.js";

export interface GenerateOptions extends AnalyzeOptions, OpenApiOptions {
  annotations?: Annotations;
  /** Emit literal unions for enum-like strings (default true). */
  enums?: boolean;
  /** Override the base URL baked into the SDK. */
  baseUrl?: string;
}

export interface GenerateResult {
  model: ApiModel;
  plan: Plan;
  exchanges: Exchange[];
  files: Record<string, string>;
  warnings: string[];
  /** Recorded values the leak guard found in the generated files (masked previews only). */
  leaks: LeakFinding[];
  /**
   * When there are leaks: `--param` patterns that make each path segment the guard reports a parameter
   * (see {@link paramPatterns}). The reported segments are "*", so a pattern never contains the value.
   */
  paramPatterns: string[];
}

export function generateFromHar(harText: string, opts: GenerateOptions = {}): GenerateResult {
  const { model, exchanges } = analyzeHarText(harText, opts);
  return generateFromModel(model, exchanges, opts);
}

export function generateFromModel(model: ApiModel, exchanges: Exchange[], opts: GenerateOptions = {}): GenerateResult {
  const plan = buildPlan(model, { annotations: opts.annotations, enums: opts.enums, baseUrl: opts.baseUrl });
  const files: Record<string, string> = {
    "client.ts": generateTypeScript(plan),
    "openapi.json": JSON.stringify(generateOpenApi(plan, opts), null, 2) + "\n",
  };
  // Leak guard: every output is checked against every recorded value. Examples are
  // fake data from the scrubber, which keeps timestamps on purpose ("createdAt"):
  // in a spec with examples, recorded dates are not reported, everything else is.
  const ignore = (name: string) => (name === "openapi.json" && opts.examples ? withDates(boilerplate(), model.taint) : boilerplate());
  const leaks = Object.entries(files).flatMap(([name, text]) => scanText(text, model.taint, name, ignore(name)));
  const warnings = [...plan.warnings];
  if (leaks.length) warnings.push(leakWarning(leaks));
  return { model, plan, exchanges, files, warnings, leaks, paramPatterns: leaks.length ? paramPatterns(plan) : [] };
}

/** At most this many patterns: the CLI shows five, and each one costs a few scans. */
const MAX_PATTERNS = 20;

/**
 * For every endpoint (up to {@link MAX_PATTERNS}) with a literal path segment the leak guard reports, the `--param` pattern that makes that
 * segment a parameter: the segment and the endpoint's parameters become "*", other literals stay, percent-encoded
 * so the pattern is safe inside double quotes in a shell. `/repos/{owner}/<recorded>/issues` gives `/repos/`, then
 * two `*` segments, then `/issues`.
 */
export function paramPatterns(plan: Plan): string[] {
  const out = new Set<string>();
  const encode = (v: string) => encodeURIComponent(v).replace(/[!'()*]/g, (ch) => "%" + ch.charCodeAt(0).toString(16).toUpperCase());
  const text = (segs: readonly (string | null)[]) => "/" + segs.map((s) => s ?? "*").join("/");
  // One scan reads every recorded value, so scans are counted, not paths: each distinct path once (8,000
  // GraphQL operations share `/graphql`), whole groups at a time, halving only a group that reports something.
  const scan = (t: string) => scanText(t, plan.model.taint, "path", boilerplate()).length;
  const found = (segs: (string | null)[]) => scan(text(segs));
  const paths = new Map<string, (string | null)[]>();
  for (const op of plan.ops) {
    const segs = op.ep.tokens.map((t) => (t.kind === "param" ? null : t.value));
    paths.set(text(segs), segs);
  }
  const reported: (string | null)[][] = [];
  const narrow = (group: string[]): void => {
    if (reported.length >= MAX_PATTERNS || !scan(group.join("\n"))) return;
    if (group.length === 1) reported.push(paths.get(group[0]!)!);
    else for (const half of [group.slice(0, group.length >> 1), group.slice(group.length >> 1)]) narrow(half);
  };
  narrow([...paths.keys()]);
  for (const segs of reported) {
    // null = "*". A value can span segments ("owner/name" recorded, `/repos/owner/name` requested): from the
    // last segment back, star every literal whose removal reports less, until nothing is reported.
    let left = found(segs);
    if (!left) continue;
    for (let i = segs.length - 1; i >= 0 && left; i--) {
      if (segs[i] === null) continue;
      const trial = segs.map((s, j) => (j === i ? null : s));
      const n = found(trial);
      if (n < left) {
        segs.splice(0, segs.length, ...trial);
        left = n;
      }
    }
    // Something the guard reports that no single segment explains (the endpoint's method name): no pattern.
    if (!left) out.add("/" + segs.map((s) => (s === null ? "*" : encode(s))).join("/"));
  }
  return [...out];
}

/** The boilerplate words plus the recorded values that are dates or timestamps. */
function withDates(words: Set<string>, taint: ApiModel["taint"]): Set<string> {
  const out = new Set(words);
  for (const v of taint.values) {
    if (/^\d{4}-\d{2}-\d{2}([t ][\d:.]+(z|[+-]\d{2}:?\d{2})?)?$/.test(v)) out.add(v).add(aliasOf(v));
  }
  return out;
}

let BOILERPLATE: Set<string> | undefined;

/**
 * Words the generator writes whatever the capture ("har2sdk", "ApiError",
 * "fetch"…): a recorded value that happens to be one of them is not a leak.
 */
function boilerplate(): Set<string> {
  if (!BOILERPLATE) {
    const model = analyzeExchanges([]);
    const plan = buildPlan(model);
    const text = generateTypeScript(plan) + JSON.stringify(generateOpenApi(plan));
    BOILERPLATE = new Set(text.toLowerCase().split(/[^a-z0-9@._+\-~%]+/).filter(Boolean));
  }
  return BOILERPLATE;
}

/** One line per file: how many recorded values were found, with masked previews. */
export function leakWarning(leaks: LeakFinding[]): string {
  const by = new Map<string, LeakFinding[]>();
  for (const l of leaks) by.set(l.where, [...(by.get(l.where) ?? []), l]);
  const parts = [...by].map(([where, ls]) => `${where}: ${ls.length} (${ls.slice(0, 3).map((l) => l.preview).join("; ")}${ls.length > 3 ? "; …" : ""})`);
  return `Leak guard: recorded values found in the output — ${parts.join(" · ")}. The CLI refuses to write such files unless --allow-leaks is given. Please report it (without the values).`;
}

/** The file system entry at a path, or undefined if there is none. */
async function entryAt(p: string): Promise<import("node:fs").Stats | undefined> {
  try {
    return await lstat(p);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

/**
 * Throws if the output folder or one of the files to write is a symbolic link
 * (or not a plain file/folder). A capture's folder may come from an archive,
 * and a link in it (`har2sdk-out` → a project, `har2sdk.annotations.json` →
 * `~/.bashrc`) would send the write somewhere else.
 */
export async function assertWritable(outDir: string, names: string[]): Promise<void> {
  const dir = await entryAt(outDir);
  if (dir?.isSymbolicLink()) throw new Error(`${outDir} is a symbolic link; har2sdk doesn't write through links. Choose another output folder.`);
  if (dir && !dir.isDirectory()) throw new Error(`${outDir} exists and is not a folder.`);
  for (const name of names) {
    const p = join(outDir, name);
    const st = await entryAt(p);
    if (st?.isSymbolicLink()) throw new Error(`${p} is a symbolic link; har2sdk doesn't write through links. Remove it or choose another output folder.`);
    if (st && !st.isFile()) throw new Error(`${p} exists and is not a file.`);
  }
}

/**
 * Write the files into `outDir`. Refuses links (see {@link assertWritable});
 * each file is written to a fresh temporary name and renamed into place, so a
 * link created in between is replaced, never followed.
 */
export async function writeFiles(outDir: string, files: Record<string, string>): Promise<string[]> {
  await assertWritable(outDir, Object.keys(files));
  await mkdir(outDir, { recursive: true });
  await assertWritable(outDir, Object.keys(files));
  const written: string[] = [];
  for (const [name, content] of Object.entries(files)) {
    const p = join(outDir, name);
    const tmp = join(outDir, `.${name}.${randomBytes(6).toString("hex")}.tmp`);
    try {
      await writeFile(tmp, content, { encoding: "utf8", flag: "wx" });
      await rename(tmp, p);
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
    written.push(p);
  }
  return written;
}

export { analyzeHarText, analyzeExchanges } from "./model.js";
export type { ApiModel, Endpoint, AnalyzeOptions } from "./model.js";
export { loadHar, loadHarFile, parseHarText, HarError } from "./har.js";
export type { Exchange } from "./har.js";
export { buildPlan } from "./plan.js";
export type { Plan, PlannedOp } from "./plan.js";
export { generateTypeScript, generateTypesOnly, VERSION } from "./codegen.js";
export { generateOpenApi } from "./openapi.js";
export { renderChatPrompt, renderEndpointList, renderEndpointDetail } from "./summary.js";
export { applyAnnotations, parseAnnotations } from "./annotations.js";
export type { Annotations, EndpointAnnotation } from "./annotations.js";
export { createMockServer } from "./mock.js";
export { redactJson, isSensitiveName, isSecretValue, Scrubber } from "./redact.js";
export { collectTaint, scanText, scrubText, isDataLike } from "./leak.js";
export type { Taint, LeakFinding } from "./leak.js";

/**
 * Did har2sdk write this file? `client.ts` must open with its generated header and `openapi.json` must be
 * JSON whose `info.description` starts with "Generated by har2sdk" — a hand-written file that merely
 * mentions har2sdk (an import, a comment) is not overwritten.
 */
export function writtenByHar2sdk(name: string, text: string): boolean {
  if (name === "client.ts") return /^\uFEFF?(?:\/\* eslint-disable \*\/\r?\n)?\/\*\*\r?\n \* [^\r\n]{1,200}? — generated by har2sdk v\d/.test(text);
  if (name === "openapi.json") {
    try {
      const doc = JSON.parse(text) as { info?: { description?: unknown } };
      return typeof doc?.info?.description === "string" && doc.info.description.startsWith("Generated by har2sdk v");
    } catch {
      return false;
    }
  }
  return false;
}
