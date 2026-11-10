#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { hostname, networkInterfaces } from "node:os";
import { parseArgs } from "node:util";
import { clientNameFor, parseAnnotations, type Annotations } from "./annotations.js";
import { VERSION } from "./codegen.js";
import { HarError, type Exchange } from "./har.js";
import { generateFromModel, writeFiles, writtenByHar2sdk } from "./index.js";
import { listenMock } from "./mock.js";
import { analyzeExchanges, type ApiModel } from "./model.js";
import { loadHarFile, mergeExchanges } from "./har.js";
import { buildPlan, checkBaseUrl, type Plan } from "./plan.js";
import { authSummary, renderChatPrompt } from "./summary.js";
import { scrubText, type Taint } from "./leak.js";
import { literalPathWords, renderPathWords, visibleWord } from "./pathwords.js";
import { c, guardTerminal, kb, methodColor, pad, stripControl } from "./term.js";

const HELP = `
${c.bold("har2sdk")} ${c.dim("v" + VERSION)} — turn browser network traffic into a typed TypeScript SDK.

${c.bold("Usage")}
  har2sdk <capture.har…> [options]         Generate client.ts + openapi.json (several captures are merged)
  har2sdk inspect <capture.har…>           List the endpoints that were found
  har2sdk prompt <capture.har…> [--copy]   Print a prompt to paste into any AI chat for better names
  har2sdk mock <capture.har…> [--port 4010] Replay recorded responses as a local API
  har2sdk mcp                              Start the MCP server (Claude Desktop / Code / Cursor)

${c.bold("Options")}
  -o, --out <dir>          Output directory (default: ./har2sdk-out)
  --host <host>            Only include this host; repeatable (e.g. --host api.example.com)
  --base-url <url>         Base URL baked into the SDK (default: most common origin)
  --name <ClientName>      Name of the generated class
  --annotations <file>     Names/descriptions to apply (default: <out>/har2sdk.annotations.json)
  --examples               Embed examples in openapi.json (fake data with the recorded shape)
  --allow-leaks            Write files even if the leak guard finds a recorded value in them (default: refuse)
  --no-enums               Don't turn repeated string values into literal unions
  --no-merge               Don't merge sibling paths into {params}
  --param <pattern>        Force a path parameter, e.g. --param "/users/*" (repeatable)
  --exclude-host <host>    Drop this host (repeatable)
  --exclude-path <glob>    Drop matching paths, e.g. --exclude-path "/telemetry/*" (repeatable)
  --include-path <glob>    Keep matching paths even if they look like telemetry or static files (repeatable)
  --json                   (inspect) machine-readable output
  --copy                   (prompt) copy the prompt to the clipboard
  --delay <ms>             (mock) wait this long before each answer
  --raw                    (mock) serve recorded bodies unscrubbed (default: ids faked, personal data and secrets masked)
  --bind <address>         (mock) interface to listen on (default 127.0.0.1)
  --allow-host <name>      (mock, with --bind) also answer requests for this host name (repeatable)
  --strict, --redact       Accepted for old scripts; refusing and redacting are the default now
  -h, --help               Show this help
  -v, --version            Show version

${c.bold("Capture a HAR")}
  DevTools → Network → tick "Preserve log" → use the app → Export HAR (⤓) or right-click → "Save all as HAR".
`;

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      out: { type: "string", short: "o" },
      host: { type: "string", multiple: true },
      "base-url": { type: "string" },
      name: { type: "string" },
      annotations: { type: "string" },
      examples: { type: "boolean" },
      "no-enums": { type: "boolean" },
      "no-merge": { type: "boolean" },
      json: { type: "boolean" },
      copy: { type: "boolean" },
      port: { type: "string", short: "p" },
      redact: { type: "boolean" },
      delay: { type: "string" },
      bind: { type: "string" },
      "allow-host": { type: "string", multiple: true },
      param: { type: "string", multiple: true },
      "exclude-host": { type: "string", multiple: true },
      "exclude-path": { type: "string", multiple: true },
      "include-path": { type: "string", multiple: true },
      strict: { type: "boolean" },
      "allow-leaks": { type: "boolean" },
      raw: { type: "boolean" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  });

  if (values.version) {
    console.log(VERSION);
    return 0;
  }
  const commands = new Set(["generate", "inspect", "prompt", "mock", "mcp"]);
  const command = positionals[0] && commands.has(positionals[0]) ? positionals[0] : "generate";
  const rest = positionals[0] && commands.has(positionals[0]) ? positionals.slice(1) : positionals;
  if (values.help || (!rest.length && command !== "mcp")) {
    console.log(HELP);
    return values.help ? 0 : 1;
  }
  // Check options before reading anything: a typo should fail fast and say which option.
  if (values["base-url"] !== undefined) checkBaseUrl(values["base-url"]);
  for (const [name, max] of [["port", 65535], ["delay", 600_000]] as const) {
    const v = values[name];
    if (v !== undefined && !(/^\d+$/.test(v) && Number(v) <= max)) throw new Error(`--${name} must be a whole number from 0 to ${max} (got ${JSON.stringify(v.slice(0, 20))}).`);
  }

  if (command === "mcp") {
    const { runMcpServer } = await import("./mcp.js");
    await runMcpServer();
    return -1; // keep running
  }

  // One or more captures: `har2sdk a.har b.har` merges them into one SDK.
  const lists = [];
  for (const file of rest) {
    const harFile = resolve(file);
    if (!existsSync(harFile)) {
      console.error(c.red(`✗ File not found: ${file}`));
      return 1;
    }
    if (statSync(harFile).isDirectory()) {
      console.error(c.red(`✗ ${file} is a folder, not a HAR file. Pass the .har file inside it.`));
      return 1;
    }
    // Streamed: the file's text is never held in memory as a whole.
    lists.push(await loadHarFile(harFile));
  }
  const exchanges = mergeExchanges(lists);
  const source = rest.length === 1 ? basename(rest[0]!) : `${rest.length} captures`;
  const model = analyzeExchanges(exchanges, {
    hosts: values.host,
    excludeHosts: values["exclude-host"],
    excludePaths: values["exclude-path"],
    includePaths: values["include-path"],
    params: values.param,
    noMerge: values["no-merge"],
    source,
  });

  if (!model.endpoints.length) {
    console.error(c.yellow(noApiMessage(model, exchanges, source, values.host)));
    return 1;
  }

  const outDir = resolve(values.out ?? "har2sdk-out");
  const annotations = await loadAnnotations(values.annotations, outDir, dirname(resolve(rest[0]!)));
  if (values.name) {
    if (annotations) annotations.clientName = values.name;
  }
  const ann: Annotations | undefined = values.name && !annotations ? { clientName: values.name } : annotations;

  if (command === "inspect") {
    const plan = buildPlan(model, { annotations: ann, enums: !values["no-enums"] });
    if (values.json) {
      // Meant to be pasted into issues: recorded values are replaced.
      console.log(
        scrubText(JSON.stringify(
          {
            source,
            stats: model.stats,
            origins: model.origins,
            ...(model.primaryOriginWarning ? { primaryOriginWarning: model.primaryOriginWarning } : {}),
            auth: model.auth,
            defaultHeaders: model.defaultHeaders,
            warnings: plan.warnings,
            // Single-use words first: the leak guard can't recognise a word with no evidence (see SECURITY.md, Limits).
            pathWords: literalPathWords(plan, exchanges),
            endpoints: plan.ops.map((o) => ({
              id: o.ep.id,
              method: o.ep.method,
              path: o.ep.path,
              name: o.ep.name,
              count: o.ep.count,
              statuses: o.ep.responses.map((r) => r.status),
              graphql: o.ep.graphql ? { operationName: o.ep.graphql.operationName, operationType: o.ep.graphql.operationType } : undefined,
            })),
          },
          null,
          2,
        ), model.taint),
      );
    } else {
      printOverview(plan, source);
      if (model.primaryOriginWarning) console.log(`\n  ${c.yellow("!")} ${c.bold(stripControl(scrubText(model.primaryOriginWarning, model.taint)))}`);
      // The same notes `generate` prints (an unmatched --param, dropped telemetry…).
      if (plan.warnings.length) console.log("");
      printWarnings(plan.warnings, model.taint);
      printPathWords(renderPathWords(plan, literalPathWords(plan, exchanges), { show: visibleWord, counts: true }), model.taint);
    }
    return 0;
  }

  if (command === "prompt") {
    const plan = buildPlan(model, { annotations: ann, enums: !values["no-enums"] });
    const prompt = stripControl(renderChatPrompt(plan));
    if (values.copy) {
      const ok = await copyToClipboard(prompt);
      console.error(ok ? c.green(`✓ Copied ${kb(prompt.length)} prompt to the clipboard.`) : c.yellow("Couldn't reach the clipboard; printing instead."));
      if (!ok) console.log(prompt);
    } else console.log(prompt);
    console.error(c.dim(`\nPaste the assistant's JSON reply into ${relative(process.cwd(), join(outDir, "har2sdk.annotations.json")) || "har2sdk.annotations.json"} and run har2sdk again.`));
    return 0;
  }

  if (command === "mock") {
    let port = Number(values.port ?? 4010);
    const bind = values.bind ?? "127.0.0.1";
    const server = await listenMock(model, exchanges, {
      port,
      host: bind,
      raw: values.raw,
      // Off loopback, the Host check stays on (a page can rebind any name to this machine): the names this
      // machine answers to (its addresses, its host name) and --allow-host are accepted, nothing else.
      ...(/^(127\.0\.0\.1|localhost|::1)$/.test(bind) ? {} : { allowHosts: [...machineHosts(bind), ...(values["allow-host"] ?? [])] }),
      delay: values.delay ? Number(values.delay) : undefined,
      onRequest: ({ method, path, status, endpoint }) =>
        console.log(`${methodColor(method)} ${pad(path, 48)} ${status < 400 ? c.green(String(status)) : c.red(String(status))} ${c.dim(endpoint ?? "no match")}`),
    });
    // With --port 0 the system picks the port: print the one it picked.
    const address = server.address();
    if (address && typeof address === "object") port = address.port;
    console.log(`${c.bold("har2sdk mock")} replaying ${model.endpoints.length} endpoints from ${source}`);
    console.log(`  ${c.cyan(`http://localhost:${port}`)}   ${c.dim(`new ${clientNameFor(model, ann)}({ baseUrl: "http://localhost:${port}" })`)}`);
    if (bind !== "127.0.0.1" && bind !== "localhost") {
      console.log(c.yellow(`  ! Listening on ${bind}: anyone who can reach it can read the recorded responses.`));
      console.log(c.dim(`    Requests must name this machine (its address or host name${values["allow-host"]?.length ? ", or --allow-host" : "; add others with --allow-host"}).`));
    }
    if (values.raw) console.log(c.yellow(`  ! --raw: serving recorded bodies unscrubbed, including any tokens they contain.`));
    console.log("");
    return -1;
  }

  // generate
  const result = generateFromModel(model, exchanges, {
    annotations: ann,
    enums: !values["no-enums"],
    baseUrl: values["base-url"],
    examples: values.examples,
    source,
  });
  printOverview(result.plan, source);
  if (result.leaks.length && !values["allow-leaks"]) {
    printWarnings(result.warnings, model.taint);
    console.error(
      c.red(`\n✗ The leak guard found ${result.leaks.length} recorded value${result.leaks.length === 1 ? "" : "s"} in the output; nothing was written.`) +
        c.dim(`\n  Fix it with --param / --exclude-path / annotations, or pass --allow-leaks if you're sure (and please report a false positive).`),
    );
    const patterns = result.paramPatterns;
    if (patterns.length) {
      // The reported segments are "*" already; scrubbed like every other line, in case a literal next to one is known too.
      console.error(c.dim(`  A recorded value is a path segment. To make it a parameter, run again with:`));
      for (const p of patterns.slice(0, 5)) console.error(scrubText(`    --param "${p}"`, model.taint));
      if (patterns.length > 5) console.error(c.dim(`    … and more: fix these, then run again to see the rest.`));
    }
    return 2;
  }
  // Never overwrite a client.ts / openapi.json that har2sdk didn't write (the MCP server checks the same).
  for (const f of ["client.ts", "openapi.json"]) {
    const existing = await readFile(join(outDir, f), "utf8").catch(() => undefined);
    if (existing !== undefined && !writtenByHar2sdk(f, existing)) {
      console.error(c.red(`✗ ${join(outDir, f)} exists and wasn't generated by har2sdk; nothing was written.`) + c.dim(`\n  Choose another folder with -o, or move that file away.`));
      return 1;
    }
  }
  const written = await writeFiles(outDir, result.files);
  console.log("");
  for (const file of written) {
    const name = basename(file);
    const size = Buffer.byteLength(result.files[name]!);
    const extra =
      name === "client.ts"
        ? c.dim(`${result.plan.clientName} · ${result.plan.ops.length} methods · ${result.plan.registry.types.length} types`)
        : c.dim("OpenAPI 3.1");
    console.log(`  ${c.green("✓")} ${pad(relative(process.cwd(), file) || file, 34)} ${pad(kb(size), 9)} ${extra}`);
  }
  printWarnings(result.warnings, model.taint);
  printPathWords(renderPathWords(result.plan, literalPathWords(result.plan, exchanges), { limit: 20, show: visibleWord }), model.taint);
  // Last, where it is read: which origin gets the user's credentials (unless they chose it with --base-url).
  if (model.primaryOriginWarning && values["base-url"] === undefined) console.log(`\n  ${c.yellow("!")} ${c.bold(stripControl(scrubText(model.primaryOriginWarning, model.taint)))}`);
  const rel = relative(process.cwd(), outDir) || ".";
  const label = (s: string) => pad(c.bold(s), 14);
  console.log(`
  ${label("Use it")}import { ${result.plan.clientName} } from "./${rel.replace(/\\/g, "/")}/client.js";
  ${" ".repeat(14)}const api = new ${result.plan.clientName}(${model.auth.bearer ? "{ token: process.env.TOKEN }" : ""});
  ${label("Better names")}har2sdk prompt ${rest[0]} --copy   ${c.dim("→ paste into Claude/ChatGPT, or use the MCP server")}
  ${label("Offline API")}har2sdk mock ${rest[0]}`);
  return 0;
}

