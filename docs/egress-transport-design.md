# Egress transport enforcement: accepted direction and delivery gates

Status: **Direction approved; implementation and verification pending.** After
the transport review, the owner approved the two-profile recommendation:
preserve native local operation; require OS-enforced egress for a contained
Chromium profile; do not block unrelated fixes on full Phase 4 delivery.
The [review tracker](engineering-review-remediation.md) retains R4 as open.
Approval covers staged engineering work, not a production deployment, host-wide
firewall change, certificate installation, or release. Existing guarded browsing
must not be described as complete SSRF containment while the gap below remains.

## Accepted deployment contract

| Profile | First delivery target | Required guarantee | Release condition |
| --- | --- | --- | --- |
| Local | Native/Brew managed Chromium | Adapter and gateway checks, with explicit absence of OS containment | Transport acceptance tests; no containment claim or silent mode switch |
| Contained | Linux managed Chromium in a restricted network environment | Browser network access only through its authorized gateway; application checks remain necessary | T1-T4 complete, independent adversarial review, real network-bypass tests; startup refuses missing enforcement |

These are deployment contracts, not shipped configuration flags. Native local
mode remains available; no automatic Docker/VM dependency is introduced there.
The contained profile must not be advertised as available before its release
conditions pass. A browser sandbox or ordinary Docker bridge alone does not
meet its network requirement.

Rationale: an interceptor can miss a request and a proxy can be bypassed; OS
rules outside the browser enforce the permitted network path. Conversely, OS
rules do not inspect HTTPS redirect counts or prevent misuse of allowed sites.
Only the combination supports the stated guarantees. Single-user operation
does not make page content trusted. Preserve local convenience by making the
guarantee explicit, rather than weakening the contained profile.

## Evidence and scope

Independent real-Chromium fixtures established:

| Probe | Result | Meaning |
| --- | --- | --- |
| Session-only policy plus loopback WebSocket | Original code connected; D correction closes before server connection | Session policy must install the same default WS guard as root policy |
| Direct download with `maxRedirects: 0` | D correction contacts only the initial URL | The direct transport can own every hop and the connection |
| Browser `/start` -> 302 `/payload`, limit zero | Before the experimental browser gate, both endpoints were contacted | Browser path ignored the redirect-count policy |
| Browser two-hop chain with a gate in `context.route` | First hop checked; subsequent hop escaped routing | Adding an ancestry scan to the route callback cannot solve missing callbacks |
| Additional CDP Fetch interceptor on one Chromium page | Request and response pauses for all three URLs; final document URL preserved | Mechanism feasibility only, not full target/lifecycle or network coverage |

