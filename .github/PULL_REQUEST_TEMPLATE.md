## What and why

<!-- What this changes and why. Link the issue if there is one. -->

## Checks

- [ ] `npm test` passes
- [ ] Touched `leak.ts`, `redact.ts`, `template.ts`, `infer.ts`, `types.ts` or `mock.ts`? Then `HAR2SDK_FUZZ_SEEDS=1000 npx vitest run test/privacy-fuzz.test.ts` passes too
- [ ] `test/fixtures/demo-snapshot.json` is unchanged, or the description says why it changed
- [ ] No real HAR files or real personal data in the diff (tests use made-up values)
- [ ] README / SECURITY.md / CHANGELOG.md still match what the code does