/** Why nothing was kept, and what to do about it. */
function noApiMessage(model: ApiModel, exchanges: Exchange[], source: string, hosts: string[] | undefined): string {
  const total = model.stats.entries;
  if (hosts?.length && (model.stats.dropped["host-filter"] ?? 0) > 0) {
    const counts = new Map<string, number>();
    for (const ex of exchanges) counts.set(ex.host, (counts.get(ex.host) ?? 0) + 1);
    const seen = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([h, n]) => `${h} (${n})`);
    return `None of the ${total} requests is on ${hosts.join(", ")}. Hosts in this capture: ${seen.join(", ")}. Pass one of them to --host, or leave --host out.`;
  }
  const dropped = Object.entries(model.stats.dropped).map(([k, v]) => `${v} ${k}`).join(", ");
  return (
    `No API calls found in ${source} (${total} requests, all filtered as noise${dropped ? `: ${dropped}` : ""}).\n` +
    `Tips: enable "Preserve log", use the app so it calls its API, then export again.` +
    (hosts?.length ? "" : " Use --host to target a specific API host.")
  );
}

function printOverview(plan: Plan, source: string): void {
  const { model } = plan;
  const dropped = Object.entries(model.stats.dropped)
    .sort((a, b) => b[1]! - a[1]!)
    .map(([k, v]) => `${v} ${k}`)
    .join(", ");
  console.log(`\n${c.bold("har2sdk")} ${c.dim(source)}`);
  console.log(
    `  ${model.stats.entries} requests → ${c.bold(String(model.stats.kept))} API calls → ${c.bold(String(plan.ops.length))} endpoints` +
      (dropped ? c.dim(`   (ignored: ${dropped})`) : ""),
  );
  console.log(`  ${c.dim("origin")} ${model.primaryOrigin}   ${c.dim("auth")} ${stripControl(scrubText(authSummary(model), model.taint))}\n`);
  const width = Math.min(56, Math.max(...plan.ops.map((o) => (o.ep.path + (o.ep.graphql ? ` (${o.ep.graphql.operationName})` : "")).length)) + 2);
  for (const op of plan.ops) {
    const path = op.ep.graphql ? `${op.ep.path} ${c.magenta(op.ep.graphql.operationName)}` : highlightParams(op.ep.path);
    const host = op.foreignOrigin ? c.dim(new URL(op.foreignOrigin).host) : "";
    // Redacted like `inspect --json`: a refused run's overview would otherwise print the very value it refused.
    console.log(scrubText(`  ${methodColor(op.ep.method)} ${host}${pad(path, width)} ${pad(c.cyan(op.ep.name), 28)} ${c.dim("×" + op.ep.count)}`, model.taint));
  }
}

