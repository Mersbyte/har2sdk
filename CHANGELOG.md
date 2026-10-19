# Changelog

## 0.6.3

Fixes from an eighth review, the last audit before publishing. Every finding has a test in `test/review8.test.ts` (written first and seen failing), and the second suite of the generated privacy test puts the person's name in a GraphQL comment and in a free-text `operationName`.

**Security**
- What a model sees showed GraphQL `#` comments and free-text `operationName`s from the capture as they were: room for a planted prompt injection. Comments are removed from the documents shown (and ignored when an operation is analysed: a leading comment used to hide its name and put its words into the endpoint id), an `operationName` that isn't a GraphQL Name makes the operation anonymous, and the endpoint list, every endpoint's detail and the chat prompt say that what comes from the capture is untrusted data (F1).
- Regexes that were quadratic on long runs (`words()` on 40 KB of capitals: seconds; an XML tag with a 40 KB name run) could stall the CLI, the MCP server and the mock. `words()` reads at most 256 characters; the XML attribute pattern is anchored so it stays linear. A capture with such values now takes milliseconds. The mock reads request bodies up to 10 MB and answers 413 to bigger ones (F2).
- Parallel `generate_sdk` calls on one folder could lose annotations (read-merge-write) or leave a `client.ts` and an `openapi.json` from different calls. The MCP server runs them one at a time per folder (F3).

**Correct output**
- Two types renamed to the same name by annotations were merged silently by TypeScript; the second rename is refused with a warning (F5).
- A query parameter named `constructor`, `toString` or another `Object.prototype` member broke the client's types (`params = {}` has them); its SDK name gets a `Query` suffix, the wire name stays (F5).

**Packaging**
- `package.json` has `publishConfig: { access: "public", provenance: true }` (F4). With provenance, `npm publish` must run in CI with an OIDC token (e.g. GitHub Actions with `id-token: write`); a local publish needs `--provenance=false`.

## 0.6.2

Fixes from a seventh review, an end-to-end "does it work" audit of 0.6.1. Every finding has a test in `test/review7.test.ts` (written first and seen failing), and the generated privacy test gained one placement type (30 in all).

**Behaviour changes to know about**
- Responses with status 204 or 205 and no body are API calls even when nothing else says so; a 304 or an empty, untyped answer joins the endpoint the capture shows elsewhere, and is otherwise skipped with a warning (E1).
- Annotation files are checked against their format; a wrong type is an error that names the field (E4).
- Usage hints import `./har2sdk-out/client.js`, which works under NodeNext as well as bundlers (E8).
- A truncated HAR file, an empty one, a folder, entries that aren't requests and a `--host` that matches nothing each get their own error message (E11).
- For the library: `loadHar`, `loadHarFile` and `parseHarText` throw a `HarError` for a capture with no entries, or with no entry that is a request/response pair, instead of returning an empty list (E11).

**Correct output**
- A 204 the page had read (Playwright stores it as `text: "", encoding: "base64"`, without `_resourceType`) was dropped as noise, and its endpoint was missing from the SDK (E1). Fixture: `test/fixtures/playwright/notes-204.har`, a real Playwright 1.56.1 recording.
- A multipart upload whose body the browser left out had no body parameter; it gets a `FormData` one, and a missing request body gets a warning like a missing response body (E3).
- `--base-url` is checked before anything is generated (E9); JSON nested deeper than 200 levels is treated as unparsed instead of overflowing the stack (E10).
- `inspect` prints the same warnings as `generate`, e.g. a `--param` that matched nothing (E12).

**Leaks closed**
- A username in the file name of a URL (`avatars/<user>.png`, `<user>_avatar.jpg`, `<first>-<last>-cover.webp`) stayed in the mock's responses and in `--examples`. The scrubber now fakes recorded names inside file names. The leak guard reads `--examples` again: 0.6.0 (C17) had left the examples out because they keep timestamps on purpose, and that hid this leak; now only recorded dates and timestamps are exempt there (E2).

**Tests and docs**
- The MCP server not overwriting a foreign `client.ts`, refusing to write when the leak guard finds a value, and the mock listening only on `127.0.0.1` had no test; each has one now, checked by breaking the code on purpose (E6).
- The privacy fuzz test runs the real CLI's `inspect --json` and a real MCP session on every seed, not only the first four (that was a speed limit in the test, not a bug) (E13).
- README: the example's type comments are compiled against the demo's client in a test; `getOrder().status` is a plain `string` in the demo (only two values recorded), so the enum example is `listOrders` now; the annotation example names the class the code imports (E5, E8). README and LAUNCH.md numbers are checked against the repo (E7).
- Removed three unused functions (`templateToRegExp`, `isEmptyShape`, `topLevelKeys`) (E14).

