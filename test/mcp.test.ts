import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMcpServer } from "../src/mcp.js";
import { DEMO_HAR_PATH, DEMO_SECRETS } from "./helpers.js";

describe("MCP server", () => {
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
    const res = (await client.callTool({ name, arguments: args })) as { content: { type: string; text: string }[]; isError?: boolean };
    return { text: res.content.map((c) => c.text).join("\n"), isError: !!res.isError };
  };

  it("exposes three tools and a prompt", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["analyze_har", "generate_sdk", "inspect_endpoint"]);
    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name)).toEqual(["har_to_sdk"]);
  });

  it("analyze_har lists endpoints without secrets", async () => {
    const { text, isError } = await call("analyze_har", { har_path: DEMO_HAR_PATH });
    expect(isError).toBe(false);
    expect(text).toContain("`GET /api/v1/products/{productId}`");
    expect(text).toContain("getProduct({ productId: number }): GetProductResponse");
    for (const s of DEMO_SECRETS) expect(text).not.toContain(s);
  });

  it("inspect_endpoint shows types but no recorded values", async () => {
    const { text } = await call("inspect_endpoint", { har_path: DEMO_HAR_PATH, endpoint_id: "POST /api/v1/auth/login" });
    expect(text).toContain("export interface LoginBody");
    expect(text).toContain("password: string;");
    expect(text).not.toContain("hunter2");
    for (const s of DEMO_SECRETS) expect(text).not.toContain(s);
    expect(text).not.toContain("demo@acme-shop.test");
  });

  it("inspect_endpoint reports unknown ids helpfully", async () => {
    const { text, isError } = await call("inspect_endpoint", { har_path: DEMO_HAR_PATH, endpoint_id: "GET /nope" });
    expect(isError).toBe(true);
    expect(text).toContain("GET /api/v1/me");
  });

  it("generate_sdk applies and persists annotations", async () => {
    const out = mkdtempSync(join(tmpdir(), "har2sdk-mcp-"));
    const first = await call("generate_sdk", {
      har_path: DEMO_HAR_PATH,
      out_dir: out,
      annotations: {
        clientName: "AcmeShop",
        endpoints: { "POST /api/v1/newsletter": { name: "subscribeNewsletter", description: "Subscribe to the newsletter." } },
      },
    });
    expect(first.isError).toBe(false);
    expect(first.text).toContain("subscribeNewsletter(body: SubscribeNewsletterBody)");

    // A second call only adds a description; the earlier rename must survive.
    await call("generate_sdk", {
      har_path: DEMO_HAR_PATH,
      out_dir: out,
      annotations: { endpoints: { "GET /api/v1/me": { description: "The signed-in user." } } },
    });
    const code = readFileSync(join(out, "client.ts"), "utf8");
    expect(code).toContain("export class AcmeShop {");
    expect(code).toContain("async subscribeNewsletter(");
    expect(code).toContain("The signed-in user.");
    const ann = JSON.parse(readFileSync(join(out, "har2sdk.annotations.json"), "utf8"));
    expect(Object.keys(ann.endpoints).sort()).toEqual(["GET /api/v1/me", "POST /api/v1/newsletter"]);
  });

  it("returns a tool error for missing files", async () => {
    const { isError, text } = await call("analyze_har", { har_path: "/does/not/exist.har" });
    expect(isError).toBe(true);
    expect(text).toMatch(/ENOENT|no such file/);
  });
});

describe("MCP over stdio (the real binary)", () => {
  it("starts with `har2sdk mcp` and answers tools/list", async () => {
    const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
    const { ROOT } = await import("./helpers.js");
    const transport = new StdioClientTransport({ command: process.execPath, args: [join(ROOT, "dist/cli.js"), "mcp"], stderr: "ignore" });
    const c = new Client({ name: "stdio-test", version: "0.0.0" });
    await c.connect(transport);
    const { tools } = await c.listTools();
    expect(tools).toHaveLength(3);
    const res = (await c.callTool({ name: "analyze_har", arguments: { har_path: DEMO_HAR_PATH } })) as { content: { text: string }[] };
    expect(res.content[0]!.text).toContain("18 endpoints");
    await c.close();
  });
});
