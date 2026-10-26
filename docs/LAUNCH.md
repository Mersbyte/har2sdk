# Launch kit — har2sdk 0.6.0

Drafts for announcing 0.6.0. Every claim below is in the README; nothing here goes further. Post only after the repository is public and `npm publish` has run (the badge, `npx har2sdk` and the README images depend on both).

Links used below:
- Repo: https://github.com/Mersbyte/har2sdk
- npm: https://www.npmjs.com/package/har2sdk

---

## Show HN

**Title** (≤ 80 characters):

> Show HN: har2sdk – turn a browser HAR capture into a typed TypeScript client

**First comment** (post it right after submitting):

> Hi HN. har2sdk takes a HAR file — the "Save all as HAR" export from your browser's Network tab — and generates a typed, zero-dependency TypeScript client (`client.ts`), an OpenAPI 3.1 spec and a local mock server for the API the page was calling. It runs locally, it's deterministic, and it needs no API key:
>
>     npx har2sdk capture.har
>
> I built it because figuring out an undocumented API in DevTools takes an afternoon: which endpoints exist, what the ids look like, which fields are optional, what auth it expects. It handles REST, GraphQL, JSON-RPC and tRPC.
>
> How it works, roughly: it drops noise (static assets, preflights, ~80 analytics/ads hosts, common first-party telemetry), turns concrete paths into templates (`/users/42/orders/ord_9f8a` → `/users/{userId}/orders/{orderId}`) from id shapes and from evidence in the capture itself (the response echoing a value as its own id, a list response naming its items by it), merges every sample into types (optional vs. required, formats, open enums like `"shipped" | "delivered" | (string & {})`), and emits the client and the spec. The client compiles under `strict`, `exactOptionalPropertyTypes` and `erasableSyntaxOnly`.
>
> The part I'd most like feedback on is privacy. HAR files contain session cookies, tokens and often other people's data, and the generated code is something you might publish. So there's a "leak guard": before generating, it collects every recorded value that looks like data or names a user/tenant, the generator consults that set when deciding what may become a path literal, enum member or property name, and afterwards every output is scanned. If `client.ts` or `openapi.json` contains a recorded value, nothing is written. The mock serves fake data with the recorded shape instead of the recorded bodies.
>
> To be clear about its limits: this is a heuristic built on evidence from the capture, not a proof. A value with no evidence anywhere — a word used once as a path segment that nothing else names — can't be recognised, and one-word names of things (a category called "Books") are treated as vocabulary. The inputs of twelve review rounds are in the repo as tests, plus a generated privacy test that hides a random person in 30 kinds of places in a random capture and checks every output (30 seeds in CI; the long run of 1,000 seeds passes). Please look over `har2sdk inspect` before publishing generated code. If you find a leak, I'd much rather hear about it (see SECURITY.md).
>
> Naming is where a language model helps, so there's an optional MCP server and a copy-paste prompt; what a model sees is paths with `{params}`, parameter names, inferred types and GraphQL documents, checked against the guard's values first.
>
> Limitations: types describe only what was observed; heuristics can still mis-template paths (`--param` fixes that); protobuf/gRPC-web, WebSockets, SSE and request chains (fetch a CSRF token, then call) aren't modelled. It's tested with Chrome-style exports and Playwright recordings by Chromium; Firefox and Safari exports should work (same HAR 1.2 format) but have no fixtures yet.
>
> Please use it on your own apps, internal systems or APIs you're allowed to integrate with — not to publish SDKs for other companies' services.

---

## Reddit — r/typescript

**Title:**

> I built a CLI that turns a browser HAR capture into a typed, zero-dependency TypeScript client

**Body:**

> `npx har2sdk capture.har` reads the HAR you export from DevTools → Network and writes `client.ts` + `openapi.json`. Example from the demo app in the repo:
>
> ```ts
> const shop = new AcmeShopClient({ token: process.env.TOKEN });
> const page = await shop.listProducts({ category: "shoes", page: 1, limit: 4 });
> page.items[0].price.amount;   // number
> const order = await shop.getOrder({ orderId: "ord_7Hx92kLm" });
> order.status;                 // "delivered" | "processing" | "shipped" | (string & {})
> ```
>
> Some type-level details that may interest this sub:
> - Every sample is merged: optional vs. required, nullable, `date-time`/`uuid`/`email`/`uri` formats, and dictionaries keyed by ids become `Record<string, T>` instead of fake property names.
> - Categorical fields (`status`, `type`, `currency`…) get open enums — `"a" | "b" | (string & {})` — so you get autocomplete without breaking when the server adds a value.
> - Different 2xx shapes become a union; recorded error bodies get a type per status and a generated guard (`if (isGetFileError(err)) err.body`).
> - GraphQL operations, JSON-RPC methods and tRPC procedures each become a typed method.
> - The output compiles under `strict`, `exactOptionalPropertyTypes` and `erasableSyntaxOnly`, uses the global `fetch` and has no dependencies.
>
> Types only describe what was observed, so fields that never showed up are missing. It's local and deterministic; there's an optional MCP server if you want a model to suggest names. A leak guard keeps recorded values (tokens, ids, names) out of the generated files — it's a heuristic, and the README is explicit about what it can't catch.
>
> Repo: https://github.com/Mersbyte/har2sdk — feedback on the generated types very welcome.

---

## Reddit — r/webdev

**Title:**

> har2sdk: record an app's traffic in DevTools, get a typed API client, an OpenAPI spec and a mock server

**Body:**

