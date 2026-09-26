# T5 C1b: journal intent and dispatch composition

Status: merged in PR #298 (`a1443c7`), with clean exact-head review and pre/post-merge CI 8/8.
Base: PR #297 (`aeb7fdd`).
Parent: [journal contract](t5-journal-contract.md). This module is loaded explicitly
for T5 work. It adds no service configuration, wire capability or durable guarantee.
Validation is recorded in [C1b evidence](../evidence/t5-journal-authority.md).
The publication refusals below describe C1b at merge; [C2/C3](t5-journal-application-terminal.md)
replaces them with acknowledged status/replay while keeping runtime configuration gated.

## Shared ownership

`SessionAuthority` receives an optional trusted journal at construction. A version-1
internal operation descriptor selects application metadata. The existing operation
fingerprint remains the only live digest; the journal facade applies its existing
domain-separated HMAC. Authority derives tenant, actor, service generation, session
incarnation, ticket epoch and operation ID. Existing journal validators detach and
bound metadata. No executor, task registry, duplicate map or package is added.

After `SessionControl.begin`, the existing scope retains `reserveIntent(...).settled`
before awaiting the bounded outcome. Only a fresh applied intent acknowledgment
permits the operation callback. Existing records, conflicts, refusal and uncertainty
do not authorize it. Every wait ends with an exact scope/ticket/health recheck.

## One effect boundary

The existing `dispatchInScope` accepts an optional opaque application qualification,
captured within the admitted scope. Its runtime brand and captured scope prevent
structural forgery or reuse under a new operation/incarnation. It holds a synchronous
final guard, never an executor or storage capability. C2 will supply real application
authorization, consent and binding guards from their existing owner.

Register the composite dispatch task before awaiting a marker. One marker promise
belongs to the scope and is shared by sibling/nested qualified effects. Retain its
original `JournalCall.settled` in the same pending set. Only a fresh applied marker
ACK permits further checks. For every effect: check exact open scope and journal
health, run the captured synchronous guard, check health and owner again, then mark
dispatch and invoke without another await. Count dispatched work only at the actual
effect boundary. Late ACKs drain; they cannot reopen the scope or invoke abandoned work.

Unqualified `dispatchInScope`, guarded page writes and legacy `assert(..., true)`
refuse in a journal scope. Ephemeral behavior remains available through the same
helper. A storage or final-guard failure seals further journal dispatch. Existing
control finalization distinguishes no effect from an uncertain dispatched effect.

## Publication and qualification limits

Journal-qualified runs refuse publication/replay options before admission and refuse
their live duplicate replay branch without I/O. ApplicationAuthority, HTTP, SDK, CLI,
MCP and startup/environment configuration do not select this descriptor in C1b.
Separate low-level control/status inspection still reports ephemeral execution facts;
it is not an acknowledged durable projection. C3 must attach that projection to the
existing record owner before any runtime opt-in. Do not add a side map to hide this gap.

C2 must provide actual post-wait authorization/consent/input pins. C3 terminal ACK and
replay, C4 shared selection qualification, J2 real storage/process-loss evidence and
J3/J4 recovery remain gated. Test doubles establish composition, not crash durability.

## Failing-first acceptance

- Delayed intent invokes no callback; delayed marker invokes no effect.
- Timeout, lost ACK and ignored cancellation retain the existing ticket until actual
  settlement; a never-settling store remains busy. A late ACK cannot revive work.
- Takeover, expiry and same-ID replacement at each wait cause zero new effects;
  old settlement cannot release a replacement ticket.
- Sibling/nested effects share one marker and each repeat final guards; abandoned
  dispatch cannot run after scope closure. Physical dispatch remains false while waiting.
- Throwing, thenable, reentrant, owner-changing or journal-closing guards produce
  zero new effects. A synchronous effect throw still records dispatched uncertainty.
- Excluded browser/legacy dispatch, malformed descriptors, unacknowledged/existing
  transitions and publication requests refuse without an authority bypass.
- Independent test-store observations contain only bounded identity and keyed
  metadata; ephemeral execution, replay and publication regressions remain green.