## 0.6.1

Fixes from a sixth review, a pre-release security audit of 0.6.0. Every finding has a test in `test/review6.test.ts` (written first and seen failing), and the generated privacy test gained three placement types (29 in all) and a second suite that checks the readable outputs where the files are refused.

**Security**
- The MCP server wrote through symbolic links: a `har2sdk-out/har2sdk.annotations.json` linked to `~/.bashrc` in a downloaded capture's folder was overwritten (with an annotation description the shell would run). The MCP server and the CLI now refuse a linked output folder or file, the MCP server also a linked folder on the way and an output folder whose real path is outside the allowed ones; files are written under a temporary name and renamed into place (A1)
- Control characters from a capture (an OSC 52 "write to clipboard" sequence in a GraphQL operation name) reached the terminal. The CLI now filters everything it prints, the prompt it copies and MCP responses (A5)

**Leaks closed**
- The chat prompt, MCP responses and `inspect --json` showed slugs and host names spelling a recorded name (`/api/u/zeynep-ak/settings`, `zeynep-ak.s3.amazonaws.com`) that the scanner had found in `client.ts`. `<redacted>` now covers every form the scanner reports, including percent-encoded text and names a singular form shortened (A2)
- A word of a recorded personal name became an enum member under `type`, `kind` or `channel` (`"zeynep"` next to `fullName: "Zeynep Ak"`), and the mock served it. Such words are no longer vocabulary (A3)
- Random tokens without digits (`/password-reset/KfTqLmZxRwPbNvYc/confirm`, `/videos/dQwUvXyZaBc`, `/meet/xkq-bvzt-rmn`) stayed path literals. Random-looking letter-only tokens are ids now, judged by rare letter pairs and case flips; words, acronyms and camel-case names are not (A4)

**Robustness**
- A JSON key `constructor` or `__proto__` crashed the generator, the mock and the MCP server; such keys are now ordinary properties everywhere, also in the mock's output (A6)

**Docs**
- SECURITY.md and README describe the link checks, the terminal filter, the redaction of every scanned form and the limits of the random-token heuristic. The long privacy run is 1,000 seeds, as the commands say (the README said 3,000).

## 0.6.0

Fixes from a fifth review — an adversarial audit of the 0.5.0 leak guard and scrubber with new input shapes and synthetic GitHub-, Stripe-, Shopify-, Slack- and Jira-like captures — plus a streaming reader for large captures and release preparation. Every finding has a test in `test/review5.test.ts`; the generated privacy test gained 12 placement types (26 in all; 3,000 seeds pass). The report, in Turkish, is `docs/REPORT-0.6.0.md`.

**Behaviour changes to know about**
- The HAR file's name is no longer written into `client.ts`, `openapi.json` or the chat prompt.
- One-word names of things (a category `"Books"`) are no longer reported by the leak guard; see SECURITY.md.
- `mock --raw` re-serialises JSON bodies (values unchanged).
- Path templates changed where they were wrong: `/repos/{owner}/{repo}`, `/issue/{issueId}` for Jira keys, `/products/{productId}.json`, file names after a collection, `/orgs/{orgId}` for slugs ending in s. Re-check annotations keyed by the old endpoint ids.

**Leaks closed**
- Mock: XML, HTML, plain-text and truncated-JSON bodies were served almost verbatim; they are now scrubbed by tag, attribute or key name (P1)
- GraphQL: numbers under id arguments or with six digits or more, list literals and block strings become variables; literals in GET and batched documents count as evidence (P2, P3, C11)
- Identities inside longer tokens (`remember_<user>` cookies, `x-app-version: 2.14.0+<user>`) are caught, and such names are not listed (P4)
- Host names and slugs naming a user in fake URLs (`<user>.github.io`, `oguz-kilic.dev`) are faked (P5)
- Two-entry dictionaries keyed by recorded names, and keys that are the identifier form of a recorded name, are `Record`s and faked in the mock (P6, P12)
- Issue keys (`PROJ-7`), tenant slugs ending in s (`/orgs/acme-labs`), file names after a collection and non-ASCII dotted names in paths are parameters (P7, P8, P11, P15, P19)
- Usernames under role keys (`reviewer`, `approver`, `requester`…), upper-case tenant codes, and identities spelled with other separators (`ece_kaya` / `ece-kaya`) are identities (P9, P10, P16)
- Calendar dates in a person's record are masked; the HAR file name is no longer written into generated files or the prompt (P13, P14)
- The scanner reads Unicode and percent-encoded text; identifier forms are transliterated (`Kılıç` → `kilic`) (P15)
- Evidence no longer depends on the order of the capture; usernames with digits are personal under any key; a fake never equals the recorded value (P17, P18, P20)

