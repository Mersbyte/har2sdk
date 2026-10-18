#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { clientNameFor, parseAnnotations, type Annotations } from "./annotations.js";
import { VERSION } from "./codegen.js";
import { HarError, type Exchange } from "./har.js";
import { generateFromModel, writeFiles } from "./index.js";
import { listenMock } from "./mock.js";
import { analyzeExchanges, type ApiModel } from "./model.js";
import { loadHarFile, mergeExchanges } from "./har.js";
import { buildPlan, checkBaseUrl, type Plan } from "./plan.js";
import { authSummary, renderChatPrompt } from "./summary.js";
import { scrubText } from "./leak.js";
import { c, guardTerminal, kb, methodColor, pad, stripControl } from "./term.js";

const HELP = `
${c.bold("har2sdk")} ${c.dim("v" + VERSION)} — turn browser network traffic into a typed TypeScript SDK.

${c.bold("Usage")}
  har2sdk <capture.har…> [options]         Generate client.ts + openapi.json (several captures are merged)
  har2sdk inspect <capture.har>            List the endpoints that were found
  har2sdk prompt <capture.har> [--copy]    Print a prompt to paste into any AI chat for better names
  har2sdk mock <capture.har> [--port 4010] Replay recorded responses as a local API
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
  --raw                    (mock) serve recorded bodies unscrubbed (default: ids faked, personal data and secrets masked)
  --bind <address>         (mock) interface to listen on (default 127.0.0.1)
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
            auth: model.auth,
            defaultHeaders: model.defaultHeaders,
            warnings: plan.warnings,
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
      // The same notes `generate` prints (an unmatched --param, dropped telemetry…).
      if (plan.warnings.length) console.log("");
      for (const w of plan.warnings) console.log(`  ${c.yellow("!")} ${w}`);
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
    const port = Number(values.port ?? 4010);
    const bind = values.bind ?? "127.0.0.1";
    await listenMock(model, exchanges, {
      port,
      host: bind,
      raw: values.raw,
      ...(/^(127\.0\.0\.1|localhost|::1)$/.test(bind) ? {} : { allowHosts: ["*"] }),
      delay: values.delay ? Number(values.delay) : undefined,
      onRequest: ({ method, path, status, endpoint }) =>
        console.log(`${methodColor(method)} ${pad(path, 48)} ${status < 400 ? c.green(String(status)) : c.red(String(status))} ${c.dim(endpoint ?? "no match")}`),
    });
    console.log(`${c.bold("har2sdk mock")} replaying ${model.endpoints.length} endpoints from ${source}`);
    console.log(`  ${c.cyan(`http://localhost:${port}`)}   ${c.dim(`new ${clientNameFor(model, ann)}({ baseUrl: "http://localhost:${port}" })`)}`);
    if (bind !== "127.0.0.1" && bind !== "localhost") console.log(c.yellow(`  ! Listening on ${bind}: anyone on your network can read the recorded responses.`));
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
    for (const w of result.warnings) console.log(`  ${c.yellow("!")} ${w}`);
    console.error(
      c.red(`\n✗ The leak guard found ${result.leaks.length} recorded value${result.leaks.length === 1 ? "" : "s"} in the output; nothing was written.`) +
        c.dim(`\n  Fix it with --param / --exclude-path / annotations, or pass --allow-leaks if you're sure (and please report a false positive).`),
    );
    return 2;
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
  for (const w of result.warnings) console.log(`  ${c.yellow("!")} ${w}`);
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
  console.log(`  ${c.dim("origin")} ${model.primaryOrigin}   ${c.dim("auth")} ${authSummary(model)}\n`);
  const width = Math.min(56, Math.max(...plan.ops.map((o) => (o.ep.path + (o.ep.graphql ? ` (${o.ep.graphql.operationName})` : "")).length)) + 2);
  for (const op of plan.ops) {
    const path = op.ep.graphql ? `${op.ep.path} ${c.magenta(op.ep.graphql.operationName)}` : highlightParams(op.ep.path);
    const host = op.foreignOrigin ? c.dim(new URL(op.foreignOrigin).host) : "";
    console.log(`  ${methodColor(op.ep.method)} ${host}${pad(path, width)} ${pad(c.cyan(op.ep.name), 28)} ${c.dim("×" + op.ep.count)}`);
  }
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
    return parseAnnotations(await readFile(path, "utf8"));
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
