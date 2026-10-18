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
  return { model, plan, exchanges, files, warnings, leaks };
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