**Correct output the guard broke**
- Batched GraphQL requests and persisted-query batches no longer trip the guard; the mock answers a batch with a batch (C1, C2)
- Relative API paths (`url: "/v1/customers"` in Stripe lists) are not data (C3); the mock keeps them (C9)
- One-word names of things (a category `"Books"`, a plan `"Premium"`) are labels, not personal data: `/api/books` and a `premium` property are written again (C4, C14)
- GitHub-style `/repos/{owner}/{repo}/…`, Jira's `/project/{key}` and Shopify's `/admin/api/2024-01/products/{id}.json` are templated correctly (C5, C6, C7)
- Mock: `__typename`, Stripe's `object` and other type discriminators survive; tRPC superjson output keeps its `meta` (C8, C10)
- tRPC superjson meta paths through data keys are not baked in (C12); words har2sdk always writes (`har2sdk`) and role words (`owner`) don't count as leaks (C13, C15)
- The mock no longer crashes on a path with non-Latin-1 characters, and a failing request gets a 500 instead of stopping the server (C16)
- `--examples` was refused by the leak guard on the demo itself (the scrubber keeps timestamps on purpose); the spec is now checked without its examples (C17)

**Hardening and release**
- HAR files are read as a stream, entry by entry; JSON bodies keep only their parsed value (`mock --raw` re-serialises JSON). A synthetic 200 MB capture: 713 MB → ~420 MB peak RSS at the same speed; a 600 MB capture that 0.5.0 refused now works (README, *Limitations*)
- The demo is recorded by Chromium (full and minimal HAR mode) and the Chromium headless shell as test fixtures; `record.mjs` takes `--browser`, `--mode`, `--out`, `--executable`. Firefox and WebKit couldn't be installed for this release (docs/KNOWN-ISSUES.md)
- README rewritten for first-time readers, with screenshots of the demo recorded in Chromium (`docs/screenshots/`); the package was checked with `npm pack` and a clean install (`npx har2sdk` on the demo: generate, inspect, prompt, mock, MCP)
- A test keeps `VERSION`, `package.json` and the CHANGELOG in step, and README links pointing at existing files

## 0.5.0

Fixes from a fourth external review. Its main point: 0.4.0's leak guard judged "is this data?" by shape alone (digits, spaces), so it both broke correct output and missed letter-only identities. It now also uses evidence from the capture itself: how a value is used elsewhere.

**The guard no longer breaks correct output**
- Property names with digits (`line1`, `last4`, `sha256`, `s3Bucket`) stay properties: the demo's `ShippingAddress` is an interface again (R1). The demo's endpoints and types are now pinned by a snapshot test
- Recorded vocabulary no longer turns path words into parameters: `oauth2`, `ipv4`, `web3`, `covid19`, `v1` stay literal (R2); learned parameters spread only to id-shaped values
- The mock keeps the JSON shape: property names never change; categories under technical keys (`brand: "visa"`, `proto: "ipv4"`) stay; usernames become distinct fakes; file extensions and IP formats survive (M1)

**More evidence, fewer leaks**
- Identities: values under `login`, `username`, `owner`, `author`, `id`… and in `x-user` / `x-tenant` headers count as data whatever they look like. Dictionaries keyed by them become `Record` (L1); they never become enum members (L3) and become parameters after a collection (`/teams/{teamId}`) (L5)
- Data inside query/form parameter names (`role[someone@…]`) is collected, and such parameters are left out with a warning (L2)
- Every inline GraphQL string becomes a variable, not just personal-looking ones (L4)
- Enums only for technical fields (`status`, `type`, `currency`…); `category`, `source`, `reason`… stay `string` (L3)
- Id-shaped segments (`2025-107454`, `C07QW9XHK`) are parameters even when seen once; dotted names after a collection (`/profiles/oguz.kilic`) and name echoes (`/people/ece` → `{name: "Ece"}`) too (L5)
- Personal keys in Turkish, German, Spanish and French (`dogumTarihi`, `telefon`, `geburtsdatum`…); CSV cells under personal columns
- Fewer false positives (identifier forms need 8+ characters and a distinctive value), so the CLI now **refuses to write** files the guard flags; `--allow-leaks` overrides (G1). MCP `generate_sdk` has `allow_leaks`
- MCP doesn't count a working directory of `/` or the home folder as safe for `out_dir` (G2)

