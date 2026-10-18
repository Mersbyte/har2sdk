/**
 * Human/LLM-readable renderings of a plan: an endpoint list, per-endpoint
 * detail, and a "paste into any chat" prompt. Everything here is redacted.
 */
import { generateTypesOnly } from "./codegen.js";
import { scrubText } from "./leak.js";
import type { ApiModel } from "./model.js";
import type { Plan, PlannedOp } from "./plan.js";
import { printTs } from "./types.js";

export function authSummary(model: ApiModel): string {
  const a = model.auth;
  const parts: string[] = [];
  if (a.bearer) parts.push(a.bearerIsJwt ? "Bearer JWT" : "Bearer token");
  if (a.basic) parts.push("HTTP basic");
  if (a.apiKeyHeaders.length) parts.push(`API key header (${a.apiKeyHeaders.join(", ")})`);
  if (a.apiKeyQuery.length) parts.push(`API key query param (${a.apiKeyQuery.join(", ")})`);
  if (a.cookieNames.length) parts.push(`cookies (${a.cookieNames.slice(0, 5).join(", ")}${a.cookieNames.length > 5 ? ", …" : ""})`);
  if (a.csrfHeaders.length) parts.push(`CSRF header (${a.csrfHeaders.join(", ")})`);
  return parts.length ? parts.join(", ") : "none detected";
}

export function signature(op: PlannedOp): string {
  const args: string[] = [];
  const ps = [...op.pathParams, ...op.queryParams].map((p) => `${p.name}${p.required ? "" : "?"}: ${printTs(p.type)}`);
  if (op.ep.graphql) args.push(`variables: ${op.body?.typeName ?? "{}"}`);
  else if (op.ep.rpc) {
    if (ps.length) args.push(`{ ${ps.join("; ")} }`);
    if (op.body) args.push(`input: ${op.body.typeName}`);
  } else {
    if (ps.length) args.push(`{ ${ps.join("; ")} }`);
    if (op.body) args.push(`body: ${op.body.typeName}`);
  }
  return `${op.ep.name}(${args.join(", ")}): ${op.response.typeName}`;
}

export function renderEndpointList(plan: Plan): string {
  const { model } = plan;
  const lines: string[] = [];
  lines.push(
    `Source: HAR capture · ${model.stats.entries} requests recorded, ${model.stats.kept} kept as API calls, ${plan.ops.length} endpoints`,
    `Origin: ${model.primaryOrigin}${model.origins.length > 1 ? ` (+ ${model.origins.slice(1).map((o) => o.origin).join(", ")})` : ""}`,
    `Auth: ${authSummary(model)}`,
  );
  const dropped = Object.entries(model.stats.dropped).map(([k, v]) => `${v} ${k}`);
  if (dropped.length) lines.push(`Ignored: ${dropped.join(", ")}`);
  if (Object.keys(model.defaultHeaders).length) lines.push(`Default headers: ${Object.keys(model.defaultHeaders).join(", ")}`);
  lines.push("", "| id | seen | status | SDK method |", "|---|---|---|---|");
  for (const op of plan.ops) {
    const statuses = [...new Set(op.ep.responses.map((r) => r.status))].join(",");
    lines.push(`| \`${safe(op.ep.id)}\` | ${op.ep.count} | ${statuses} | \`${signature(op)}\` |`);
  }
  // Everything here may be shown to a language model: recorded values are replaced.
  return scrubText(lines.join("\n"), model.taint);
}

export function renderEndpointDetail(plan: Plan, op: PlannedOp): string {
  const { ep } = op;
  const lines = [`## ${safe(ep.id)}`, ``, `SDK: \`${signature(op)}\``, `Seen ${ep.count}× · responses: ${ep.responses.map((r) => `${r.status} (${r.count}×${r.kind ? ", " + r.kind : ""})`).join(", ")}`];
  if (ep.description) lines.push(`Description: ${ep.description}`);
  if (ep.rpc) lines.push(`${ep.rpc.kind === "trpc" ? "tRPC" : "JSON-RPC"} procedure ${ep.rpc.procedure}${ep.rpc.superjson ? " (superjson)" : ""}`);
  if (ep.graphql) {
    lines.push(`GraphQL ${ep.graphql.operationType} ${ep.graphql.operationName}${ep.graphql.persistedHash ? " (persisted query)" : ""}`);
    if (ep.graphql.query) lines.push("```graphql", truncate(ep.graphql.query.trim().replace(/```/g, "'''"), 1500), "```");
  }
  // Only names and types are shown: recorded values never reach the model.
  for (const p of op.pathParams) lines.push(`Path param \`${safe(p.name)}\`: ${printTs(p.type)}`);
  for (const q of op.queryParams) lines.push(`Query param \`${safe(q.wire)}\`${q.required ? "" : " (optional)"}: ${printTs(q.type)}`);
  lines.push("", "Types:", "```ts", generateTypesOnly(plan, [op]), "```");
  return scrubText(lines.join("\n"), plan.model.taint);
}

export const ANNOTATION_FORMAT = `{
  "clientName": "ExampleClient",
  "endpoints": {
    "<endpoint id exactly as listed>": {
      "name": "camelCaseMethodName",
      "description": "One sentence on what it does.",
      "tag": "group",
      "params": { "oldParamName": "betterName" }
    }
  },
  "types": { "GeneratedTypeName": "BetterTypeName" }
}`;

/** A self-contained prompt for any chat assistant (no API key, no MCP needed). */
export function renderChatPrompt(plan: Plan): string {
  const parts = [
    `I captured my browser's network traffic and ran it through har2sdk, which inferred the API below.`,
    `Please review it and reply with ONLY a JSON object (no prose) that improves naming, in this format:`,
    "",
    "```json",
    ANNOTATION_FORMAT,
    "```",
    "",
    `Rules: keep endpoint ids exactly as written; method names are camelCase verbs (getX, listX, createX, updateX, deleteX, or a clear action like cancelOrder); `,
    `only include fields you want to change; describe what each endpoint does based on its path, params and types; rename generic types (e.g. Item2, GetFooResponse) to domain names.`,
    "",
    "## Endpoints",
    "",
    renderEndpointList(plan),
    "",
    "## Inferred types",
    "",
    "```ts",
    generateTypesOnly(plan),
    "```",
  ];
  return scrubText(parts.join("\n"), plan.model.taint);
}

/**
 * Text that came from a HAR (paths, names) is data, not instructions: make
 * control characters visible and keep it on one line so it can't pose as
 * part of the prompt around it.
 */
export function safe(s: string): string {
  return s.replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`).replace(/`/g, "'").slice(0, 300);
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "\n… (truncated)" : s;
}
