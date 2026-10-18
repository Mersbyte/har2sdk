import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { HarEntry } from "../src/har.js";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const DEMO_HAR_PATH = join(ROOT, "examples/demo-shop/acme-shop.har");
export const demoHar = (): string => readFileSync(DEMO_HAR_PATH, "utf8");

/** Secrets that appear in the demo capture and must never leak into outputs. */
export const DEMO_SECRETS = [
  "hunter2-super-secret", // login password
  "rt_9f8a7c6b5d4e3f2a1b0c9d8e7f6a5b4c3d2e1f0a", // refresh token
  "Zm9vYmFyYmF6cXV4c2lnbmF0dXJlZGVtbw", // JWT signature
  "abc123def456ghi789", // session cookie value
];

interface EntryInit {
  method?: string;
  url: string;
  status?: number;
  reqHeaders?: Record<string, string>;
  reqBody?: unknown;
  reqMime?: string;
  resBody?: unknown;
  resMime?: string;
  resText?: string;
  base64?: boolean;
  resourceType?: string;
}

/** Build a Chrome-DevTools-style HAR entry. */
export function entry(init: EntryInit): HarEntry {
  const reqMime = init.reqMime ?? "application/json";
  const resMime = init.resMime ?? "application/json; charset=utf-8";
  let text = init.resText ?? (init.resBody === undefined ? undefined : JSON.stringify(init.resBody));
  if (text !== undefined && init.base64) text = Buffer.from(text).toString("base64");
  const headers = Object.entries(init.reqHeaders ?? {}).map(([name, value]) => ({ name, value }));
  return {
    startedDateTime: "2026-10-17T10:00:00.000Z",
    request: {
      method: init.method ?? "GET",
      url: init.url,
      headers,
      queryString: [],
      ...(init.reqBody !== undefined
        ? { postData: { mimeType: reqMime, text: typeof init.reqBody === "string" ? init.reqBody : JSON.stringify(init.reqBody) } }
        : {}),
    },
    response: {
      status: init.status ?? 200,
      headers: [{ name: "Content-Type", value: resMime }],
      content: { mimeType: resMime, size: text?.length ?? 0, ...(text !== undefined ? { text } : {}), ...(init.base64 ? { encoding: "base64" } : {}) },
    },
    _resourceType: init.resourceType ?? "fetch",
  };
}

export function har(entries: HarEntry[]): string {
  return JSON.stringify({ log: { version: "1.2", creator: { name: "WebInspector", version: "537.36" }, entries } });
}
