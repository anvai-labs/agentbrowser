# T5 J1-B/C: journal port and acknowledgment integration

Status: proposed, not implemented. Baseline: develop `dbe23b5`.
A1/A2/A4a1 primitives ship separately; HTTP/replay publication remains gated.
Requires [J1-A response finalization](t5-finalization-publication.md) before runtime
integration. Parent: [T5 J0–J4 sequence](t5-operation-journal.md). This module is
loaded explicitly for journal work; unrelated modes do not load its structures.

## Port location and invariant ownership

The port belongs in `packages/control`: typed bounded metadata and asynchronous
acknowledgments. `SessionAuthority` composes it; `SessionControl` still owns live
identity conflict, ticket, dispatch and terminal status. A storage adapter owns atomic
record transitions and durable ACK semantics, never admission or execution callbacks.
No new runtime package is justified by the port. A test double proves composition, never durability.

Reuse core `canonicalJson` (control already re-exports it), existing protocol status
aliases and `CONTROL_OPERATION_ID`, authority-created admission/incarnation/generation,
ApplicationAuthority's captured binding and existing evidence locators. Reuse J0 tracking. Storage cannot import an engine or transport.

## Immutable identity and metadata

Derive one owner-local validator/type source.

| Record component | Trusted source and rule |
| --- | --- |
| Namespace | Opened exclusively by trusted service configuration; schema version, owner fencing identity, key version, fixed acceptance horizon |
| Operation key | Original service generation, tenant scope, session incarnation, epoch, operation ID; no caller-supplied tenant/generation |
| Actor/binding | Captured admission and application binding/version; tenant/resource IDs remain potentially sensitive metadata |
| Fingerprint | Versioned keyed digest of bounded canonical identity, operation schema and input; only digest/key ID retained |
| Revision | Store-owned monotonically advancing revision used for compare-and-set, not client time |
| Facts | Intent acknowledged; dispatch acknowledged; optional terminal execution status; authorized bounded evidence locators |
| Retention | Namespace horizon and tombstone policy; wall-clock metadata never extends grants or reopens an expired namespace |

Persist neither a callback nor raw arguments, cookies, tokens, credentials, resumes,
HTML or report bodies. Protected application approval tokens are currently hashed
into the live fingerprint: preserve existing live conflict semantics, but never persist
that token or an unkeyed low-entropy digest as the retained identity. Use a domain-separated
keyed digest with canonicalization/version information; reuse the canonical traversal.
Do not silently recanonicalize existing live REST IDs (currently method/URL/body JSON).
Specify and test the durable fingerprint version independently; migration must preserve
existing same-ID conflicts and reject unsupported versions rather than remap them.

New service generation/incarnation means a different namespace key. Reusing textual
session and operation IDs after restart is NOT cross-restart deduplication. Historical
lookup supplies the original key and requires fresh trusted authorization. A future
continuation links a new identity to the original undispatched record; it never makes
an absent record or new session permission to repeat a business effect. No automatic
resume is implementable because private payloads and callbacks are deliberately absent.

## Transition operations and ACKs

One port exposes `reserveIntent`, `markDispatch`, `commitTerminal` and `lookup`.
Mutations carry identity, expected revision and deadline/cancellation; return ACKed
revision/facts from the atomic transition. Fence the namespace before admission.
Agent/tool input cannot inject the port.

| Operation | Preconditions | Repetition and refusal |
| --- | --- | --- |
| reserveIntent | Namespace open, key absent, budget/horizon valid | Exact existing immutable identity returns its stored revision/facts; differing identity conflicts |
| markDispatch | Intent exists at expected revision, no terminal | Exact duplicate marker returns same acknowledged facts; unknown/mismatched revision requires lookup, never effect retry |
| commitTerminal | Expected revision and consistent existing dispatch fact | Exact same terminal facts idempotent; different terminal/status/identity refuses; terminal is immutable |
| lookup | Trusted caller scoped to original namespace/key | Returns bounded stored facts or scoped absent; absence does not establish non-execution |

Predispatch rejection can finalize failed without inventing dispatch. After dispatch,
status uses the existing execution classifier: known application rejection can be
failed with dispatched=true, while unresolved writes are outcome_unknown. Do not
infer success, receipt validity or verification from the marker. Malformed revisions,
ACKs for another key, illegal backwards transitions and a successful ACK lacking its
declared durable facts all fail closed at the port boundary.

Outcomes: acknowledged, definitely-not-written, conflict, uncertain. Not-written
requires positive evidence; generic I/O exceptions/timeouts are uncertain. Use existing
static error diagnostics; no blanket `retryable=true` after ambiguous writes. ACK does not prove external business outcome or artifact availability.

## Composition through shared authority

1. Reserve the existing ticket and persist intent before the business callback. Recheck
   captured entry/ticket/epoch after the wait. Timeout/cancellation seals the scope
   BEFORE late intent ACK can invoke the callback. Never acquire a second ticket.
2. Track a dispatch task in the existing pending set BEFORE any persistence await.
   The first dispatch creates one per-scope marker-ACK promise. Concurrent/nested
   dispatches share it; no sibling may bypass an uncertain/failed marker. Once ACKed,
   subsequent steps use the fact without writing another operation marker.
