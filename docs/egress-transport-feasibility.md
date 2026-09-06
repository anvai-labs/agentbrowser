# T1 worker-egress feasibility evidence

Status: **Gate failed; no production transport implementation approved by these
results.** Probes ran on 2026-09-06 with Playwright 1.62.1. The CSP probe recorded
runtime Chromium 151.0.7922.34. The earlier WebSocket probe did not print the
runtime version; its installed manifest named the same Chromium version,
revision 1234. Do not treat manifest metadata as a runtime measurement.

These are tests of proposed mechanisms, not claims of a new exploit in the
currently shipped fetch/fulfill path. That path's known WebSocket compatibility
failure also broke unguarded worker controls, so those failures were rejected as
enforcement evidence. The native/CDP continuation controls below did connect.

## Page WebSocket routing is insufficient

A loopback HTTP/HTTPS fixture counted actual WebSocket upgrade hits. Native
controls and a candidate with page CDP Fetch request/response continuation were
compared. The candidate additionally installed context-level `routeWebSocket`
deny-all. Each arm tried page, dedicated-worker and shared-worker WS and WSS.

| Case | Native control | CDP continuation + page WebSocket denial |
| --- | --- | --- |
| Page WS/WSS | Both opened | Both closed with code 1014; handler invoked |
| Dedicated worker WS/WSS | Both opened | Both opened; handler not invoked |
| Shared worker WS/WSS | Both opened | Both opened; handler not invoked |
| Server upgrade hits | 6 | 4, all from workers |

[Captured stdout](evidence/worker-websocket.jsonl) retains the individual results
and intercepted paths. Source inspection of the installed Playwright build found
page/frame initialization that replaces the JavaScript WebSocket constructor;
it is not a browser network-service upgrade gate.

## Appended CSP is not yet a complete replacement

