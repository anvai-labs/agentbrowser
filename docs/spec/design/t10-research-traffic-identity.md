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

## A8/A9: destination header interaction and native response compatibility

The transform distinguishes an override from absence of header-policy
interaction. `undefined` means this destination matches no configured marker,
carries no configured marker name, and needs no asset credential scrubbing.
Policy checks still receive the original effective headers, but dispatch omits
header overrides. A returned object supplies an exact injection/stripping/scrub
override. A carried marker still forces stripping on a nonmatching destination;
an asset host still forces credential scrubbing. This additive internal contract
does not change identity validation or grant host/method authority.

Initial inspected requests without interaction omit header replay. Redirects
retain the independently required cookie/Host/auth and permanently dropped-body
header hygiene introduced by 1.30.1. A transform's `undefined` result must never
restore the source request's credentials or original body on a later hop.
Browser-generated preflights remain distinct from explicit OPTIONS and never
receive injected markers before their policy admission.

Native POST/PUT/PATCH chains remain guarded on every hop even without marker
interaction. Skipping the guard for nonmatching hosts would permit out-of-scope
redirects and remove ledger outcomes, so the handoff's proposed zero-CDP-overhead
shortcut is rejected. A9 qualification instead uses captcha-shaped cross-origin
iframe POSTs with permissive CORS, checking successful response delivery and
scope/base/tenant/metadata and method/host/rate/budget refusals. Diagnosis must
distinguish header overrides from response continuation failures. If a response
stream has been acquired, failure must cancel rather than continue the original
response. Live Wolt/hCaptcha verification remains pending operator verification.

Local A8/A9 qualification runs the same seven public-service cases against the
archived 1.30.1 response-continuation baseline and the tri-state candidate. Both
pass: marker/no-marker JSON POSTs from a cross-origin iframe complete with exact
UTF-8 bytes, and an unscoped control also completes. Method, host, rate and budget
controls each produce one typed scope denial, no denied API receiver hit and a
verified sealed ledger. The reported A9 response failure is not reproduced on
this baseline; no guard-skipping change is justified by these results.

The fixture grants native local-network permission only to its fresh loopback
source origins and delegates the iframe permission; application egress policy
stays enforced. Before that fixture setup, Chromium reports
`LocalNetworkAccessPermissionDenied` even for the unscoped control, so it is not
evidence of an A9 response-enforcement failure. This permission is test setup,
not a product option or a change to program traffic.

Observed generated preflights have Fetch resource type `XHR`, while the matching
Network event has type `Other`, `initiator.type: preflight` and an exact network
request ID; event ordering varies. Playwright internally fulfills those OPTIONS
with 204, so a successful wire oracle observes the application POST, not a remote
OPTIONS hit. Future preflight authority must use correlated trusted browser
metadata, not a header/method heuristic or the `Preflight` resource-type label
alone. This A8 checkpoint does not qualify preflight policy/budget/DNS admission;
that remains a separate transport/resource-host gate. The fixture must be rerun
when stronger terminal-response admission is integrated.

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