**Other**
- A second GraphQL document under the same name is named after what it adds (`feedByAfter`)
- Two unambiguous locales without `Accept-Language` are one endpoint (`/{locale}/api/cart`)
- The warning for a reserved method name (`then`) says "reserved"
- `test/privacy-fuzz.test.ts` now randomises structure too: placement types, key names (five languages), letter-only identities, single/multi-sample paths, and checks a real MCP session

## 0.4.0

Fixes from a third external review, which found that 0.3.0's privacy fixes were tuned to the previous review's inputs: new inputs leaked personal data through three new routes. This release adds a general mechanism instead of more special cases, and a generated test that the fixes were not tuned on.

**Leak guard (new)**
- Every recorded value that looks like data is collected before generation (ids, emails, phone numbers, long numbers, free text, URLs with queries, values under personal/secret/id keys)
- Templating, type inference, enums and default headers consult it: a recorded value can't become a path literal, property name, type name, enum member or header default
- Every output is scanned afterwards: `client.ts` / `openapi.json` get a warning with masked previews (`--strict` refuses to write); the prompt, MCP responses and `inspect --json` get values replaced with `<redacted>`
- `test/privacy-fuzz.test.ts` generates random personal data, hides it in every place a value can go, and checks all outputs including mock responses (24 seeds by default, 1000 pass locally)

