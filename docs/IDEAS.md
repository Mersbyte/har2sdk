# Ideas (not implemented)

Ideas that came up while working on 0.6.0. They are new features, not fixes, so they were written down instead of built.

- **Evidence from JWT payloads.** A bearer token's payload often names the user (`preferred_username`, `email`, `sub`). Decoding it (never printing it) would give the leak guard more identities without any extra input.
- **Parameter names from the echo field.** `/repos/{owner}/{repo}` already takes `owner` from `{ owner: { login } }`. The same could name `{login}` for `/users/{x}` echoed by `login`, instead of `userId`.
- **Slack-style RPC method names.** `POST /api/chat.postMessage` becomes `createChatPostMessage`; recognising `noun.verb` paths would give `chatPostMessage`.
- **Keep epoch timestamps in the mock.** Integers ≥ 100000 are faked, so `created: 1700000000` becomes a random number of the same length. Timestamps under date-like keys (`created`, `*_at`, `expires`) could stay, like ISO dates do.
- **`har2sdk doctor`.** A command that lists, for each path literal and property name, which evidence kept it literal — would make the guard's decisions reviewable before publishing.
- **Lift GraphQL variable defaults.** `query Q($login: String = "mdemir")` is refused today (the default is a recorded value); the default could be dropped and the value passed as a variable instead.
- **Leaner memory for huge captures.** Every exchange is kept in memory for the mock and examples; a mode that keeps only what type inference needs would cut memory further.
