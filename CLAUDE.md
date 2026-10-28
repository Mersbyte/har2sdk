# har2sdk — notes for Claude

har2sdk turns a browser HAR capture into a typed, zero-dependency TypeScript client (`client.ts`), an OpenAPI 3.1 spec, a mock server and an MCP server. Everything runs locally and needs no API key.

## Commands

- `npm install`
- `npm test`: build (tsc) + vitest. Every test must pass before a commit.
- `HAR2SDK_FUZZ_SEEDS=1000 npx vitest run test/privacy-fuzz.test.ts`: the long privacy run. Run it after any change to `leak.ts`, `redact.ts`, `template.ts`, `infer.ts`, `types.ts` or `mock.ts`.
- `node dist/cli.js examples/demo-shop/acme-shop.har -o /tmp/out`: the demo end to end.

## Toolchain

- TypeScript 7 (native). It has no JS API, so `ts.transpileModule` is not available. Vitest imports `.ts` files directly.
- Node 20+.
- Generated code must pass `strict`, `exactOptionalPropertyTypes` and `erasableSyntaxOnly`.

## Map of `src/`

| File | Role |
|---|---|
| `har.ts` | Parse HAR 1.2 into `Exchange`s |
| `filter.ts` | Separate noise and trackers from API calls |
| `template.ts` | Path templating (`/users/{userId}`) |
| `infer.ts` | Shapes from JSON samples |
| `types.ts` | Named types, enums, aliases |
| `model.ts` | Pipeline: GraphQL / JSON-RPC / tRPC, auth, headers |
| `plan.ts` | Generation plan |
| `codegen.ts` | `client.ts` emitter |
| `openapi.ts` | OpenAPI 3.1 emitter |
| `leak.ts` | Leak guard: taint, identities, scanning |
| `redact.ts` | Secret and PII rules, `Scrubber` (fake data for mock and `--examples`) |
| `mock.ts` | Mock server |
| `mcp.ts` | MCP server |
| `cli.ts` | CLI |

## Rules

- **Privacy is the product.** No recorded value may reach `client.ts`, `openapi.json`, prompts, MCP responses, `inspect --json` or default mock responses. Read SECURITY.md before changing anything in the pipeline.
  - A privacy fix must be general, never tuned to one example input.
  - A privacy fix must not break correct output. `test/fixtures/demo-snapshot.json` pins the demo's endpoints and types. Update it only on purpose, and say why in the commit message.
- **Never commit real HAR files.** `.gitignore` blocks `*.har` except `examples/`. Never ask a user for a HAR: ask for `har2sdk inspect --json` output instead.
- **Claims in README / SECURITY / CHANGELOG must match the code.** Each external review found overstated claims; keep them honest.
- **Tests for review findings** go in `test/reviewN.test.ts`, one describe block per finding, using the reviewer's input. Also add a generated (fuzz) variant where possible.
- **Branches.** Work on a branch and open a PR. Don't push to `main` directly.

## History

Fifteen reviews so far, at v0.1, v0.3, v0.4, v0.5, two at v0.6.0 (a pre-release security audit), one at v0.6.1 (an end-to-end audit), one at v0.6.2 (the last audit before publishing), two at v0.6.4 (CodeQL's regex alerts, then the ones it still flagged) one at v0.6.5 (before launch: non-Latin scripts and the mock's free-text regexes) one at v0.6.6 (names in parts, GraphQL decimals, digits of any script, deep nesting) one at v0.6.7 (an email's local part, a quadratic slug pass), one at v0.6.8 (Codex Security: short and multi-part usernames, escaped keys, protocol keys in REST bodies, three mock leaks, two cubic loops) and one at v0.6.9 (Claude Code: evidence in dropped requests and in carriers the collector didn't parse, dropped paths in warnings, short-name slugs, bare strings in the mock, a quadratic scrub, and OpenAPI / codegen integrity). Their findings and fixes are in CHANGELOG.md and `test/review*.test.ts`. The recurring lesson: heuristics fixed against one reviewer's inputs failed on the next reviewer's new inputs. Prefer evidence from the capture itself, such as how a value is used elsewhere in it, over judging a value by its shape.