**Privacy**
- Objects keyed by emails, phone numbers, ids or other data are `Record<string, T>` — the keys never become property or type names (N2)
- Allowlisted headers need version/platform values: `x-client: someone@…` is no longer baked into `DEFAULT_HEADERS` (N3)
- `orderNumber`, `channelId`, `…Ref`, `…Code`… are never enums, and id-looking values never become enum members (N4)
- Mock server and `--examples` serve fake data with the recorded shape: consistent same-shape fake ids, placeholder text for names and free text, masked personal dates, locations, phone numbers, national ids and URL query strings (N8)
- Mock server answers only `localhost` / `127.0.0.1` / `[::1]` Host headers (DNS rebinding) (N9)
- Path segments containing whitespace (free text, prompt-injection attempts) are always parameters (#23)
- MCP `generate_sdk` writes only inside the HAR's folder, the working directory or the temp directory (#23)

**Path templating**
- `account`, `team`, `site`, `company`, `project` prefixes need two different values before the next segment becomes a parameter; sub-collections (`orders`, `addresses`) never do. `org(s)`, `workspace(s)`, `t`, `tenant(s)` still work from one sample (N1 — a regression in 0.3.0)
- Learned parameters apply to longer paths: `/orders/{orderId}` makes `/orders/ord-77314/refund` → `/orders/{orderId}/refund` (N10)
- Two-letter locales need three languages or a matching `Accept-Language`; `id`, `no`, `it`, `hr`… are ambiguous (N12)
- `--param` takes `{name}`, matches relative patterns anywhere, and warns when a pattern matches nothing (N13)

**Generated client**
- GraphQL inline values that carry data become variables (`login(username: $username)`) instead of a literal `"<redacted>"` that 0.3.0 actually sent (N6)
- GraphQL operations that share a name or root fields but send different documents are separate methods; the same document with other literal values stays one (N7)
- Error bodies: one type per status when shapes differ (`GetFileError404 | GetFileError422`), `ApiError.operation`, and generated guards (`isGetFileError(err)`) (N11)
- tRPC needs `trpc` in the path or `batch=1` (no more `/users.json` → `usersJson`); superjson `meta` annotations the app sent are re-sent for the paths present (N14)
- Structurally identical types are aliases (`export type Total = Price`) (N15)
- JSON-RPC 1.0 (#17); `then`, `catch`, `finally` are never method names (the client must not be thenable); an unusable `clientName` gives a warning (#33)

**Noise filter**
- `…/rum`, `…/beacon`, `…/telemetry` only drop fire-and-forget POSTs; Sentry `/api/<n>/store` needs Sentry parameters or payloads; first-party drops are reported in a warning; `--include-path` keeps a path (N5)

**Docs**
- README and SECURITY.md describe what is and isn't taken from the capture, how the guard works, and its limits. Claims that were wrong in 0.3.0 ("no recorded values", "the LLM sees paths and types only", typed `ApiError<E>`, superjson) are corrected.

## 0.3.0

Fixes from an external review that ran the code against ~60 hostile and realistic inputs.

**Privacy**
- No recorded values in generated files by default: path/query examples removed from JSDoc and OpenAPI (`--examples` opts in)
- The LLM (MCP, `prompt`) sees endpoint paths and types only — no example bodies
- Default headers come from an app/version allowlist; other custom headers are only listed by name
- GraphQL inline arguments are judged by argument name (`password:`, `username:` …) as well as by value (note: 0.3.0 replaced them with a literal `"<redacted>"`, which the generated method then sent; fixed in 0.4.0)
- Enum unions only for categorical field names (`status`, `type`, …), never usernames or slugs
- Contact details (address, phone, IBAN, …) masked wherever examples appear; `key`/`appid` are credentials
- Mock server: CORS only for localhost and the recorded origins, secrets/contact details masked unless `--raw`
- HAR parse errors no longer quote the file; HAR-derived text is escaped in LLM-facing output; MCP only reads `.har`/`.json` and won't overwrite foreign files

**Path templating**
- camelCase / descriptive names (`getUserInfo`, `getRecommendationsV2`, `s3-presigned-upload`) stay literal
- No merging without evidence; echo only counts in the response's own id fields (`slug`, `login`, …)
- A segment seen once becomes a parameter when the server echoes it as its id; phone numbers are ids
- Tenant prefixes (`/orgs/acme`, `/t/acme`), `/rest/api/2` versions, `{year}` / `{date}` names
- `--param "/users/*"` to force a parameter, `--exclude-host`, `--exclude-path`

**Generated client**
- Compiles when responses have fields named like TS globals (`parameters`, `nonNullable`, …)
- Valid class names for hosts like `9gag.com`, `example.co.uk`, `acme.com.tr`; reserved names rejected
- Keeps the recorded auth scheme (`Token …`, not always `Bearer`)
- Anonymous GraphQL operations get one method each and no bogus `operationName`
- `{"query": "subscription plans"}` is no longer mistaken for GraphQL
- Distinct 2xx shapes become a union; error bodies are typed (`ApiError<E>`)
- Runtime strips BOM / XSSI prefixes and parses JSON sent as text/plain
- Missing or truncated bodies become `unknown` with a warning
- `@` and `:` in fixed path segments are kept; `strictGraphQL` option for partial errors

**Other**
- ~30 more telemetry hosts and first-party telemetry paths; primary origin chosen by endpoints, not request count
- Tracking cookies are not treated as the session; the token is `Token`/`Bearer`/… as recorded
- Prefixed-id keyed objects are maps; ids over 15 digits stay strings; `integer` needs 3+ samples
- Annotations accept a fenced chat reply; base64 `postData` and declared charsets are decoded
- Node 20+

## 0.2.0

- JSON-RPC 2.0 and tRPC (batched, GET/POST, superjson) — one typed method per procedure, replayed by the mock server
- Locale prefixes (`/en-us/`, `/tr/`) become a `{locale}` parameter
- Several HAR files can be passed at once and are merged
- The mock server binds to 127.0.0.1 by default (`--bind` to change)
- Examples mask contact details (addresses, phone numbers, usernames)
- Friendly error for captures too large to load
- Generated OpenAPI is validated against the official 3.1 schema in the test-suite

## 0.1.0

First release.

- HAR → typed, zero-dependency TypeScript SDK and OpenAPI 3.1 spec
- Noise filtering (assets, documents, preflights, ~50 tracker hosts)
- Path templating by id patterns, response-shape similarity and value echo
- Type inference: optional/nullable fields, formats, open enums, id-keyed maps, structural de-duplication
- GraphQL: one method per operation, incl. batched, GET and persisted queries
- Auth & default-header detection
- Secret/PII redaction (strengthened in 0.3.0)
- `har2sdk mock` replay server
- `har2sdk prompt` for naming via any chat; MCP server (`har2sdk mcp`) for Claude and other MCP clients
- Annotations file for names, descriptions, tags, parameter and type renames
