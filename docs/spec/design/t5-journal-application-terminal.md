# T5 C2/C3: application guards and acknowledged terminal replay

Status: internally implemented and regression-qualified on develop `a1443c7`;
final candidate review and protected delivery pending.
Evidence: [C2/C3 qualification](../evidence/t5-journal-application-terminal.md).
Parent: [journal authority](t5-journal-authority.md) and [journal contract](t5-journal-contract.md).
This internal module is loaded only for journal work. It adds no service, environment,
REST, SDK, CLI or MCP durability selector, concrete store or recovery guarantee.

## Application owner

A trusted `ApplicationAuthority` constructor option selects journal application writes.
It defaults off and derives the descriptor from the captured binding, never request
fields. Reads remain ephemeral. The session authority admits intent before application
preparation or consent policy invocation. It uses the existing opaque live fingerprint.

Retain the existing final guard after consent consumption: application authorization
first, consent `assertCurrent` second, callback-free binding/input pins last. Capture
that closure in the exact-scope qualification and repeat it after the marker wait through
`dispatchInScope`. Consume remains once only. Ordinary writes repeat authorization and
binding validation at the same boundary. Executors receive no journal or publisher.
A spent consent can lead to zero effects; storage failure never restores the token.
Unqualified nested browser/lifecycle effects continue to refuse.

## One operation record owner

SessionControl stores one acknowledgment-required flag and one bounded acknowledged
projection alongside its existing operation record, not a second registry. Duplicate
identity checks include the flag in both directions. A caller cannot downgrade a journal
operation by omitting selection, or upgrade an old ephemeral record by adding selection.

Before intent ACK publication is withheld. Intent projects `in_flight/false`; marker
projects `in_flight/true`; terminal projects its acknowledged status and dispatch fact.
The marker records potential dispatch even if the final application guard prevents the
physical effect. Core's existing live status remains an explicitly ephemeral execution
observation until C4. Duplicate replay and explicit status publication use the same
acknowledged projection, return copies, and retain fresh disclosure authorization.
A replay-only application guard runs between shared status-owner checks outside ambient
execution scope. It never prepares an operation or consumes consent again.

Projection updates are monotonic and tied to the exact original ticket/record. Revocation
cannot prevent recording a valid ACK for the old owner, but it prevents effects and
output. A replacement session has another record owner. Store validated facts before
checking execution authority after a wait; an ACK is never execution permission.

## Terminal sequence and lifetime

Seal further effects, observe the bounded marker outcome, drain tracked work when storage
is healthy, and freeze the existing execution classification. A successful callback
without qualified dispatch is refused and terminalized as an undispatched failure.
Persist terminal against the last acknowledged journal revision and dispatch fact.
Evidence locators are initially empty: this slice does not persist result payloads.
Only a fresh validated terminal ACK permits original success/output; acknowledged
`outcome_unknown` still refuses an optimistic callback result. An execution error
remains an error after its terminal facts are acknowledged. Publication failure does not
rewrite acknowledged execution facts or automatically retry an external effect.

Retain every original storage call's `settled` in the existing pending-task set. On
uncertainty, return the bounded refusal without waiting indefinitely for abandoned raw
I/O. Keep the captured ticket until actual settlement. Late ACKs do not upgrade replay
or publish output; that requires future explicit reconciliation. A durable marker with
no terminal ACK remains `in_flight/true`, even if the ephemeral record says completed.
Terminal bookkeeping may finish after revocation; output still checks its original owner.

## Acceptance and remaining gates

Test each wait with delayed ACK, before-write failure, commit-with-lost-ACK, timeout,
never-settling I/O, takeover and replacement. Verify once-only consent, post-wait guard
ordering, no duplicate executor calls, withheld output before terminal ACK, immutable
terminal facts after publisher failure, and no downgrade through omitted selection.
Reuse the memory adapter's independent stored-state observations and explicit phase
signals. These establish composition, not disk/process-loss durability.

C4 shared runtime selection/transport qualification, J2 concrete storage and Node/Bun
packaging/process-loss tests, and J3/J4 recovery remain separate gates. No public durable
profile, release or T5 completion-percentage increase follows from C2/C3 alone.
