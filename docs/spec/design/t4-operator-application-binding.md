# T4 operator application binding — U0

Status: implemented candidate on develop `d4511ad` (#260); see
[qualification evidence](../evidence/t4-operator-application-binding.md).

## Scope and owners

Extend `packages/api/src/operator-panel.ts`, the existing same-origin `/operator`
document. Use the existing authenticated PUT/DELETE/GET session `/application`
routes and `ApplicationAuthority`; do not add endpoints, a frontend framework,
an adapter registry, application credentials, or an execution path. The deployment
owner supplies adapter/resource identifiers. Discovery describes the current
binding and operations, including `review: operator-submit`; it is not an adapter
catalog, business account verification, or complete-payload approval.

Allow bind/unbind only with attached, idle human control (HUMAN_ACTIVE or
RESUME_REVIEW). Server authorization remains authoritative. Show unavailable
discovery separately from a confirmed unbound response. Inputs and returned
descriptors use ordinary labels/textContent, never interpolated HTML. The existing
CSP, no-store response and tab-memory bearer credentials remain in force.

## Shared UI state and races

Extend the panel's existing api/handle/refresh owners. Every local control action,
attach, reconnect and forget advances a document request generation. Capture that
generation for requests and discard superseded successes AND failures before they
can modify UI state. Capture credentials/session and intent at action start; guard
follow-up requests and catch/finally too, so an old create cannot send a page
request after Forget/reconnect or clear a newer pending action. Invalidate an older poll when starting an action; serialize
poll refreshes. Forget must work during a pending request and immediately clear
credentials, tokens, page reviews, application details and identifier inputs.
Discarding a response does not cancel or undo a server mutation.

A binding attempt clears local review/token/page evidence and cached discovery
before sending, including refusal/lost-response cases. Read back current control
and discovery after completion; do not automatically repeat PUT/DELETE. A fresh
review is required before delegation. Attach clears prior state immediately.
Existing controls share the same generation guard rather than bespoke application
request logic. Clear stale delegation review when authority/epoch changes.

Discovery is an observation, not a lease: bracket it with control reads and publish
only with matching state/epoch/busy/cursor. Hide cached discovery outside idle human
control or after failed refresh. Backend admission protects concurrent takeover and
binding changes; the panel does not claim an atomic remote snapshot or global lock.

## TDD and qualification

Extend the existing real-Chromium operator qualification using the existing server,
SDK and synthetic application owner. Cover bind/discover/unbind, declared review
requirements, fresh review after rebinding, unknown/unauthorized targets, busy/agent
control and revoked permission. Delay actual HTTP responses to prove that attach,
forget/reconnect and newer actions fence older control/discovery responses. Check
keyboard activation and text-only rendering. Keep fixture setup shared and assert
observable UI plus server state; do not copy production authority logic into tests.

Run targeted regressions first (record failure before implementation), then existing
hooks and CI jobs. Independent adversarial review must be clean before merging the
exact tested head. No new CI job or release is required.

## Remaining gates

Receipt reconciliation UX (explicit operation ID, authorized lookup, unknown outcome
without default Retry) is U1. Actual deployment adapters, production source contracts
and an independent production UI/API oracle remain P0c/P1. U0 alone cannot complete
T4 or qualify a live ATS workflow; eligibility E0c/E1 remain separate T6 work.