The [CSP specification](https://www.w3.org/TR/CSP3/#directive-connect-src)
defines connection restrictions, including WebSockets. This motivated a second
candidate: append `connect-src http: https:` to document and worker-script
response headers via CDP `Fetch.continueResponse`, retaining every original CSP
header. This was a hypothesis, not an assumption that inheritance works.

All three arms used a page-scoped CDP session and request/response continuation.
For seven worker modes, the probe attempted an HTTP fetch and both WS and WSS.

| Worker mode | Control | Added policy: HTTP | Added policy: WS/WSS |
| --- | --- | --- | --- |
| External dedicated | HTTP 200; both sockets open | HTTP 200 | Both blocked |
| External shared | HTTP 200; both sockets open | HTTP 200 | Both blocked |
| Nested external | HTTP 200; both sockets open | HTTP 200 | Both opened |
| Document-created blob dedicated | HTTP 200; both sockets open | HTTP 200 | Both opened |
| Document-created blob shared | HTTP 200; both sockets open | HTTP 200 | Both opened |
| Document-created data dedicated | HTTP 200; both sockets open | HTTP 200 | Both opened |
| Nested blob | HTTP 200; both sockets open | HTTP 200 | Both blocked |

An original strict `connect-src 'none'` policy remained restrictive in every
mode after appending the candidate policy: zero HTTP or socket hits. Original
duplicate CSP headers were preserved. No CDP handler errors were recorded.
The page-scoped session did not intercept the nested external worker script
response. The blob/data results also disprove assuming effective inheritance
from injected document headers; the probe does **not** establish that root cause.

[Captured evidence](evidence/worker-csp.jsonl) includes server hits, response
coverage, injected policies and runtime version. The retained
[manual probe](../scripts/probes/worker-csp.mjs) requires installed workspace
dependencies, the pinned Chromium binary, Node and OpenSSL. It uses only owned
loopback servers and a disposable browser; its in-memory test certificate and
certificate-error exception are fixture-only, never production configuration.
Exit zero means the experiment completed, not that a security gate passed.
It has a 90-second execution deadline and explicit cleanup; the recorded run
reported the owned browser stopped and zero remaining sockets.

## Response delivery changes inheritance, but introduces another failure

A third bounded comparison retained the same seven modes and added two arms:
body fulfillment with the appended policy, and strict original policy plus
body fulfillment. It made no target-attachment expansion. The manual probe now
includes these arms rather than duplicating the fixture in a second script.

| Mode | Header-only appended policy | Appended policy with body fulfillment |
| --- | --- | --- |
| Document-created blob dedicated/shared | HTTP 200; WS/WSS opened | HTTP 200; both sockets blocked |
| Data dedicated | HTTP 200; WS/WSS opened | Sockets blocked, but HTTP failed with zero server hits |
| Nested external | HTTP 200; WS/WSS opened | HTTP 200; both sockets still opened |
| Other tested worker modes | HTTP 200; sockets blocked | HTTP 200; sockets blocked |

Both strict-original arms remained restrictive, every page URL matched its
expected URL, and no CDP handler errors occurred. Runtime Chromium was again
151.0.7922.34; the run completed once and reported the owned browser stopped
and zero remaining sockets. [Captured output](evidence/worker-csp-delivery.jsonl)
retains response mechanisms, body lengths and per-destination hits.

This establishes a response-delivery effect, not its complete root cause. The
[pinned Chromium interceptor source](https://github.com/chromium/chromium/blob/151.0.7922.34/content/browser/devtools/devtools_url_loader_interceptor.cc)
replaces raw headers in the header-only path and creates new response metadata
for a body override. Stale parsed-policy state is a candidate explanation, not
a verified diagnosis. The data-worker HTTP failure also needs a separate
diagnosis; blocking ordinary traffic is not a successful security control.
Final-URL checks here do not establish general cookie, origin, compression or
redirect compatibility. **T1 remains unpassed.**

## Design consequence and next bounded question

### T1a: native policy versus body fulfillment

The fresh-baseline comparison ran twice on 2026-09-06 against runtime Chromium
151.0.7922.34. The [retained second run](evidence/worker-csp-inheritance.jsonl)
contains all 36 cases, final server-hit reconciliation and cleanup. The first
run guided diagnosis; only the complete second run is retained here.

Run `node scripts/probes/worker-csp.mjs --inheritance` from the repository root.
This selects nine arms across external dedicated, document blob dedicated,
document blob shared and document data dedicated workers. Native arms have no
Fetch interception; continuation, server-policy replay, no-added-policy replay,
injected-header and strict-intersection controls isolate delivery effects.
The nested-worker gap is deliberately outside this comparison and remains open.

| Delivery / policy | External and blob worker HTTP | Data worker HTTP | WS/WSS |
| --- | --- | --- | --- |
| Native or CDP continuation, no added policy | 200 + sentinel | 200 + sentinel | All opened |
| Server-delivered candidate policy, native or CDP continuation | 200 + sentinel | 200 + sentinel | All denied with matching worker CSP violations; zero upgrade hits |
| Header-only injection | 200 + sentinel | 200 + sentinel | External denied; blob/data both opened |
| Body replay without added policy | 200 + sentinel | Failed, zero HTTP hits | All failed without CSP violations; not valid enforcement evidence |
| Body replay with server-delivered or injected candidate policy | 200 + sentinel | Failed, zero HTTP hits | All denied with matching CSP violations |
| Body replay retaining original strict policy | Denied | Denied | Zero HTTP/upgrade hits; matching strict-policy violations |

The data-worker HTTP failure therefore reproduces **without adding a connection
policy**. Native server-delivered policy preserves that HTTP request; replaying
the same policy does not. This implicates the tested body-fulfillment path,
independently of whether CSP is injected. It does not identify the underlying
Chromium cause, nor prove that all forms of fulfillment fail.

All three non-strict data-worker HTTP failures were immediate `TypeError`s,
not deadline aborts, with opaque worker origin `null`. Each has a correlated
Fetch response-stage `responseErrorReason: Failed` and no worker HTTP CSP
violation. The strict arm recorded HTTP violations, validating the recorder's
positive control. Page-scoped Network/console diagnostics were empty: absence
there does not prove absence of a worker-side CORS or local-network error.
At that stage, the loopback fixture was a scope limitation and local-network
checks were still a hypothesis. The worker-scoped follow-up below identifies
Chromium's blocking reason, but not its underlying metadata cause. No additional CSP, CORS or
local-network bypass flags were used. The existing fixture-only TLS certificate
verification exception remains; no host certificate store was changed.

The probe now recognizes both status and error fields when classifying response
pauses, following the [CDP Fetch event contract](https://chromedevtools.github.io/devtools-protocol/tot/Fetch/#event-requestPaused).
It records original/final replay headers, body hashes/lengths, worker policy
violations, abort state, origins, HTTP methods and final server hits. The retained
run had no handler errors or dropped diagnostics and ended with its owned
browser stopped and zero sockets. Existing historical evidence is unchanged.

Validate the evidence offline with:

```bash
node scripts/probes/verify-worker-inheritance.mjs docs/evidence/worker-csp-inheritance.jsonl
pnpm test:probes
```

The verifier rejects missing cases, failed native positive controls, wrong HTTP
bodies, late server hits, unsupported denial claims, handler failures and failed
cleanup. Its `fixtureValid: true` explicitly accompanies
`securityAcceptance: false`: CI checks the evidence verifier, not live worker
enforcement. This comparison does not close T1 or R4.

### Worker-scoped follow-up: observed local-network denial

The [dedicated-worker diagnostic run](evidence/worker-network-diagnostics.jsonl)
retains 27 cases on runtime Chromium 151.0.7922.34. Every HTTP/WS/WSS outcome and
server-hit tuple matches the corresponding T1a case. Shared and nested workers
were deliberately excluded; this is not an all-target interception experiment.

| Observed failure | Worker-scoped evidence | Conclusion |
| --- | --- | --- |
| Data-worker HTTP in all three non-strict replay arms | Correlated `Network.loadingFailed`, `net::ERR_FAILED`, `corsErrorStatus.corsError: LocalNetworkAccessPermissionDenied`; no HTTP CSP violation or server hit | Chromium denied local-network access to the loopback fixture, not an observed CSP denial |
| WS/WSS without added connection policy, under replay | `Network.webSocketFrameError` reports `ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS`, correlated to each socket URL | These failed socket controls are not policy-enforcement evidence |
| Native external-worker initial request | Response and completion captured, but `requestWillBeSent` missing | The observer does not establish complete pre-execution coverage |

This identifies the **browser's reported blocking reason**, not why replay
changes the local-network decision. Changed response/security metadata remains
an unverified explanation. The fixture does not establish a general failure of
data-worker requests to public destinations. Do not disable local-network
checks, grant broad permissions, or weaken CSP as a production workaround.

The test-only [child CDP bridge](../scripts/probes/child-cdp.mjs) uses the pinned
browser's deprecated non-flattened message path, not Playwright private objects.
It bounds pending commands, enforces deadlines, correlates inner command replies
by child session, and rejects outstanding work on detach. The
[CDP Target contract](https://chromedevtools.github.io/devtools-protocol/tot/Target/#method-setAutoAttach)
supports pause-on-attach, but Playwright is another debugger client and can also
resume workers. All 27 enable/resume acknowledgements were recorded; most
requests arrived before the resume acknowledgement. Neither an acknowledgement
nor `waitingForDebugger: true` proves control of worker startup. A production
design must establish that invariant separately.

Two diagnostic runs completed. The first stdout was truncated by the capture
tool because request initiator stacks repeated embedded worker source. The
second projects request/response identity fields while retaining full failure
fields; its complete output is retained. It records 27 detaches with no pending
commands, nine empty observer cleanups, no handler errors or dropped diagnostics,
and final browser/socket cleanup. No additional bypass flags were introduced;
the pre-existing fixture-only TLS exception remains.

```bash
node scripts/probes/worker-csp.mjs --worker-network
node scripts/probes/verify-worker-network.mjs docs/evidence/worker-network-diagnostics.jsonl docs/evidence/worker-csp-inheritance.jsonl
pnpm test:probes
```

The offline verifier checks matching baseline outcomes, response/completion
coverage, correlated failure reasons, socket attribution, and observer cleanup.
It reports the missing native request-start event explicitly and always returns
`completePreExecutionCoverage: false` and `securityAcceptance: false`.

Next: independently prove target startup ordering and recursive coverage, and
test a metadata-preserving response mechanism before selecting production
transport. The native control is sufficient to establish the observed response
and outcome, not complete request-start capture. T1 and R4 remain open.

The [accepted two-profile decision](egress-transport-design.md) is unchanged.
OS-enforced gateway-only routing remains required for the contained profile,
but cannot itself distinguish WSS inside an allowed encrypted CONNECT tunnel.
Neither page JavaScript hooks nor the tested header-injection approach supplies
the missing semantic upgrade control. T1 is not complete; T3/T4 cannot claim a
release-ready contained browser by composing these failed candidates.

Before another production adapter change, establish an effective browser-owned
upgrade restriction across the complete target/policy lifecycle. Recursive
target attachment is necessary for the demonstrated nested-script gap, but is
not evidence that blob/data inheritance works. T1a now separates native policy
behavior from the loopback replay failure; the observed local-network denial
does not explain the changed local-network decision or establish a compatible policy-delivery
mechanism. Preserve ordinary
worker HTTP requests and stricter origin policies in every control.

Do not silently disable workers, remove the WebSocket guarantee, substitute TLS
interception, or install a CA to make the fixture pass. Any such trade-off needs
an explicit design decision. Keep the independently reviewed corrective PRs
moving while this bounded feasibility question remains open.