> If you've ever reverse-engineered your own legacy backend (or a service you're allowed to integrate with) by clicking around with the Network tab open, this automates that step:
>
> 1. DevTools → Network, tick *Preserve log*, use the app, **Export HAR**.
> 2. `npx har2sdk capture.har` → `client.ts` + `openapi.json`.
> 3. `npx har2sdk mock capture.har` → a local API on `localhost:4010` that answers like the recorded one.
>
> It works with REST, GraphQL, JSON-RPC and tRPC, filters out analytics and static assets, and figures out path parameters, auth (Bearer, Basic, API keys, session cookies) and types.
>
> The mock is meant for offline frontend work: by default it serves **fake data with the recorded shape** — same structure, fake ids, masked names, emails and addresses — not your recorded responses. It binds to `127.0.0.1` and rejects foreign `Host` headers.
>
> HAR files contain live cookies and tokens, so please treat them like passwords. har2sdk runs locally and the CLI makes no network requests. A leak guard refuses to write generated code that contains a recorded value; it's heuristic, and the README spells out what it can't catch (a value with no evidence anywhere in the capture).
>
> Use it on your own apps and APIs you have permission to use.
>
> Repo: https://github.com/Mersbyte/har2sdk

---

## X / Twitter thread

1/
> I built har2sdk: export a HAR from your browser's Network tab, run `npx har2sdk capture.har`, get a typed TypeScript client, an OpenAPI 3.1 spec and a mock server. Local, deterministic, no API key.
> https://github.com/Mersbyte/har2sdk

2/
> It handles REST, GraphQL, JSON-RPC and tRPC. Paths become templates (`/users/42` → `/users/{userId}`), samples merge into types with open enums (`"shipped" | "delivered" | (string & {})`), and the client has zero dependencies and compiles under `strict`.

3/
> HAR files are full of cookies, tokens and other people's data. A leak guard collects recorded values first and refuses to write generated code that contains one. The mock serves fake data with the same shape, not your recordings.

4/
> It's a heuristic, not a proof: a value with no evidence anywhere in the capture can't be recognised. The inputs of twelve review rounds are in the repo as tests, plus a generated privacy test across 30 kinds of places. Please check `har2sdk inspect` before publishing.

5/
> Want better method names? An optional MCP server lets Claude (or any MCP client) name and document endpoints; a model only sees paths, names and types. For your own apps and APIs you're allowed to use. Feedback and leak reports welcome.

---

## When to post (UTC)

These are common conventions, not measurements:

- **Show HN:** Tuesday–Thursday, around 8–10 a.m. US Eastern. Until 1 November 2026 (US daylight time) that is **12:00–14:00 UTC**; from 2 November it is **13:00–15:00 UTC**. Avoid Friday afternoon and weekends. Plan to answer comments for the first 3–4 hours.
- **r/typescript and r/webdev:** a weekday at the same window (12:00–14:00 UTC, 13:00–15:00 UTC after the US clock change). Post them on a different day from Show HN so you can answer both, and check each subreddit's self-promotion rules first.
- **X thread:** the same day as Show HN, an hour or two after it, with the HN link added as the last reply only if the post is doing well.

---

## Critical questions — short answers

**"Isn't this a tool for scraping/abusing other people's APIs? Is it legal?"**
> It reads traffic your own browser already sent and received, and it's meant for your own apps, legacy internal systems and services you're allowed to integrate with. Reverse-engineering or automating an API you don't own can break its terms of use; whether that's allowed depends on those terms and where you are. The README asks people not to publish SDKs for other companies' services. (Not legal advice.)

**"HAR files contain my session. Why would I feed one to a tool?"**
> It runs on your machine and the CLI makes no network requests. Recorded values are kept out of `client.ts` and `openapi.json`; if the leak guard finds one, nothing is written. The mock serves fake data unless you pass `--raw`. Still: treat the HAR like a password and don't commit it.

**"Can I trust the leak guard?"**
> Trust it as a heuristic with evidence from the capture, not as a guarantee. It can't recognise a value that nothing in the capture marks as data, and one-word names of things are treated as vocabulary. That's documented in SECURITY.md, which also lists exactly what is collected. Look over `har2sdk inspect` before publishing generated code, and please report leaks (SECURITY.md says how).

**"What does the LLM see?"**
> Nothing unless you use the optional MCP server or the copy-paste prompt. Then: endpoint paths with `{params}`, parameter names, inferred types and GraphQL documents with inline values lifted into variables — checked against the guard's values and redacted first. Generation itself is deterministic and needs no model.

**"How is this different from mitmproxy2swagger / har-to-openapi?"**
> Those produce an OpenAPI spec, and pair well with a generator such as orval or hey-api to get a client; mitmproxy2swagger's explicit review step for path templates is a good idea when you want full control. har2sdk is one deterministic step from recording to an importable TypeScript client, with GraphQL / JSON-RPC / tRPC methods and a mock server built in, and a model only for names if you want one.

**"Why not just let an LLM write the client?"**
> That's flexible and multi-language, but it needs a model and key, sends the capture to it, and produces different code on each run. har2sdk is deterministic and local.

**"Does it handle huge captures?"**
> Captures are read as a stream; every request is still kept in memory. On a synthetic 200 MB capture: about 11 s and ~420 MB peak RSS; 600 MB: 39 s and 979 MB (numbers and setup in the README).

**"Firefox / Safari?"**
> They write the same HAR 1.2 format but there are no fixtures for them yet. If an export trips it up, please open an issue with `har2sdk inspect --json` output — never the HAR itself.
