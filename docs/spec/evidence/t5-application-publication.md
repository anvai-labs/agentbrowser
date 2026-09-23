# T5 A2b: application publication access

Status: trusted-host composition implemented; HTTP/replay publication and durability pending.
Base: develop `9eb5def` ([A2a #270](https://github.com/anvai-labs/agentbrowser/pull/270)).
Design: [J1-A finalization/publication](../design/t5-finalization-publication.md).

## Reuse and contract

`ApplicationAuthority.discover`, `execute` and `lookupReceipt` accept optional
`SessionPublication` options. They still use their single existing `SessionAuthority.run`.
The same ticket excludes competing work through execution, drain, finalization and
bounded publication. No executor, timer, operation store, wire capability or adapter
callback is added. Calls without publication keep their existing authorization ordering.

One private `preparePublication` composition snapshots and validates the original
publisher/options before application callbacks. It captures the binding, adapter and
application scope inside admission, before business callbacks. A2a's types and validator
move unchanged to the internal `publication.ts`; existing exported types remain available.
There is one timeout range and one options validator, shared by both authority layers.

One private `applicationAccess` guard is extracted from `captureReadInScope` and reused
for publication. It owns sticky refusal, cancellation, captured binding identity and
strict synchronous authorization. Reads still supply their execution-only guard and
exact admission check, and retain `trackReadInScope`. Publication supplies A2a's output
lifetime guard. Neither admits new work or converts a read capability into output authority.

Each access check orders lifetime/binding pins, application authorization, then pins
again. The final pin rechecks lifetime after looking up a binding: even a lookup can
expire/remove an unbound session. Captured absence is explicit; unbound discovery may
publish its null result only while that absence and its session lifetime remain current.
It never captures a later binding or fabricates a tenant/resource scope.

The publisher receives the original result and a frozen context whose `assertCurrent`
composes application access with session output authority. The wrapper checks before
passing the value and after the publisher settles. The publisher MUST check immediately
before actual output. A host callback with raw output access can ignore these checks;
no callback confinement or HTTP qualification is claimed here.

Authorization denial/throw/malformed result is contained by the existing policy helper.
An observed refusal remains sticky even if policy later returns true. A boolean policy
cannot detect a revoke/regrant cycle that no check observed; versioned permission history
is not introduced. Receipt-related internal refusal diagnostics become generic static
application-access messages; error codes and fail-closed behavior remain unchanged.

## Execution, cancellation and consent

Publication reauthorizes current application access. It does not consume or restore
submission consent, rerun effects, call receipt adapters, or reopen execution guards.
A retained receipt reader still refuses during publication. A completed operation stays
completed if publication fails. Application rejection remains a rejected result with
the existing terminal operation status `failed`; delivery success cannot change that.

A2a timeout/signal semantics are unchanged: 1–60,000 ms, starting after execution/drain;
cancellation affects publication only, even if already aborted before work. The existing
owner drains admitted work. Timeout closes output authority before releasing that owner.
Payload schema/byte limits remain with the eventual publisher; results are not cloned.

Duplicates return current status without invoking the publisher or acquiring a second
ticket. A4 must qualify fresh authorized status publication before HTTP adoption; there
is no unguarded replay fallback here. Existing REST/SDK/CLI/MCP callers do not opt in.

## Failing-first validation and review

The initial 17 publication tests all failed against A2a, then passed after implementation.
Additional boundaries bring this suite to 24 cases. Adversarial review found a final
absent-binding lookup that could itself expire the owner after its last lifetime check.
A targeted regression first failed with one guarded send instead of zero. Adding the
final lifetime recheck in the shared helper fixed it; no route-specific patch was needed.

- 465 control tests passed, including existing authority, read, consent and A2a contracts.
- 70 affected application/coexistence API tests passed; control type-check and build passed.
- Independent compiled probes confirmed sticky denial across all three methods, refusal
  after a publisher swallows a guard error, owner replacement during absent lookup,
  retained guard closure and preservation of finalized execution.

Normal hooks, exact-head review and PR/post-merge CI remain delivery gates, not outcomes
predeclared by this source record. This packet leaves T5 at ~10% foundation progress;
exactly 3/9 finite milestones remain complete. Published 1.9.1 and services are unchanged.

## Next packet

A3 must migrate actual HTTP handlers to inert response drafts and a guarded publisher,
reuse existing route metadata/error mapping, and prove finalization-before-output with
real HTTP. Preserve body/status/header and HEAD parity, disconnect/timeout refusal and
existing caller behavior. A4 then qualifies authorized duplicate/status publication.
Journal ACK/quarantine integration remains gated behind both; no durable recovery ships.
