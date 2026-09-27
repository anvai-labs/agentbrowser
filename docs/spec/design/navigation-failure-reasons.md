# R3 continuation: navigation failure reasons

Status: implemented candidate, unreleased; based on develop after PR #292.
Scope: Brief 1 / F7 remainder in the September 25 consumer handoff. Load this
packet for navigation failure work; it does not add a browser lane or retry engine.

## Owners and contract

Protocol owns `NavigationFailureReasonSchema` and the bounded client error
projection. Engine owns code classification. Policy decisions stay in the existing
NetworkPolicy choke point. Playwright's existing per-context request sink holds a
WeakMap receipt keyed by the exact routed Request; only the routing owner writes
it. Navigation consumes the receipt of `response.request()`. Origin headers, child
requests, sibling pages and previous navigation cannot manufacture that provenance.
No hostname cache, permanent diagnostic store or new request executor is added.

Existing result envelopes retain their status/url/redirectChain. Failed results
carry an additive `reason`; successful results omit it. Older engines/servers may
omit reasons. Thrown errors retain the existing error envelope and bounded
`details.reason`. CLI preserves JSON result output but exits 1 on blocked/timeout;
recognized thrown navigation errors write JSON to stderr with exit 1. MCP returns
`isError: true` plus identical text JSON and structuredContent for failed navigation.
The shared projection preserves only reason and a valid operationId for reconciliation.
It does not enable retries or promise replay safety.

| Reason | Required observation |
| --- | --- |
| dns_unresolved | OS lookup ENOTFOUND/ENODATA or driver name-resolution failure; no claim about a DNS packet |
| dns_nxdomain | Reserved for an adapter that can prove a DNS NXDOMAIN response; current Playwright lookup does not emit it |
| dns_timeout | Timeout code from a resolver or a driver DNS-timeout code |
| dns_refused | Refused query/server connection from the resolver operation |
| connection_refused | Destination TCP connection refusal; never inferred to be DNS refusal |
| tls_refused | An allowlisted TLS/certificate failure at the transport boundary |
| egress_policy | An actual policy decision at the existing preflight/routing owner |
| browser_error_document | Resolved navigation committed a recognized internal browser error document |
| engine_error | Cause is unknown, ambiguous, or outside the bounded vocabulary |

The two additional reasons correct the brief's over-specific mappings. Node
[`dns.lookup`](https://nodejs.org/api/dns.html#dnslookuphostname-options-callback)
uses OS facilities and ENOTFOUND can mean failures other than nonexistent names.
Chromium's [network error definitions](https://chromium.googlesource.com/chromium/src/+/main/net/base/net_error_list.h)
distinguish name resolution from destination connection refusal. Do not change the
SSRF resolver to a DNS-only lookup merely to produce a nicer diagnostic.

## Failure, privacy and lifetime invariants

The DNS gate remains fail closed. Its synthetic denial preserves the observed
reason instead of relabeling every lookup failure as policy. A main-frame routed
fetch failure receives a minimal synthetic 502 so the owner can correlate the
result to its Request, then navigation throws a typed bounded error. Subresource
failures still abort. Every dispatched navigation invalidates engine and public
service refs before awaiting; preflight policy refusal does not dispatch or
invalidate. Remote 403/502 content remains an ordinary successful document load.

Only anchored driver-owned codes/prefixes classify native errors. A URL containing
`browser.closed` or a connection error cannot establish browser death. Actual typed
engine failure retains its code; untyped driver close prefixes are bounded at the
engine seam. Public errors and request failure reasons omit raw addresses, proxy
configuration, credentials, paths and driver call logs. Existing request-event URL
redaction remains in effect. Browser error documents and HTTP content are separate;
no failure is labeled a bot wall. Unknown fields are never copied into CLI/MCP errors.

## Qualification and delivery

Failing-first tests cover exact codes, unknown/spoofed strings, DNS owner failures,
policy denial, remote forged headers, child requests, repeated navigation, public
revision invalidation, operation ID retention, and REST/CLI/MCP behavior. The existing
research smoke still protects complete extraction and session behavior. The focused
`node scripts/navigation-consumer-smoke.mjs --headed --live` starts an isolated fresh
service and drives actual REST/SDK/CLI/MCP clients. It leaves the logged-in service
untouched. Deterministic fixtures are assertions; public-site outcomes are recorded
observations because DNS and Yahoo availability can change. Do not edit assertions
to claim a historical wall reproduced when today's page loaded.

Normal hooks, an independent exact-head review and green PR CI gate develop delivery.
No release or completion of R5b/T5 is implied. Evidence lives in
[the qualification record](../evidence/navigation-failure-reasons.md).
