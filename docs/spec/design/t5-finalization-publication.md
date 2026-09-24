# T5 J1-A: execution finalization and response publication

Status: A1/A2/A4a/A3a primitives implemented; partial A3b HTTP candidate; recovery gated.
Design baseline: develop `dbe23b5` (J0, PR #267).
Parent: [T5 journal sequence](t5-operation-journal.md). Next contract:
[J1-B/C journal acknowledgment](t5-journal-contract.md). No durability ships here.
Read this module only when implementing the response boundary, not in default modes.

## Why the boundary must change first

The current code has three coupled lifetimes:

| Existing owner | Observed behavior | Consequence |
| --- | --- | --- |
| `api/server.ts`, `route` | Awaits a handler that calls `reply.send` inside `SessionAuthority.run` | A response can precede operation finalization |
| Installed Fastify 5.12.1, `lib/reply.js`, `Reply.prototype.then` | Awaiting a reply waits for response completion | An `onSend` hook waiting for the enclosing run creates a dependency cycle |
| `control/SessionAuthority.outputGuard` | Requires open scope and the active captured ticket | Moving send after `run` invalidates the existing guard |
| `SessionAuthority.run` | Closes scope, classifies outcome, drains pending work, then finishes its captured ticket | A journal write in a background `finally` cannot establish acknowledgment-before-response |
| Application routes | Self-admit through `ApplicationAuthority`; the envelope wrapper deliberately bypasses them | A browser-route-only fix leaves application publication outside the new boundary |

These are local source observations, not claims about every Fastify version. The
implementation must recheck the installed dependency before using its hook behavior.
Do not fix this by monkey-patching `reply.send`, synthesizing a Fastify reply Proxy,
blocking `onSend` on `run`, or weakening the existing read guard to allow closed scopes.

## Decision: one owner, distinct execution and publication phases

Extend the existing authority orchestration. Keep `SessionControl.begin/check/finish`
as the only ticket and deduplication state machine. Keep J0's pending set and dispatch
counter as the only admitted-work tracker. Introduce private scope phases, not a
second session state enum in protocol or another executor class:

```text
admit -> execute -> seal effects -> drain -> finalize execution
      -> publish bounded result -> release captured ticket
```

`seal effects` is irreversible: `assert`, `dispatchInScope`, read preparation and
retained execution guards refuse new work. Already admitted work remains tracked.
An unresolved abandoned write keeps the J0 unknown outcome even after later success.
Finalization in ephemeral mode records only the existing in-memory outcome. In a
later qualified durable mode it also waits for the terminal acknowledgment.

Publication gets an owner-created, output-only guard. It checks the captured entry,
incarnation, ticket, epoch, principal and publication phase, including current expiry
and takeover. Share captured-owner validation with existing checks; do not copy it
into HTTP, CLI or MCP. The existing `outputGuard` used by source/receipt readers keeps
its execution-scope semantics. The publication guard cannot reopen execution, admit
another write or authorize a read callback. It is not serialized or accepted as input.

Retain the ticket while publishing, preserving current exclusion rather than creating
a detached permit plus another generation counter. Publication has a finite transport
deadline. On disconnect/timeout, revoke its guard before releasing that ticket and
terminate the unsent HTTP response. A callback ignoring cancellation must not later
reach a raw socket/reply outside the guarded publisher. No claim is made that already
sent bytes can be revoked. Initial qualification covers bounded, non-streaming JSON;
streams, WebSockets and arbitrary custom serialization are outside this contract.

Do not release an engine task merely because publication timed out. If sealing still
has admitted work that ignores cancellation, retain the captured owner in drain as
J0 does today. A caller deadline bounds its wait, not the external effect's lifetime.
Storage uncertainty follows the separate quarantine contract; it is not successful
finalization. Prevent a timed-out caller from later publishing its retained payload.

## Execution outcome is independent of delivery

Freeze the terminal execution result once it is finalized (and, in durable mode,
acknowledged). Serialization errors, disconnect, timeout or takeover during publication
may suppress the response but cannot rewrite a completed external effect to failed.
Retain current pre-finalization checks: revocation while executing/draining can still
make a dispatched operation unknown. In particular, do not reuse a catch covering
both execution and publication to overwrite the terminal record.

`ControlView.busy` describes live ticket occupancy. A finalized `OperationRecord`
describes execution. It is valid to be terminal while briefly busy publishing. Pin this
with tests; neither field should be overloaded to mean the other. Introduce any needed
core method by extracting the current record update from `finish`, with identity checks;
do not duplicate mutation of `records` in control composition. Final release must not
overwrite the already recorded result.

## Transport composition, not a reply framework

Admitted handlers return inert response drafts: existing payload, status and a small
allowlisted set of headers. Preserve current per-route success/error bodies, status
codes, execution-failure classification and schema serializers. They must not receive
an object capable of sending. Reuse existing error mapping and execution/outcome result
classification after separating them from send. Do not create a generic HTTP framework
or deep-clone every response through a new JSON serializer.

One API publisher owns Fastify serialization, the final output guard and sending.
The authority invokes this publisher only after finalization. Its `onSend` guard checks
authorization without waiting for enclosing run completion. Returning Fastify's reply
thenable is permitted only from this publication phase, never from the work callback.
Work and publication share one private authority lifecycle; ordinary internal callers
retain their current `run` signature/result behavior. No CLI/MCP publisher is necessary:
they consume the server result through their existing client.

ApplicationAuthority must compose the same publication boundary for self-admitted
execute/discover/receipt paths; it must not nest a second `begin` or leak a publisher
into an adapter. Keep application permission/binding checks at their existing owner.
Routes with no authority, operator control transitions, session provisioning/teardown
and health endpoints remain explicit categories. Inventory them using `registeredRoutes`
and route metadata, not another URL regex table. Existing HEAD behavior follows GET.

Duplicate/status requests do not own the original ticket. Do not let their publisher
finish or borrow it, wait for it to drain, or acquire a ticket merely to inspect it.
Use one bounded snapshot of the existing record and fresh current-principal authorization
at the shared authority boundary, then a read-only publication fence bound to the
captured entry, epoch and existing review/binding version. Recheck after async transport
work. This fence exposes only that captured status, not an executable or arbitrary
payload callback. In-flight duplicates remain status-only; no effect replay. Journal
ACK state gates durability claims as specified in J1-B, even if RAM is ahead of disk.

## Implementation packets and failing-first acceptance

A4a is implemented. Next: [A3a review ownership](t5-review-publication.md), A3 HTTP,
then A4b parity. Reuse fixtures and route metadata; one reviewed candidate per bounded
packet, with focused tests before mandatory hooks/CI.

| Packet | Existing owners changed | Required independent observable tests |
| --- | --- | --- |
| A1 finalize vs release | SessionControl, SessionAuthority | Terminal status while ticket still excludes new writes; release cannot overwrite it; old owner cannot finish replacement; publication failure preserves finalized execution |
| A2a session publication (implemented) | Same SessionAuthority lifecycle and shared bounded wait | Closed execution scope refuses work; publication guard checks owner/deadline; timeout/revocation suppress output; legacy run/drain unchanged |
| A2b application publication (implemented) | ApplicationAuthority permission and binding owners | Compose application permission/binding fence after execution; revocation during publication suppresses output; no nested admission or weakened read guard |
| A3 HTTP draft migration | Existing route wrapper, result/error helpers and publisher | onSend observes finalized status before bytes; paused publisher keeps ticket busy; real HTTP disconnect and timeout revoke late send; no thenable dependency cycle; headers/status/body and HEAD parity |
| A4a primitives / A4b replay parity | Existing operation lookup and authority checks | Duplicate during execute/drain/publication returns authorized status only; mismatched identity conflicts; no nested admission; callback/serialization/transport failures never reveal private payload or repeat effects |

Before A1, write a regression demonstrating today's response-before-finalization
ordering with the actual HTTP wrapper and an instrumented captured control. Do not
test only an invented helper. For A3, compare the registered route inventory across
operator, delegated agent and legacy sessions, including validation errors, semantic
execution failures, application self-admission and artifact JSON retrieval. Avoid a
hand-maintained parallel list. Ensure unguarded/delegated refusal behavior stays pinned.

Output-timeout tests must try a deliberately late publisher after ticket release;
takeover tests must run between result preparation, serialization and final onSend.
Use real loopback HTTP at least once, not only `inject`. Keep onSend asynchronous in
the test so premature release/guard closure and circular waits cannot pass accidentally.
Test publication callbacks attempting nested dispatch and old guards reused by another
operation. Bounded test deadlines must fail the test rather than hiding hangs.

## Exit and limits

A1–A4 are prerequisites, not durable recovery. Before integrating storage, exact-head
independent review must approve phase separation, response parity, owner drain and
non-stream publication qualification. No global change to ephemeral acknowledgment
semantics should be hidden in a storage patch. Record intentional ordering differences
and measured timeout behavior in that implementation's evidence.

A1 now extracts `SessionControl.finalize` and calls it from the existing authority
drain before `finish`. Terminal facts freeze while the captured ticket remains busy;
new dispatch refuses after finalization. `finish` retains compatibility by reusing
finalization before release. See [A1 evidence](../evidence/t5-finalization.md).
A2a adds optional trusted-host publication to the SAME `run` lifecycle; see
[A2a evidence](../evidence/t5-session-publication.md). It shares the bounded-wait
helper extracted from outcome-runner and captured-owner checks with execution/read
composition. Timeout (1–60,000 ms, no default) starts only after drain/finalization.
The optional signal cancels output, not execution or drain; even pre-aborted output
still permits the work callback. Transport request cancellation is a separate concern.
Check the output guard at actual send; a returned value with outcome_unknown is not
proof of completed execution.

A2b composes application access for discover/execute/receipt using one shared guard;
see [A2b evidence](../evidence/t5-application-publication.md). Reads keep execution-only
authority; publication pins current permission/binding without re-consuming consent.
A4a status/replay and A3a review owner/page/evidence composition are implemented.
Whole-inventory A3 HTTP adoption and A4b parity remain gated.
The [A3b packet](t5-http-publication.md) adopts application result/replay/status HTTP
publication first; review/browser routes and full A4b parity remain separate gates.
Only the bounded A3b public transport slice has real HTTP qualification. Full-inventory
A3/A4b adoption and durable recovery guarantees remain unimplemented.