Playwright documents first-URL-only redirect routing on
[Page.route](https://playwright.dev/docs/api/class-page#page-route); the installed
Chromium behavior was also reproduced through context routing. This is an
inherited gap: later-hop host, response and byte checks can be missed too.
The abandoned route-only experiment is preserved separately, not shipped as a fix.

CDP [Fetch](https://chromedevtools.github.io/devtools-protocol/tot/Fetch/) reports
redirect requests/responses and provides predecessor IDs. Its body stream API
requires either cancellation or supplying a replacement body after taking the
stream; it is not a transparent streaming forwarder. These are candidate
mechanisms to test against the pinned browser, not a portability guarantee.

## Recommended direction: two cooperating enforcement components

```text
Browser adapter: request identity, redirect chain, response policy
          | permits only validated requests / responses
          v
Session-authenticated egress gateway: destination + pinned connection
          |
          v
Validated upstream IP, retaining the intended HTTP host and TLS identity
```

Neither component substitutes for the other. The gateway must check destinations
independently; it must not trust an adapter's earlier allow verdict. The adapter
owns semantic request identity and response policy that an encrypted CONNECT
tunnel cannot inspect. The initial candidate is local managed Chromium; other
engines must earn equivalent guarantees through capability tests.

| Responsibility | Owner / concrete shape | Boundary constraint |
| --- | --- | --- |
| Policy rules | Existing pure `policy` package | No Playwright/CDP, socket code or surface-specific policy copies |
| Transport capability | Engine-neutral contract in `engine` | Explicit destination, redirect, body and upgrade capabilities; registration must not imply enforcement |
| Request lifecycle | Chromium adapter module | One owner for request/response completion; migrate from route-fetch fulfillment, do not leave two competing production owners |
| Redirect identity | Adapter state keyed by target/session/request ID | Count targets, excluding initial request; detect loops including the initial URL; no URL-only correlation |
| DNS and connect | Session-scoped gateway | Resolve every new connection; validate all answers; pin an allowed address; verify peer; no second unchecked lookup |
| HTTPS | CONNECT tunnel candidate, browser retains end-to-end TLS | No host-wide CA install, TLS interception or global certificate-error bypass |
| Response limits | Adapter before delivery | Header limit plus actual decoded-byte cap; finite per-request and aggregate buffers, concurrency and deadlines |
| Direct downloads | Shared connection/policy primitives | Transport still owns explicit redirect loop; reuse lower-level mechanics without importing the API package into engines |
| Session authority | Composition root / coordinator | Unforgeable gateway identity per session; restrict-only rules; revoke on close; never page-supplied tenant IDs |
| Audit events | Typed engine events, existing injected logger | Bounded queues; redact before retention; exactly one terminal outcome per request |

Keep implementation modules cohesive inside their runtime owners initially.
Extract a shared transport package only when both browser gateway and direct
download paths actually consume it. Do not add a generic utilities package or
route raw CDP objects through core/API/MCP/CLI/SDK.

## Request and resource invariants

1. Install enforcement before any target can execute or access the network.
   New tabs, popups, cross-origin frames and workers need explicit coverage.
   [Target auto-attachment](https://chromedevtools.github.io/devtools-protocol/tot/Target/)
   is a candidate mechanism; its recursion and interaction with Playwright
   require a dedicated compatibility fixture before adoption.
2. Keep the browser in charge of redirects, method rewriting, cookies, origin,
   history and relative-URL resolution. Do not fetch the chain into a final body
   and fulfill the initial URL: that changes document security and navigation
   semantics. Never preflight and replay a mutating request.
3. Validate each request before connection, and each redirect response before
   releasing its Location. Maintain separate IDs for concurrent chains even
   when URLs match. Map-based request state must have admission caps, deadlines
   and removal on terminal events, target detach and session shutdown.
4. A CONNECT gateway alone cannot enforce HTTPS response sizes or reconstruct
   exact redirect chains from concurrent traffic. Those remain adapter gates.
   Cross-origin connection reuse/coalescing must not bypass per-request host
   checks or misattribute session identity.
5. Treat bounded CDP body replay as bounded delivery, not zero-copy streaming or
   an OS memory ceiling. Verify compressed-body/header consistency, cookies,
   cache validators, range responses, empty/HEAD bodies and download behavior.
   Preserve duplicate headers, especially Set-Cookie; never forward gateway
   authentication credentials to an origin server or expose them to page code.
   If finite replay cannot support SSE/media streams, declare that limitation
   and refuse the mode explicitly; do not silently remove the cap.
6. Keep guarded WebSockets deny-all initially, unless a separately verified
   upgrade gate covers both ws/wss and all targets. Disable/refuse unsupported
   paths such as direct QUIC/WebTransport, proxy bypass and unguarded remote
   targets. Flags alone are not proof of forced network egress.
7. Startup is transactional: create gateway, install/verify target enforcement,
   then expose the session. Failure tears down both. Closing revokes new work,
   aborts streams, settles pending operations and terminates owned resources.
   Gateway/adapter failure must not fall back to direct networking.

## ADR-008: what changes, what remains deferred

[ADR-006](adr/006-network-egress-policy-ssrf.md) already rejected browser
interception alone as the complete boundary. This proposal implements that
missing transport responsibility; it does not reverse the decision to defer
full [ADR-008](adr/008-process-container-isolation.md) for trusted local use.

A configured proxy plus browser hooks is **not** containment against a compromised
browser process. For a hard no-bypass claim, the browser needs an OS-enforced
network boundary allowing only its gateway, including DNS/UDP and loopback
restrictions. That boundary is an ADR-008 integration seam, not a competing
per-route patch. Process-per-session by itself does not enforce network routing.

The accepted decision pulls the network-isolation slice forward as a release
requirement for the contained profile, not as a prerequisite for native local
use or unrelated corrective PRs. Browser processes must not be able to change
their network rules, access the container runtime socket, or reach gateway
administration endpoints. The gateway runs outside that restricted boundary;
only its authenticated data endpoint is permitted, with explicit session
revocation. Rules must be scoped to owned resources, never host-wide defaults.
Full hostile multi-tenant scheduling, cross-tenant CPU/memory isolation and
microVM tiers remain outside this proposal. Until OS enforcement is delivered,
describe local adapter/gateway guarantees precisely and retain that residual.

Remote CDP needs a gateway and enforcement boundary on the remote host. A local
proxy cannot protect an already-running remote browser by assertion. Safari's
guarded refusal and Obscura's experimental exclusion remain. Firefox/WebKit
need a proven interception adapter or a separately designed L7 gateway; do not
silently claim that Chromium CDP work secures them.

## Cohesive PR units and delivery gates

Implement these as separately reviewed units. T1 is a feasibility gate: if target
coverage or browser semantics cannot be preserved, stop and revise the design
instead of silently reducing its guarantees. No production rollout is implied.

| Unit | Scope | Risk / effort | Exit evidence | Status |
| --- | --- | --- | --- | --- |
| T0 | Correct current guarantees; retain multi-hop repro; agree threat/capability contract | High-priority truthfulness / small | Reviewer can reproduce bypass; docs distinguish shipped and proposed behavior | Direction approved; durable truth guard, independent review and full local checks passed; delivery pending |
| T1 | Bounded Chromium request/response lifecycle feasibility, pinned-version compatibility | High / medium | All target types, redirects and response gates; clean shutdown; no dual-owner race | One-page probe only |
| T2 | Authenticated gateway and shared connection primitives | High / large | DNS rebind, host/TLS identity, session revocation, concurrency and byte limits | Not started |
| T3 | Compose guarded Chromium mode; retire old route-fetch path for that mode | High / large | End-to-end acceptance matrix below, including normal site semantics | Blocked on T1/T2 |
| T4 | Forced-egress Linux deployment profile, ADR-008-compatible | High / large | Deliberate proxy/DNS/UDP bypass attempts fail at network boundary; cannot alter rules; fail-closed startup and teardown | Required for contained-profile release; not started |

Group D's already-written direct-download and WS corrections remain useful but
do not close R4. Deliver them only as an explicitly partial correction after
independent review confirms that disclosure; the all-hop finding stays open
through transport implementation. Keep B/C/E/F/G moving with their own review
gates, rebasing around held work after checking actual code dependencies. Never
merge an unapproved predecessor merely because it is in the local stack.

## Acceptance matrix

| Dimension | Required positive and negative fixtures |
| --- | --- |
| Redirects | Limits 0/1/N; relative/cross-origin Location; loops back to initial; denied second/third hop has zero destination hits |
| Browser semantics | Final URL, origin, relative assets, history; 301/302/303 vs 307/308 POST behavior; no duplicate mutations; cookies and auth stripping |
| Targets | Initial document, popup-first request, cross-origin frame, dedicated/shared worker, service worker policy, fetch/XHR, download |
| Connections | Changed DNS answers, mixed allowed/denied addresses, IPv4/IPv6 literals, redirects across hosts, TLS hostname failure, pooled connections |
| Bytes | Missing/false Content-Length, chunked, gzip/brotli expansion, slow headers/body, aborted streams; aggregate saturation and bounded rejection |
| Alternative channels | ws/wss, WebTransport/QUIC, WebRTC ICE/STUN/TURN, DNS, proxy bypass, reused remote context; verify zero forbidden server/network hits |
| Isolation/lifecycle | Concurrent sessions/chains with same URLs; cross-session gateway auth; credential stripping; revoke existing CONNECT tunnels; gateway death; target detach; close during connect/read; no orphan process/socket or retained chain |
| Observability | One redacted terminal event; typed policy/capability errors; counters for denials, queue rejection and cleanup failures |

First targets are now agreed: managed native Chromium for local mode, and
Linux managed Chromium for contained mode. Do not promise cross-engine
portability or streaming compatibility before T1 demonstrates it. Application
transport tests close their respective findings; only the T4 bypass tests
establish the contained profile's forced-egress claim.
