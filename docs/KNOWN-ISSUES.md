# Known issues

Problems found by reviews that are not fixed yet, with the reason. The newest are first; each review's full list is in CHANGELOG.md.

## From the 0.6.15 audit (review 20), not fixed in 0.6.16

Fixed findings are in the 0.6.16 entry of CHANGELOG.md. These are open:

- **Privacy: carriers the guard doesn't read.** A value whose only evidence is in a YAML body, a form-encoded *response*, a `Content-Disposition` file name, URL userinfo (`https://user@host`) or an `@mention` inside text isn't collected, so the same value used elsewhere can stay a path literal (A1-05). A person's own subdomain (`zkaya.app.example`) is open too (A1-03). A2-03 (the guard reporting a host name) is left as it is on purpose: not reporting host names would also stop reporting such a subdomain.
- **False refusals.** A mailbox's local part (`cart@shop.example`) followed by another word in a path (`/api/v1/cart/items`) is still taken as a possible username, the same shape as `/api/v1/okilic/projects`, so such an app can be refused (A2-02, in part; 36 of 320 generated mailbox shapes). Other refusal cases from the audit: A2-01, A2-04 to A2-07. A refusal never writes the value; `--param` or annotations get past it.
- **Correctness for less common API styles:** GraphQL served under a templated path (C2-02); query parameters dropped on RPC calls (C2-04); Google-style custom methods such as `/v1/operations/{id}:cancel` (C2-05); OData (C2-06). (Sibling parameters, C2-10, are fixed in 0.6.18: see CHANGELOG.md.) Also DJ-03, E-01, E-09 and H-01, and the audit's Low findings.

## From the 0.6.0 work

## Privacy

- **Values with no evidence.** A plain word used once as a path segment, never echoed, never listed and never stored under a personal or identity key (for example `/api/whoami` returning the text `mdemir` and nothing else naming it) can't be recognised. This is the documented limit of the guard (SECURITY.md, *Limits*).
- **Short or lower-case random tokens.** Letter-only tokens are judged by rare letter pairs and case flips (0.6.1, A4). Long mixed-case tokens are recognised; a 12-letter lower-case one about half the time (`xkqbvtrmplsa` yes, a pronounceable `kobulimaterasu` no). The other direction: a camel-case name made mostly of acronyms (`ListAWSIAMRolesForEC`) and some surnames (`kowalczyk`) count as random, so such a path segment becomes a parameter.
- **GraphQL variable defaults.** Since 0.6.10 string, number, list and input-object defaults move into the variables and leave the document; boolean, null and enum defaults stay. A recorded value in a `#` comment of a document stays in `client.ts` (the prompt and MCP show documents without comments); the guard recognises it and refuses to write the client.

## Testing

- **Firefox and WebKit recordings are missing.** Only Chromium (and its headless shell) was installed in the environment the 0.6.0 fixtures were recorded in; `examples/demo-shop/record.mjs --browser firefox|webkit` failed with "Executable doesn't exist at /opt/pw-browsers/firefox-1495/…" / "…/webkit-2215/…", and installing browsers there was not allowed. The recorder supports both; recordings should be added to `test/fixtures/browsers/` by someone with those browsers (Firefox records against `acme-shop.test` via a DNS pref, WebKit against `localhost`).
- **No Chrome DevTools "Save all as HAR" fixture of the 0.6.0 demo.** DevTools exports differ from Playwright's (`_resourceType`, `_initiator`…). The older `examples/demo-shop/acme-shop.har` and the unit tests' Chrome-style entries cover the format; a fresh DevTools export needs a person at a browser.