/** A warning line, redacted like `inspect --json` (a dropped request's path can hold a known username). */
function printWarnings(warnings: readonly string[], taint: Taint): void {
  for (const w of warnings) console.log(scrubText(`  ${c.yellow("!")} ${w}`, taint));
}

/** The path-word section (see pathwords.ts); its words are already escaped by {@link visibleWord}. */
function printPathWords(lines: string[], taint: Taint): void {
  if (!lines.length) return;
  const [head, ...rest] = lines;
  console.log(`\n  ${c.bold(head!)}`);
  // Words the guard knows are redacted; the others (the ones the user must judge) are shown as they are.
  for (const l of rest) console.log(scrubText(`  ${l.startsWith("  A word") ? c.dim(l) : l}`, taint));
}

function highlightParams(path: string): string {
  return path.replace(/\{[^}]+\}/g, (m) => c.yellow(m));
}

async function loadAnnotations(file: string | undefined, outDir: string, harDir?: string): Promise<Annotations | undefined> {
  // Default: next to the output; else where the MCP server writes it (next to the HAR).
  let path = file ? resolve(file) : join(outDir, "har2sdk.annotations.json");
  if (!file && !existsSync(path) && harDir && existsSync(join(harDir, "har2sdk-out", "har2sdk.annotations.json"))) {
    path = join(harDir, "har2sdk-out", "har2sdk.annotations.json");
  }
  if (!existsSync(path)) {
    if (file) throw new Error(`Annotations file not found: ${file}`);
    return undefined;
  }
  try {
    const ann = parseAnnotations(await readFile(path, "utf8"));
    // Found by default, not named with --annotations: say so, since the file may have come with the capture.
    if (!file) console.error(c.dim(`  Using annotations from ${stripControl(relative(process.cwd(), path) || path)} (names, descriptions, renames).`));
    return ann;
  } catch (err) {
    throw new Error(`Couldn't read ${path}: ${(err as Error).message}`);
  }
}

