# Post-v1.8.4 transport milestones: integration contract for co-design

Status: **T2a and T2b0-T2b2 shipped in v1.8.5; M2 complete; T2c1 in progress.**
Current release baseline: `v1.8.5`, commit `b9ef2fd`; see the
[verified delivery checkpoint](release-milestones.md#baseline-and-release-boundaries).
The [M2 gateway design](session-gateway-m2-scope.md) merged in PR 103.
T2c1 now implements policy/admission prerequisites; no CONNECT listener or
upstream-supported browser API is selected.
T1/R4 remain open. The inquiry and T1d evidence below are historical decision
artifacts, not authorization for another diagnostic experiment.

## Recommendation

Seek a supported lifecycle integration with Playwright before committing to a
private patch or replacement driver. Preserve the existing engine-neutral
contract and Playwright action/observation implementation. Require two distinct
controls: network admission before the first request, and acknowledged target
initialization before execution. A pre-resume hook alone cannot meet both.

Do not start a fork while waiting for upstream, and do not broaden the probe
matrix to make T1d resemble T1b. The owner authorized the bounded integration
inquiry and local T2a work on 2026-09-07. Separately scope reusable T2 connection mechanics; they can
progress without a browser lifecycle solution, but cannot close T1/R4 or make
the contained profile available. The [inquiry is prepared but unsent](playwright-integration-inquiry.md):
upstream directs support questions to Discord, and no connected channel is
available here. Do not misfile it as a bug or assume a supported hook exists.

## Evidence and support boundary

T1d's two captures each retain 27 successful native worker controls. Neither
the sole-owner nor competing-owner arrangement produced a sentinel before the
delayed owner's release. Every initial worker-script request preceded that
release. Distinct socket/session topologies and launch settings separate this
experiment from T1b; their causal contribution remains unresolved. See the
[immutable evidence and limitations](egress-transport-feasibility.md#sole-owner-comparison-independent-sockets-do-not-reproduce-t1b).

Source/API inspection refreshed on 2026-09-07:

- The installed Playwright 1.62.1 `FrameSession._onAttachedToTarget` registers a
  worker, requests network-session setup, sends its own resume command and
  configures recursive attachment. These private implementation details are
  inspection evidence, not extension points we may safely call or override.
- The public [newCDPSession API](https://playwright.dev/docs/api/class-browsercontext#browser-context-new-cdp-session)
  accepts a Page or Frame. The [Worker API](https://playwright.dev/docs/api/class-worker)
  exposes worker observation/evaluation; these documented interfaces do not
  promise the two admission controls above. This inspection does not prove
  every possible supported integration impossible.
- [CDP auto-attachment](https://chromedevtools.github.io/devtools-protocol/tot/Target/#method-setAutoAttach)
  describes related-target attachment and startup waiting. That description is
  not evidence of first-request admission or exclusive lifecycle ownership in
  AgentBrowser's arrangement. Tip-of-tree documentation is not a pinned-browser
  compatibility test.

## Required integration contract

The following is a behavioral contract to evaluate with maintainers, not new
TypeScript interfaces to export before an implementation exists.

| Requirement | Concrete owner and behavior | Falsifying acceptance evidence |
| --- | --- | --- |
| First network request | Adapter/browser integration establishes request admission before allowing target creation or dispatch; gateway independently validates every new destination connection | Denied initial document, popup, worker script or service-worker request reaches an upstream endpoint before authorization |
| Initialization ordering | One coordinated initializer owns recursive registration, policy installation acknowledgements and the release decision; another client cannot silently release a guarded target | Earliest untrusted script executes before all required setup acknowledgements; setup failure or disconnect permits execution |
| Identity and lifetime | Session authority plus target generation and request IDs scope state; parent lineage is explicit and is not inferred from URL equality | Same-URL concurrent chains exchange redirects, policy, credentials or completion; an old generation authorizes a replacement target |
| Native response semantics | Browser retains redirect/method/cookie/origin/history behavior; an effective response and channel gate must separately pass compatibility controls | Duplicate POST, changed final origin, missing cookie, incompatible data-worker HTTP, or forbidden worker WS/WSS endpoint hit |
| Revocation | Session close first rejects new admissions, cancels pending initialization/I/O and revokes established gateway tunnels; failure terminates owned resources without direct-network fallback | Late callback releases after close, tunnel survives revocation, orphan socket/process or operation never settles |
| Bounded state | Runtime owners bound admitted targets, requests, pending commands, queued bytes and deadlines; saturation rejects before allocating additional unbounded work | Target/request flood grows state past declared limits or cleanup leaves entries after terminal outcomes |
| Observable failure | Existing typed engine errors and injected redacting logger remain the boundary; one terminal request outcome, bounded denial/admission/cleanup counters | Duplicate terminal events, untyped surface errors, secret-bearing URL/headers, or unbounded diagnostic payload |

The first-request gate must already cover the script fetch while the later
execution gate initializes the target. Do not delay target interception until
its worker-created notification. An unsupported target class is an explicit
capability failure for guarded mode, not a silent exclusion from its guarantee.
Normal worker HTTP controls remain mandatory; disabling workers is not a fix.

For each target generation, the proposed lifecycle is:

`admitted with network gate active -> initializing -> ready -> closing -> closed`

Initialization failure transitions to closing, never ready. Session revocation
invalidates every generation's release authority. Late acknowledgements may
settle pending operations but cannot authorize dispatch or change closed state.
Per-request completion has one idempotent terminal owner. This state model is a
design requirement; it does not claim existing CDP hooks can implement it.

Keep target/request Maps inside the adapter and connection Sets inside the
gateway; index by identities, not scans over URL lists. Specify numeric caps,
deadline coverage and overload error semantics in each implementation PR before
coding. Bounded application state is not an OS memory or temporary-disk quota.
Raw CDP objects and gateway credentials never cross into core or public surfaces.

## Decision-ready integration question

The owner-authorized inquiry asks Playwright maintainers:

1. Is there a supported way to coordinate all target initialization before
   resume while keeping Playwright's normal browser semantics and lifecycle?
2. Where can admission cover initial document/worker requests that precede a
   target's execution pause, including popup, frame and service-worker paths?
3. What ordering, cancellation, detach and version-compatibility guarantees
   would that integration support? Which target classes are explicitly outside it?

Present T1b/T1d as differing observations, not an attributed Playwright defect.
Share only the minimal synthetic reproducer and relevant command chronology
after approving the submission text; do not upload private browsing data or the
whole repository. A positive response still needs a pinned-version prototype
and the complete [acceptance matrix](egress-transport-design.md#acceptance-matrix).
Silence or an unsupported answer is not permission to maintain a private patch.

## Cohesive next milestones

The owner approved T1 inquiry and T2a design work. Later implementation rows
remain proposed review boundaries, not an approved fork or deployment plan.
Keep one active delivery branch and independently review each completed unit.

| Unit | Proposed scope | Risk / effort | Exit and dependency |
| --- | --- | --- | --- |
| T1e | This integration contract and owner decision | High decision impact / small documentation unit | Inquiry authorized and prepared; sending awaits support-channel access. No maintained fork/patch approved; T1 remains open |
| T2a | [Connection-authority design and test contract](connection-authority-design.md), grounded in the existing direct-download transport | High security risk / small-to-medium design unit | Complete, PR 91; T2b prerequisites also delivered |
| T2b | Implement the approved connection primitive and regression fixtures | High / medium | T2b0-T2b2 complete, PRs 92-94, shipped v1.8.5; does not certify browser traffic |
| T2c | Authenticated session gateway with bounded admission and revocation | High / large; three sequential units after design acceptance | [M2 design](session-gateway-m2-scope.md) complete in PR 103; T2c1 policy/admission in progress; CONNECT wire, credentials and gateway lifecycle remain T2c2/T2c3 |
| T1 implementation candidate | Supported lifecycle and semantic-gate prototype | High / unknown until a concrete supported seam exists | Requires T1e decision; full target/native-positive controls and pinned-browser evidence, not only worker pause timing |
| T3 | Compose guarded Chromium and retire competing request owners for that mode | High / large | Blocked on passing T1 and T2; complete end-to-end matrix before availability |
| T4 | Scoped Linux forced-egress profile | High / large | Required before contained release; actual DNS/UDP/loopback/proxy-bypass tests; separate deployment authorization |

T2a started from [download-transport.ts](../packages/api/src/download-transport.ts),
not a speculative utility package. The shipped caller now delegates TCP
authority while retaining redirects, HTTP/TLS semantics, response decoding
and buffering. Preserve that separation when scoping the gateway consumer.
Keep `policy` free of sockets and concrete engines. A same-runtime API gateway
shares private transport modules in place; extract a package only with a real
second package/runtime consumer. Never make an engine import `api` to reuse
the helper. Capability and error contracts
belong in `engine`/`protocol` only when their real consumers are identified.

Separate TCP destination authority from TLS ownership: the direct HTTPS client
retains its intended hostname for certificate verification, whereas an opaque
CONNECT gateway pins the TCP destination and the browser verifies end-to-end
TLS. Do not have the gateway terminate TLS or claim to validate the browser's
encrypted HTTP Host/response from tunnel bytes. Session authority belongs to
the coordinator; gateway data-plane credentials cannot grant administration or
be forwarded to the origin. T2a must settle these boundaries before extraction.

## Maintenance choice and stop conditions

| Path | Continuing obligation | Recommendation |
| --- | --- | --- |
| Supported upstream integration | Pin supported Playwright/browser versions; exercise lifecycle, native-semantics and egress matrix on every upgrade | Inquiry authorized; support-channel access pending. No delivery estimate until the seam is concrete |
| Private patch/fork | Own patch rebases, security update turnaround, distribution/provenance, compatibility matrix, rollback and a named maintainer | Not approved; return a concrete cost/ownership proposal before code or vendoring |
| Replacement CDP engine | Own actions, refs, observations, downloads and every engine contract as well as transport | Not approved; a separate product/maintenance decision, not a fallback hidden in T1 |

No new worker-topology experiment is selected here. Any follow-up must name the
decision-changing hypothesis, fixed controls and stop condition before running.
T2 completion cannot compensate for missing T1 browser semantics; an opaque
CONNECT tunnel cannot inspect encrypted redirects, body sizes or WSS upgrades.
The accepted ADR-008 network-isolation slice remains necessary for T4; full
multi-tenant scheduling/resource isolation stays deferred. Native/Brew use
remains supported; the open browser T1/R4 limitations are not closed by the
direct-download improvements shipped in v1.8.5.