3. Every effect independently rechecks current scope/entry/ticket after the await. Run
   the owning composition's synchronous final precondition guard, then recheck authority
   before mark/invoke with no further await. A guard that throws, returns a thenable or
   mutates the owner causes refusal, zero effects and conservative retained facts.
4. Seal effects, drain the existing tracker and freeze the execution classification.
   Persist terminal facts, then authorize publication through J1-A. A missing terminal
   ACK cannot become a durable success response. Publication failure does not rewrite
   acknowledged execution facts.

For protected application operations, retain the existing post-consume guard closure:
authorization callbacks first, consent `assertCurrent` next, callback-free binding/input
pins last. Run it after marker ACK. `consume` remains once only; no token restoration
or second consumption if storage fails. Consent can be spent with zero external effect;
report refusal/uncertainty and require a fresh explicit review, not silent retry.
Prepared executors receive no store, ACK API or publisher.

Initially qualify application writes only. Check qualification at EVERY nested effect
boundary: an application executor cannot tunnel an excluded browser effect. Browser/lifecycle/artifact effects stay
excluded until their target/policy/approval pins support post-wait revalidation. Do not interpret J0's common dispatch helper as proof of those asynchronous
preconditions. Requested durability on unqualified work refuses before effect. One shared descriptor
selects qualified operations; no route regex or CLI/MCP-specific store setting.
Native graduation must reuse ActionExecutor target/ref checks, ActionRiskPolicy and
ApprovalGate. Today `service.checkApproval` consumes approval and returns no retained
post-wait witness; `guardPage` alone cannot supply one. Keep ephemeral mode available.

## Uncertainty, replay and bounded resources

Live status can lead disk while a transition is pending. Keep one small per-operation
ACK projection next to authority composition, keyed to the existing record. It is not
another deduplication table. Duplicate requests use SessionControl's existing conflict
check and return a status projection bounded by the last acknowledged durable facts.
Never claim durable completion from an in-memory completed status. No duplicate request
borrows the original ticket or invokes the executor, even before intent ACK.

An uncertain store mutation quarantines its identity and disables new durable dispatch
in that owned namespace until reconciliation. Waiter timeout does not cancel the actual
storage operation or free its concurrency slot. Track the unsettled I/O through existing
drain ownership; late ACK cannot publish to an expired caller, revive its grant or invoke
the effect. Bounded diagnostic lookup remains separately authorized. Do not clear a
quarantine by deleting a record, generating a new ID or claiming a fresh namespace proves
the old business effect absent. A restart requires a new fenced owner and reconciliation.

Set validated deployment bounds once at the port owner: record bytes/count, namespace
count, in-flight I/O, lookup page size, deadlines and retention. Do not invent different
limits in each transport. Determine numeric defaults from the store/runtime audit and
existing operation budget before J2; until then no durable profile may be enabled.
At capacity refuse new operations; never evict accepted IDs. Old keyed fingerprints and
tombstones live through the acceptance horizon. Missing key, rollback/restore, schema
mismatch or inability to fence the previous owner disables writes. Handle shutdown while
I/O ignores abort without reopening that store concurrently.

## Agent implementation packets and falsifying tests

| Packet | Deliverable | Required proof before moving on |
| --- | --- | --- |
| B1 contract | One control-owned immutable metadata validator/port, test-only scripted adapter | Illegal transitions, forged ACK/key/revision, hostile values and bounds refuse; exact duplicate ACK idempotent; no credentials in records/errors |
| B2 contract suite | Reusable adapter conformance suite using real state observations | Intent/dispatch/terminal CAS, conflicting fingerprints, immutable terminal, not-written vs uncertain; reusable by the eventual real store |
| C1 intent/dispatch | Compose into existing authority for qualified operations | No callback before intent ACK; no effect before marker ACK; takeover/expiry/replacement at each wait yields zero new effects; sibling marker sharing and late ACK never escape J0 drain |
| C2 application pins | Retain existing final consent/binding validation at the post-wait boundary | Revoked consent/binding/input during marker wait refuses; consume called once; ordinary writes reauthorize; no browser durability accidentally enabled |
| C3 terminal/replay | Compose J1-A finalization and status projection | Delayed/failed/lost terminal ACK withholds durable success; duplicate during every phase never reexecutes; finalized execution survives send failure |
| C4 qualification | One shared descriptor/selection contract through existing protocol projections | Unsupported durability refused; ordinary ephemeral clients unchanged; same REST/SDK/CLI behavior; MCP optional; browser-free startup with no store installed |

For B1/B2, use deterministic deferred ACKs and independent stored-state/effect counters;
do not mock the same method being asserted. For C1–C3 cross every persistence boundary
with cancellation, takeover, expiry, session ID reuse, thenable/reentrant callback and
late settlement. Distinguish definitely-not-written, committed-but-ACK-lost and never
settling I/O. A fake adapter alone cannot establish crash durability.

J2 still needs one optional SQLite runtime/packaging/ownership audit and real process-loss
tests on the supported Node/Bun matrix. J3 historical authorization/continuation and J4
event/cursor qualification remain separate. No store, public durability claim, percentage increase or release ships here.
Runtime has J0, A1/A2 publication and A4a1 status lookup only.
