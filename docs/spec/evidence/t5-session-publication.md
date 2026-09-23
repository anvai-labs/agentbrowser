# T5 A2a: shared session publication boundary

Status: session primitive implemented; application/HTTP/replay publication unqualified.
Base: develop `3dad07c` (A1, PR #269).
Design: [J1-A finalization/publication](../design/t5-finalization-publication.md).

## Single owners and observable behavior

`SessionAuthority.run` accepts an optional trusted-host `SessionPublication<T>` after
its existing failure classifier. The execution, classification, pending-work tracking
and finalization path is shared. Calls without it retain their current return/background
drain behavior. No second executor or ticket is created. `SessionControl` remains the
single record, finalization, exclusion and duplicate owner.

Publication waits for admitted work to drain, finalizes execution, invokes the bounded
publisher with the original value and frozen context, then releases the captured ticket.
The context contains terminal status, a cancellation signal and an output-only guard.
Status can be outcome_unknown even if the work callback returned a value. Publication
failure cannot rewrite execution facts. The publisher's return value is not the result.
Execution/read guards remain closed during publication; the output guard cannot admit
work. Shared captured-owner checks detect takeover, expiry and session-ID replacement.
The output guard checks monotonic expiry before actual output and after callback
completion, and becomes unusable before release, including after success.

The private bounded-wait helper is extracted from outcome-runner with the same runtime
algorithm. Both consumers reuse its timer/listener cleanup and late-rejection handling;
only its input type broadens to PromiseLike. Wait completion does not forcibly stop the
callback. A publisher MUST check its guard immediately before actual output. A callback
with raw, unguarded output capability cannot be made safe by a timeout wrapper, and no
transport integration is qualified here.

## Precise cancellation and limits

Options are snapshotted and validated before admission/effects. The timeout is a required
integer from 1 through 60,000 ms, defined once at this owner, with no default. Its clock
starts after execution/drain, not at operation admission. The optional signal is explicitly
publication-only: cancellation during or even before work suppresses eventual publication,
but does not cancel that work or free its ticket. It is not HTTP request cancellation.
An uncooperative effect can still keep the owner draining; no overall operation timeout
is promised. Abort/timeout closes output authority before release and consumes late
publisher rejection. A signal's non-aborted state is never a substitute for the guard.

The copied context is frozen; the result payload is not generically cloned or canonicalized.
The eventual publisher owns its existing schema/byte bounds and application authorization.
No persistence, credentials, app permission check, response draft, socket or mode is added.

Duplicates return existing replay/status without invoking the publisher or borrowing the
original ticket. This limitation is intentional until A4 supplies freshly authorized
snapshot publication. Do not wire this primitive into HTTP with an unguarded replay fallback.
No current REST, SDK, CLI or MCP route passes publication options.

## TDD and validation

The initial publication suite produced 18 failures and one pass against A1: the old run
ignored publication options. Callback-entry timeouts also produced six secondary rejected
assertion reports. After implementation all initial 19 cases passed without unhandled
errors; four additional lifetime/validation cases bring publication coverage to 23 tests.

All 441 control tests passed, including outcome-runner's unchanged 30-test contract and
legacy authority/drain cases. Covered boundaries include:

- finalized status while busy; output-only authority; retained guard refusal after release;
- waiting for drain before starting the publication timer; explicit unknown status;
- callback failure, timeout, cancellation and late rejection preserving execution facts;
- takeover, replacement, session expiry and delayed-timer deadline checks;
- invalid options before effect, caller option mutation and cancellation in scheduling gaps;
- cancellation during abandoned-effect drain, anonymous admission and post-callback checks;
- duplicate publication exclusion and preservation of a thrown undefined work error.

The 18 affected API coexistence tests and 11 spec-loader tests also pass; all 82 context
selections and documentation links validate. Independent compiled probes confirmed
scheduling-gap cancellation, sticky deadline refusal after clock rollback, replacement
owner exclusion, timeout guard closure and consumption of late rejection.

Normal hooks, exact-head adversarial review and PR/post-merge CI remain delivery gates;
this record does not predeclare those outcomes.

## Next implementation gate

A2b must compose application-owned permission/binding checks with the session output
guard. Session ownership alone cannot detect permission revoked during publication.
Reuse the existing application owner and final callback/pin ordering; do not weaken
execution-only receipt/source guards or pass a publisher to application adapters.
A3 then migrates actual HTTP handlers to inert response drafts and proves ordering
with real loopback HTTP, including disconnect/late-send and error/header parity.
A4 closes replay publication. Journal integration stays gated behind those steps.
T5 remains ~10% foundation progress and 3/9 finite milestones complete; 1.9.1 unchanged.
