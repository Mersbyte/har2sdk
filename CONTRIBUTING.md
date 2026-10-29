# Contributing

Thanks for helping. har2sdk's main promise is that values recorded in a capture don't end up in what it generates, so most of these notes are about keeping that true.

## Never share a real HAR file

Not in issues, pull requests, tests or chat. A HAR file holds live cookies, tokens and personal data. To show a problem:

- paste `har2sdk inspect capture.har --json` (recorded values the leak guard knows become `<redacted>`; read it before you paste it), or
- write a tiny synthetic HAR by hand with made-up values.

A recorded value that reached a generated file, prompt, MCP response or mock response is a security report: please send it [privately](https://github.com/Mersbyte/har2sdk/security/advisories/new), as [SECURITY.md](SECURITY.md) explains.

## Setup

Node 20 or newer.

```
npm install
npm test                      # build (tsc) + vitest
node dist/cli.js examples/demo-shop/acme-shop.har -o /tmp/out
```

After a change to `src/leak.ts`, `redact.ts`, `template.ts`, `infer.ts`, `types.ts` or `mock.ts`, also run the long privacy test:

```
HAR2SDK_FUZZ_SEEDS=1000 npx vitest run test/privacy-fuzz.test.ts
```

`src/` is mapped in [CLAUDE.md](CLAUDE.md).

## Changes to the leak guard

- **Make a fix general.** A fix tuned to one example input fails on the next one; that is the lesson of every review so far. Prefer evidence from the capture itself (how a value is used elsewhere in it) over judging a value by its shape.
- **Don't break correct output.** `test/fixtures/demo-snapshot.json` pins the demo's endpoints and types. Change it only on purpose, and say why.
- **Add tests.** A reproduction with your input, and where possible a generated variant that covers the whole class of inputs. Findings from a review go in `test/reviewN.test.ts`, one `describe` per finding.
- **Keep the docs honest.** README, SECURITY.md and CHANGELOG.md must not claim more than the code does.

## Generated code

`client.ts` must compile under `strict`, `exactOptionalPropertyTypes` and `erasableSyntaxOnly`, and must have no runtime dependencies.

## Pull requests

Work on a branch, keep a PR to one change, and add a line to `CHANGELOG.md` under the next version.
