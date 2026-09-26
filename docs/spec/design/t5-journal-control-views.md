# T5 C4a: acknowledged control views and the C4b selection seam

Status: C4a merged #300 at `e812fbc`; clean exact-head review and pre/post-merge CI 8/8.
Parent: [journal contract](t5-journal-contract.md).
Evidence: [control-view qualification](../evidence/t5-journal-control-views.md).
Load this module only for T5 journal continuation. No additional mode context is required.

## Problem and shared owner

C2/C3 gates duplicate replay and explicit publication on acknowledged facts, but the
existing control view still exposes the live execution record. A terminal store call can
commit without its acknowledgment reaching the authority. Reporting live `completed`
through status or takeover in that interval contradicts the shared publication contract.

SessionControl remains the sole record owner. One private projection helper selects the
existing live record for ephemeral work and the existing acknowledged record for journal
work, always returning a copy. `view()` and `publicationOperation()` reuse it. No second
registry, execution path, storage model, transport field or dependency is needed.

| Observed boundary | ControlView.operation | Explicit operation lookup/replay |
| --- | --- | --- |
| No active ticket | Omitted | Existing retained record, or existing missing-record behavior |
| Journal intent not acknowledged | Omitted; busy remains true | Static CONTROL_REQUIRED refusal |
| Intent acknowledged, marker pending | in_flight, dispatched false | Same acknowledged facts |
| Marker acknowledged, terminal pending/lost | in_flight, dispatched true | Same acknowledged facts |
| Terminal acknowledged, ticket still active | Acknowledged terminal status/dispatch | Same acknowledged facts |
| Ephemeral operation | Existing live execution projection | Existing live execution projection |

`dispatched: true` after marker ACK is conservative potential dispatch, not proof of an
external effect. An ACK is never permission. State, epoch and busy still describe the live
owner/ticket: hiding an unacknowledged operation must not disable takeover or stop. Once
the ticket drains, the active-view operation disappears; explicit lookup retains its
last acknowledged facts. Late uncertain ACKs do not upgrade those facts automatically.

`operation(id)` remains a trusted live diagnostic for execution classification. It must
not feed public status, lifecycle, replay or failure envelopes. All existing outward
control projections converge through core view or explicit publication; transport
adapters add no journal-specific mapping. Existing disclosure authorization is unchanged.

## Qualification

Failing-first tests prove pre-intent omission, conservative marker facts and terminal
ACK bounds. Exercise every terminal status, status/takeover under delayed intent and
terminal ACK, timeout/lost ACK, actual ticket drain, copied snapshots and ephemeral
behavior. Reuse the shared controllable journal fixture and independent stored-state
observations. No browser, service or persistent store is needed for this invariant.

## C4b design: shared execution requirement (not implemented)

After J2 qualifies the concrete store/runtime, use one optional protocol field:
`executionRequirement: 'ephemeral' | 'durable'`. Missing normalizes to `ephemeral` once
at the application control boundary. Explicit ephemeral must preserve current behavior.
Durable is a hard requirement for qualified application writes, never a preference or
silent fallback. Reads and unsupported/unhealthy configurations refuse before admission,
preparation, consent consumption or effects. Existing operation ID/version requirements
continue to apply. No new executor or durable route is introduced.

Expose one application-discovery write capability:
`writeExecution: { defaultRequirement: 'ephemeral', supportedRequirements: [...] }`.
A no-store runtime supports only ephemeral. Discovery does not authorize execution;
selection rechecks the trusted runtime qualification at admission and existing boundaries.
Do not advertise store paths, keys, mutable adapter internals or fake-store durability.
The existing `journalWrites` constructor option remains internal test composition and
cannot serve as this selector: it journals all writes and does not prove crash durability.

Derive REST/SDK types and CLI describe/schema from protocol as usual. CLI adds
`--execution-requirement <ephemeral|durable>` to `application execute`; JSON and flags
normalize through shared request validation. `application review` keeps its complete
nested request JSON and carries the field there, without a competing flag. MCP remains optional;
any future application adapter consumes the same contract rather than owning policy.
Include the normalized requirement in the operation fingerprint and intended action of
application review, so consent and replay cannot cross requirements. Missing and explicit
ephemeral must have identical fingerprints. Preserve the core selection-conflict check as
a second guard. Preserve the current v1 fingerprint encoding for canonical ephemeral;
use a versioned, domain-separated encoding for durable selection. Pin byte-identical
ephemeral fingerprints and non-colliding durable fingerprints before shipping.

Initially reuse the static shared CONTROL_REQUIRED unavailable refusal. Add a separate
bounded reason only if a consumer needs it, consistently across transports. Refusal must
not reserve an identity or consume approval. Production startup without a store remains
browser-free and ephemeral; no mandatory database, broker or hosted dependency.

## Agent continuation and gates

1. J2: follow the [SQLite audit](t5-journal-sqlite-audit.md) and
   [qualification packet](t5-journal-sqlite-qualification.md). Audit one optional SQLite store against supported Node/Bun packaging, exclusive
   ownership, bounded I/O and actual process-loss/corruption/disk-full tests. Write the
   concrete design and failing-first acceptance before choosing a runtime dependency.
2. C4b: introduce one trusted qualification/configuration owner consumed by service
   construction, discovery and selection. Wire the existing ApplicationAuthority and
   SessionAuthority helpers. Qualify missing/explicit ephemeral equivalence, unsupported
   refusal, consent/replay identity, and REST/SDK/CLI parity without extra executors.
3. J3/J4: authorized historical lookup and explicit revalidated continuation, then
   event/cursor recovery. Never auto-replay an uncertain external effect or revive grants.

C4a is a publication prerequisite, not C4 completion. Memory-backed acceptance establishes
composition only. Public durability, full recovery, release and any T5 percentage increase
remain gated on the remaining acceptance, not on the number of landed internal slices.
