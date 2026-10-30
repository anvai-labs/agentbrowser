# T10 M5: research traffic identity and engagement diagnostics

Research programs can require a public researcher marker on every testing
request. `identityBindings` validates marked requests; it does not supply a
marker. Add a separate, explicit scope feature without changing that validator.

## Contract

`policy.scope.requestHeaders` is an optional array of `{header, value,
hostSuffix?}`. Host matching follows the existing scope matcher: a bare registrable domain
covers its subtree, an IP/unbounded host is exact, and `.suffix` covers
subdomains only. An absent host binds all allowed hosts. Names are case
insensitive and unique across the array; at most 16 entries and 8192 combined
name/value bytes. Only custom `X-` headers are accepted; standard transport,
credential, proxy and browser-controlled names are refused. Values must be
printable ASCII, at most 1024 bytes, with no line breaks. Unknown fields remain
refused. A host rule with no overlap with allowed hosts is refused.

The policy supplies a pure header transform. The engine removes all configured
marker names from incoming headers, then adds the matching set for the current
destination. This runs afresh on every routed request and every redirect hop,
before scope/identity validation and the base policy. The engine sends that
same transformed set. Never use context-wide extra headers: they can leak
across redirects. Body-bearing requests use per-hop CDP overrides in the existing Chromium
guard, including the initial hop: Playwright `route.continue({headers})`
persists overrides across redirects and would reapply a stripped marker;
unsupported lanes continue to fail closed. The metadata floor delegates the
transform and still gates requests before the scope/base chain. Header
transformation grants no network permission and spends no budget by itself.
The GET walker lets the context select destination cookies on every redirect;
Authorization and proxy authorization are permanently removed when the chain
changes origin, including when a later hop returns to the original origin.

`identityBindings` stays unchanged: inject + bind composes normally. An
injected marker is removed on a nonmatching destination, including same-session
cross-host redirects. A caller cannot override a configured marker with a
different case or value.

Status and `engagement.opened` record the configured names, host rules and
SHA-256 hashes of the values, never raw identity values. Each dispatched
injection gets a `request.headersInjected` ledger record with destination
origin/path and the applied names. This records engine dispatch intent, not a
claim that a remote server received the request. Existing request outcome
records still record success/failure. Hashes let a researcher prove which
public marker was configured without putting marker plaintext in the ledger.

Session `userAgent` is a bounded printable ASCII browser-context option,
reported in session status and the ledger opening. It is refused on engines
that cannot honor it and on operator CDP attachment. Scope request-header
injection is likewise capability-gated. Service-side downloads with injected
markers or an overridden UA are refused until that separate transport can
honor the same contract. Service workers remain prohibited with scopes.

## Other M5 behavior

Session views expose sampled scope budget and pacing counters. Navigation
failures include scope denial counts attributed to that page during the call;
they do not change failure reasons or denial semantics. Import sizing is
explicit (`max(150, pages × 120)`), warns for budgets below 150, and never infers
a program scanner cap. Engagement export stays exclusive by default; `--force`
replaces the output with a new 0600 file.

## Qualification

Colocated tests cover malformed/reserved/oversized headers, unknown-field
refusal, host normalization, cross-host redirect stripping, forged caller
values, base/floor denial, subresources and body-bearing hops, ledger evidence,
unsupported lanes, status counters and page-local navigation correlation.
All browser qualification uses local fixtures; no live program traffic is
needed for these changes.
