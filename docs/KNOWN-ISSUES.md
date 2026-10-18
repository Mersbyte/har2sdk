# Known issues

Problems found during the 0.6.0 work that were not fixed, with the reason.

## Privacy

- **Values with no evidence.** A plain word used once as a path segment, never echoed, never listed and never stored under a personal or identity key (for example `/api/whoami` returning the text `mdemir` and nothing else naming it) can't be recognised. This is the documented limit of the guard (SECURITY.md, *Limits*).
- **Short or lower-case random tokens.** Letter-only tokens are judged by rare letter pairs and case flips (0.6.1, A4). Long mixed-case tokens are recognised; a 12-letter lower-case one about half the time (`xkqbvtrmplsa` yes, a pronounceable `kobulimaterasu` no). The other direction: a camel-case name made mostly of acronyms (`ListAWSIAMRolesForEC`) and some surnames (`kowalczyk`) count as random, so such a path segment becomes a parameter.
- **GraphQL variable defaults.** `query Q($login: String = "mdemir")` keeps the default in the document. The guard recognises it and refuses to write the client; it is not lifted (see docs/IDEAS.md).

## Correctness

- **Word-with-digits repository names at a learned position.** `/repos/{owner}/widget9/issues` stays literal when `widget9` is only echoed by `/repos/{owner}/widget9` and not listed by a `…/repos` response: words with one or two digits (`oauth2`, `ipv4`) are kept literal on purpose (review 4, R2). The guard then refuses only if `widget9` was recorded as personal data.

## Testing

- **Firefox and WebKit recordings are missing.** Only Chromium (and its headless shell) was installed in the environment the 0.6.0 fixtures were recorded in; `examples/demo-shop/record.mjs --browser firefox|webkit` failed with "Executable doesn't exist at /opt/pw-browsers/firefox-1495/…" / "…/webkit-2215/…", and installing browsers there was not allowed. The recorder supports both; recordings should be added to `test/fixtures/browsers/` by someone with those browsers (Firefox records against `acme-shop.test` via a DNS pref, WebKit against `localhost`).
- **No Chrome DevTools "Save all as HAR" fixture of the 0.6.0 demo.** DevTools exports differ from Playwright's (`_resourceType`, `_initiator`…). The older `examples/demo-shop/acme-shop.har` and the unit tests' Chrome-style entries cover the format; a fresh DevTools export needs a person at a browser.
