# Demo: Acme Shop

`acme-shop.har` was recorded by a real Chromium (via Playwright) clicking through a tiny fake shop (`server.mjs`). Every value in it is made up — including the password, JWT and session cookie, which exist so the test-suite can prove they never reach the generated files.

```bash
npx har2sdk examples/demo-shop/acme-shop.har     # generate
npx har2sdk mock examples/demo-shop/acme-shop.har  # replay it on :4010
```

What's inside: login with a JWT, cookies, paginated lists, nested resources, slug-based URLs (`/stores/istanbul-kadikoy`), a 404, form posts, a 204 DELETE, two GraphQL operations, analytics beacons and static assets to be filtered out.

Re-record: `node server.mjs 80 &` then `node record.mjs` (needs Playwright and port 80 so the page can live at `http://acme-shop.test`). `--browser firefox|webkit`, `--mode minimal`, `--out <file>` and `--executable <browser binary>` record the variants in `test/fixtures/browsers/`.
