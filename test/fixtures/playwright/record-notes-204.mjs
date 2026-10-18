// Records test/fixtures/playwright/notes-204.har: a fake notes app whose page reads the
// bodies of 204 responses (Playwright 1.56 then stores them as text: "", encoding: "base64",
// with no _resourceType) and revalidates with a 304.
// Needs Playwright 1.56 (npm i playwright@1.56.1): node record-notes-204.mjs <out.har>
import { createServer } from "node:http";
import { chromium } from "playwright";
const page = `<!doctype html><title>Notes</title><script>
(async () => {
  const j = (r) => r.json();
  await fetch("/api/notes").then(j);
  await fetch("/api/notes/n_4f9a2c/pin", { method: "PUT" }).then((r) => r.text());
  await fetch("/api/notes/n_4f9a2c", { method: "DELETE" }).then((r) => r.text());
  await fetch("/api/session/ping").then((r) => r.text());
  await fetch("/api/notes", { headers: { "if-none-match": '"v1"' } }).then((r) => r.text());
  window.__done = true;
})();
</script>`;
const server = createServer((req, res) => {
  if (req.url === "/") { res.writeHead(200, { "content-type": "text/html" }); return res.end(page); }
  if (req.url === "/api/notes" && req.headers["if-none-match"] === '"v1"') { res.writeHead(304, { etag: '"v1"' }); return res.end(); }
  if (req.url === "/api/notes") { res.writeHead(200, { "content-type": "application/json", etag: '"v1"', "cache-control": "no-cache" }); return res.end(JSON.stringify([{ id: "n_4f9a2c", title: "Groceries", pinned: false }])); }
  res.writeHead(204); res.end();
});
server.listen(0, async () => {
  const port = server.address().port;
  const browser = await chromium.launch({ args: ["--host-resolver-rules=MAP notes.test 127.0.0.1"] });
  const context = await browser.newContext({ recordHar: { path: process.argv[2], content: "embed" } });
  const p = await context.newPage();
  await p.goto(`http://notes.test:${port}/`);
  await p.waitForFunction(() => window.__done === true, null, { timeout: 15000 });
  await context.close(); await browser.close(); server.close();
  console.log("ok", port);
});
