# Shared execution algorithms

Status: target sequencing. Extend existing control/action/observation implementations;
no mode-specific orchestration service or competing session owner.

## Admission and effect boundary

```text
authenticate -> validate bounded input -> resolve trusted binding/capabilities
 -> authorize current generation/epoch -> deduplicate operation identity
 -> reserve existing session owner -> record intent when durability is enabled
 -> recheck authority, identity, preconditions and deadline
 -> record dispatch boundary -> issue effect once
 -> verify with bounded reads -> record terminal outcome -> authorize output
 -> release only when the dispatched operation has drained
```

Each boundary has a falsifying test. Storage failure before durable intent rejects
without dispatch. Failure after dispatch is unknown unless independently resolved.
Terminal persistence failure cannot be reported as durably recorded success.
Cancellation before dispatch is a known non-execution; cancellation after dispatch
requests stopping and drains. Killing an engine invalidates the attachment and refs;
it cannot retroactively prove an external write did not commit.

Existing control's no-hidden-queue behavior remains the default. Duplicate IDs with
the same canonical identity return authorized status, not repeated side effects;
different arguments/scope/version conflict. Cross-epoch receipt lookup requires fresh
authorization and cannot reuse an old ID as permission to execute.

## Resolve, act, observe, verify

1. Capture a fresh, bounded candidate set for the required scope. Mark completeness.
2. Build per-observation indexes once: stable block ID, role, exact label, automation ID.
3. Intersect field constraints. Refuse incomplete, missing or ambiguous identities.
4. Select a qualified registered strategy; determine commitment predicate before acting.
5. Recheck document/block/node identity, business preconditions, control and budget.
6. Perform one bounded action using the existing action executor and policy.
7. Poll only required evidence until predicate passes, a known failure occurs, or the
   read/deadline budget is exhausted. Observe changed state before selecting next work.
8. Stop the suffix on uncertain dispatch. Preserve applied prefix, skipped and
   not-attempted steps. Recheck final required state when later steps can invalidate it.

For `n` candidates and `f` fields, one snapshot/index costs O(n) space/time plus
string bytes; exact lookups are expected O(1) per index and candidate intersections
are bounded by n. Fresh captures under DOM churn can still cost O(f*n); do not claim
O(n+f) for the complete live operation. Restricted wildcard matching is linear in
input strings. Bounds apply to browser-to-host transfer as well as accepted results;
current native autofill has a documented intermediate-transfer gap to close later.

Reuse snapshots only while their generation and completeness contract remains valid.
A diff is meaningful only against its exact base revision; a missing base requires
a new snapshot. Do not share native value caches across sessions or principals.

## Strategy port and common helpers

Keep mode behavior declarative. Widget strategies implement only detect/support,
prepare target, execute bounded action and verify commitment. Shared helpers own:
bounded candidate intersection, scope checks, elapsed-budget charging, private-value
resolution, operation receipt assembly and final result aggregation. Reuse existing
helpers when their semantics match; extract these only from actual duplicated behavior.

Focus is a session/page interaction resource, not a property of an isolated DOM subtree.
Keyboard strategies must preserve focus purity and distinguish highlight from commit.
Undo/clear can trigger side effects; compensation is a separately admitted operation
with its own verification, never an assumed transaction rollback.

## Recovery and reconnect

Clients reconnect with bounded exponential backoff and jitter for establishment and
read-only status retrieval. They retain operation IDs, not live browser handles.
After reconnect: authenticate, read current service generation/control state, query
pending operations, reconcile receipts, refresh page evidence, then request new work
only under valid authority. No retry layer in CLI, SDK, MCP or HTTP independently
replays writes. One shared SDK policy owns transport retry classification.

Durable mode restarts fence prior grants and attachments. Undispatched intents may
be marked not executed only when the journal boundary proves it; dispatched records
are unknown until an application receipt resolves them. Browser steps without durable
idempotency stay unknown. A resumed job can continue an undispatched suffix only after
revalidating mappings, state and authority and creating an explicit resume decision.

## Event synchronization

Proposed event recovery uses a consistent authorized snapshot at cursor C followed
by events after C. Cursor = journal generation + sequence, scoped to session and
principal. Duplicates are idempotent; expired or mismatched cursor requires resync.
Authorize each delivery, including buffered items, after takeover. Bound subscriber
buffers and disconnect slow consumers; never silently drop authority transitions.

Events are notifications, not commit receipts. This application contract must work
independently of WebSocket, polling, SSE or any MCP protocol session semantics.

## Parallelism policy

Parallelize only independent bounded reads with verified scope and a concurrency cap.
Separate sessions can run concurrently when tenant quotas and external-resource
conflicts permit. Parallel writes within one session are deferred until declared
resource keys, focus/attachment constraints and application versioning can prove
safe admission. A static DOM-subtree test cannot establish such independence.
