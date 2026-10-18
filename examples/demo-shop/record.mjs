// Records the demo shop with a real browser via Playwright.
// Needs Playwright (npm i -D playwright && npx playwright install chromium) and the server on port 80:
//   sudo node examples/demo-shop/server.mjs 80 &
//   node examples/demo-shop/record.mjs                      # → examples/demo-shop/acme-shop.har (Chromium)
//   node examples/demo-shop/record.mjs --browser firefox --out /tmp/ff.har --mode minimal
// Options: [port] --browser chromium|firefox|webkit, --out <file>, --mode full|minimal,
//          --executable <path> (a browser binary Playwright didn't download, e.g. a headless shell).
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import * as playwright from "playwright";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { browser: { type: "string", default: "chromium" }, out: { type: "string" }, mode: { type: "string", default: "full" }, executable: { type: "string" } },
});
const port = Number(positionals[0] ?? 80);
const out = values.out ? resolve(values.out) : join(dirname(fileURLToPath(import.meta.url)), "acme-shop.har");
const type = playwright[values.browser];
if (!type) throw new Error(`Unknown browser "${values.browser}" (chromium, firefox or webkit)`);

// Serve the demo under a realistic host name. Only Chromium can map host names
// with a flag; Firefox gets a pref; WebKit records against localhost.
const host = values.browser === "webkit" ? `localhost:${port}` : `acme-shop.test${port === 80 ? "" : `:${port}`}`;
const browser = await type.launch({
  ...(values.executable ? { executablePath: values.executable } : {}),
  ...(values.browser === "chromium" ? { args: [`--host-resolver-rules=MAP acme-shop.test 127.0.0.1`] } : {}),
  ...(values.browser === "firefox" ? { firefoxUserPrefs: { "network.dns.forceResolve": "127.0.0.1" } } : {}),
});
const context = await browser.newContext({ recordHar: { path: out, content: "embed", mode: values.mode } });
// Pretend analytics exist without touching the network.
await context.route(/google-analytics\.com/, (route) => route.fulfill({ status: 204, body: "" }));
const page = await context.newPage();
await page.goto(`http://${host}/`);
await page.waitForFunction(() => window.__done === true, null, { timeout: 15000 });
await context.close();
await browser.close();
console.log("wrote", out);
