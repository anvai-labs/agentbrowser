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

The next investigation was to independently test target startup ordering and recursive coverage, and
test a metadata-preserving response mechanism before selecting production
transport. The native control is sufficient to establish the observed response
and outcome, not complete request-start capture. T1 and R4 remain open.

### T1b: target attachment does not establish startup ownership

The [startup probe](../scripts/probes/worker-startup.mjs) isolates pause ownership
from response replay: native HTTP delivery, no Fetch/Network domain enablement,
no injected CSP, no certificate bypass, no permission grants. Each of three arms
(native, nonrecursive observer, recursive observer) runs seven worker modes in
fresh contexts. Nested depth 2 means a parent worker and one worker-created child.
Each worker immediately starts its uniquely identified HTTP sentinel request;
the parent creates its child without awaiting its own fetch. Workers stay alive
until context cleanup. Shared workers use unique URLs/names and remain explicit
positive controls, not silently disabled features.

One Node monotonic clock records attachment, recursive setup acknowledgement,
server receipt and this client's release invocation. For every attached target,
this client delays its own release invocation by at least 200 ms; recursive
setup is acknowledged before that invocation. `release-dispatch` is recorded **before calling the bridge's send
method**, whose actual outer dispatch occurs in a microtask. It is therefore a
lower bound, not a socket-dispatch timestamp. A server hit before this marker
definitively precedes our command; a later hit would only be bounded observation,
not proof that execution was impossible during the hold.

Two retained runs on Playwright 1.62.1 / Chromium 151.0.7922.34, macOS arm64:
[initial capture](evidence/worker-startup.jsonl) and
[reviewed-cleanup repeat](evidence/worker-startup-reviewed.jsonl). Each contains
21 cases and 27 worker HTTP 200 / exact `worker-startup-ok` body / matching GET
controls. Both have the same classification for every worker:

| Arm | HTTP controls | Attached workers executing before our release | Executing without observer attachment |
| --- | --- | --- | --- |
| Native | 9/9 | Not applicable | No diagnostic observer installed |
| Nonrecursive | 9/9 | 5/5 | Two nested children and two shared workers |
| Recursive | 9/9 | 7/7, including both nested children | Two shared workers |

All 12 attachments report `waitingForDebugger: true`, yet their server hits
precede this client's release by approximately 189–201 ms in the first run and
199–201 ms in the repeat. Recursive child sessions are routed through their
actual owning parent session; URL digests map those identities to distinct
worker tokens. Recursion improves observation but does **not** supply startup
control in this additional-client arrangement. The worker-only filter and
page-rooted topology do not attempt shared-worker coverage; successful shared
requests are reported as uncovered, not as a browser-wide impossibility claim.