function copyToClipboard(text: string): Promise<boolean> {
  const candidates: [string, string[]][] =
    process.platform === "darwin"
      ? [["pbcopy", []]]
      : process.platform === "win32"
        ? [["clip", []]]
        : [
            ["wl-copy", []],
            ["xclip", ["-selection", "clipboard"]],
            ["xsel", ["--clipboard", "--input"]],
          ];
  return candidates.reduce<Promise<boolean>>(
    (prev, [cmd, args]) =>
      prev.then(
        (ok) =>
          ok ||
          new Promise<boolean>((done) => {
            const child = spawn(cmd, args, { stdio: ["pipe", "ignore", "ignore"] });
            child.on("error", () => done(false));
            child.on("close", (code) => done(code === 0));
            child.stdin.end(text);
          }),
      ),
    Promise.resolve(false),
  );
}

// The MCP server speaks JSON-RPC on stdout (JSON escapes control characters itself).
if (process.argv[2] !== "mcp") guardTerminal();

main(process.argv.slice(2)).then(
  (code) => {
    if (code >= 0) process.exitCode = code;
  },
  (err) => {
    if (err instanceof HarError) console.error(c.red("✗ " + err.message));
    else if (err?.code === "ERR_PARSE_ARGS_UNKNOWN_OPTION") console.error(c.red("✗ " + err.message) + "\n" + HELP);
    else console.error(c.red("✗ " + (err?.message ?? String(err))));
    process.exitCode = 1;
  },
);

/** The host names a request to this machine can carry: the bound address, every interface address, the host name. */
function machineHosts(bind: string): string[] {
  const out = new Set<string>();
  if (!/^(0\.0\.0\.0|::|\[::\])$/.test(bind)) out.add(bind.toLowerCase());
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) out.add(a.family === "IPv6" ? `[${a.address.toLowerCase()}]` : a.address);
  }
  const name = hostname().toLowerCase();
  out.add(name);
  if (!name.includes(".")) out.add(name + ".local");
  return [...out];
}