[CDP documents](https://chromedevtools.github.io/devtools-protocol/tot/Target/#method-setAutoAttach)
related-target attachment (including existing targets) and recursive setup.
Neither an attachment flag nor an acknowledgement proves exclusive pause
ownership. Inspection of pinned Playwright's `FrameSession._onAttachedToTarget`
also finds its own `Runtime.runIfWaitingForDebugger` and recursive auto-attachment.
That is a plausible competing-resumer explanation, **not a causally isolated
attribution**: this probe did not disable or trace Playwright's own resume command.

Both runs end with zero pending commands, tasks, owned observer listeners and
HTTP sockets. Parent detach is observed; the two nested detach events are not,
so no complete detach-event claim is made. Descendant bridges are explicitly
closed. Independent review found that browser-close rejection could previously
skip HTTP cleanup. The repeat uses hardened cleanup that records failures and
attempts each resource close independently, with 2-second per-operation bounds
and browser-process kill fallback. Launch/connect each have 10-second timeouts;
the 90-second execution watchdog begins **after** connection, not at process entry.

```bash
node scripts/probes/worker-startup.mjs
node scripts/probes/verify-worker-startup.mjs docs/evidence/worker-startup-reviewed.jsonl
pnpm test:probes
```

The offline suite validates both captures, exact positive controls, target
lineage, own-child versus parent release ordering, matrix completeness and
cleanup failures. It also tests nested bridge response routing and close-before-
dispatch cancellation. Successful verification means valid diagnostic evidence;
`securityAcceptance` and `completePreExecutionCoverage` remain false.

**T1b startup acceptance failed; T1/R4 remain open.** Do not build a production
pause gate around this second CDP client or equate recursion with enforcement.
T1c should reassess a browser-owned upgrade restriction or a coordinated, sole
target-lifecycle owner before selecting an implementation. A pure-CDP control
without Playwright would be a bounded next causal experiment, not a replacement
engine decision. Shared workers, frames, popups, lifecycle changes, policy
inheritance and HTTP/WS/WSS compatibility still require the full acceptance matrix.

### Sole-owner comparison: independent sockets do not reproduce T1b

The bounded comparison specified by the
[T1c reassessment](egress-transport-reassessment.md) is now implemented in
[sole-owner.mjs](../scripts/probes/sole-owner.mjs). It directly spawns the pinned
Chromium headless-shell executable with an owned temporary profile. Playwright
package metadata supplies the expected version, but no Playwright module is
loaded and no Playwright client is connected. Raw CDP uses flattened sessions
over one browser WebSocket connection, or two physically separate connections
in the competitor arm. Both owners configure page auto-attachment before any
worker is created and recursively configure each worker before releasing it.

The same serialized worker body is shared with T1b, with a SHA-256 truth guard
confirming byte-identical extraction. Native HTTP delivery, the exact sentinel
body and unique parent/child tokens are unchanged. The scope is only an external
dedicated worker and a depth-two external worker chain: three arms, three repeats
per arm, 18 cases / 27 worker results. No Fetch, CSP injection, body replay,
certificate bypass, permission grant, new target mode or production adapter was
added. Initial script requests are counted separately from startup sentinels.

Two complete runs are retained: [initial](evidence/sole-owner.jsonl) and
[reviewed instrumentation](evidence/sole-owner-reviewed.jsonl). Runtime version
is checked against the installed Chromium manifest (151.0.7922.34 / revision
1234); each case fails on a mismatch. Both runs have identical classifications:

| Arm | Successful HTTP 200 / exact body / GET controls | Sentinels before primary release | Meaning |
| --- | --- | --- | --- |
| Sole owner, immediate release | 9/9 | 0 | Positive execution/network control |
| Sole owner, 200 ms delayed release | 9/9 | 0 | No early execution observed in this bounded window |
| Delayed primary plus immediate competitor | 9/9 | 0 | Does **not** reproduce the T1b early-execution result |

The competitor is not a nominal label: it attaches through a distinct socket
and distinct owner-local sessions to the same worker target IDs. Its nine
release invocations precede primary release by approximately 199–200 ms in the
initial run and 200–202 ms in the repeat; their acknowledgements also precede
primary release. Nevertheless, competitor-arm sentinels arrive approximately
1.5–2.5 ms **after** primary release. All 36 owner/worker attachments report
`waitingForDebugger: true`. This is not proof of a universal multi-debugger
barrier, nor proof that a production lifecycle owner has been found.

Every worker's initial script request occurs before primary release (27/27 in
each run). That observation reinforces the separation between execution startup
and network admission. The fixture allows these requests deliberately; it does
not install or certify first-request policy checks.

The topology differs from T1b in identifiable ways. Pinned Playwright 1.62.1
`CRBrowserContext.newCDPSession` uses `_clientRootSession`, whose
`CRConnection.createBrowserSession` issues `Target.attachToBrowserTarget` on the
existing browser connection. Thus T1b's additional public CDP session is not a
second physical browser connection. T1b also mixes non-flattened diagnostic
worker sessions with flattened Playwright sessions; this comparison is flattened
throughout. The directly launched probe uses identical flags across its own
arms, but not all Playwright launch defaults. Exact probe flags are retained in
the environment row. These are **candidate differences, not an isolated cause**.
Neither a Playwright bug nor its historical resume command is attributed by
this experiment. The result was retained without tuning the topology or adding
an arm to manufacture early execution.

Both complete runs end with no fixture errors, zero pending commands/tasks or
HTTP sockets, the spawned browser process exited and its disposable profile
removed. The repeat explicitly records closed connections, removed router
listeners and auto-attach parameters. Independent review found malformed JSON
envelopes such as `null` could throw from the raw router; six failing regressions
reproduced this before shape validation was added. An earlier attempt failed
pnpm metadata-path resolution before launching a browser and produced no
experimental result. Launch discovery, CDP connection/commands and browser-exit
waits have explicit deadlines. HTTP-server closure and profile removal are
awaited; there is no whole-cleanup hard deadline. The case watchdog is 90 seconds,
not a process-entry bound.

```bash
node scripts/probes/sole-owner.mjs /absolute/path/to/pinned/chrome-headless-shell
node scripts/probes/verify-sole-owner.mjs docs/evidence/sole-owner-reviewed.jsonl
pnpm test:probes
```

The 79 offline probe tests include matched commands/acknowledgements, owner-local
session lineage, cross-owner target identity, positive HTTP/script counters,
release ordering, cleanup, malformed transport input and setup-failure refusal.
An early competitor hit is classified as falsifying evidence, not rejected as
a bad control. The verifier always returns `securityAcceptance: false` and
`completePreExecutionCoverage: false`.

**Planned stop condition reached:** this independent-socket arrangement does not
reproduce T1b, so it cannot justify a production integration or replacement
engine. Reconcile the supported lifecycle integration contract before selecting
another mechanism. Current public API inspection still exposes no pre-worker-
resume handshake; any maintained private patch, fork or replacement engine needs
explicit scope and maintenance approval. Upstream issue/PR submission also
requires separate authorization. Do not automatically expand the diagnostic
matrix. The semantic-delivery/WS gap remains independent and unresolved.

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
