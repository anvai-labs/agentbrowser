# T5 A3c/A4b: browser and review HTTP publication

Status: implementation candidate from develop `58e3605` (PR #283); delivery gates pending.
Parents: [finalization/publication](t5-finalization-publication.md),
[review ownership](t5-review-publication.md), [HTTP publisher](t5-http-publication.md).
Load only for HTTP composition. This is a prerequisite for the journal, not durability.

## Owners and flow

`SessionControl` remains the sole ticket, exclusion, deduplication and operation-status
owner. `SessionAuthority.run` still admits, executes, seals, drains, finalizes, publishes
and releases. No second executor, pending ledger, timer or serializer is added.

Ordinary `on` handlers receive a frozen request-data projection (method, URL, headers,
body, params, query and resolved identity), with no Fastify reply, socket or server.
They return an internal frozen `HttpResponseDraft`: body, status code, semantic-failure
classification and optional captured disclosure assertion. No route currently needs
custom draft headers; existing framework security/cache headers remain authoritative.
Do not add a general response builder, reply proxy or serializer. Future headers must
be explicitly allowlisted when a concrete route needs them.

Admitted exceptions use the existing error formatter extracted into an inert draft,
including approval-required details; they cannot bypass output ownership. Static
pre-admission errors retain direct error mapping.

The wrapper passes both fresh-draft and status-only replay publications to the existing
run. The failed predicate reads draft status and the existing action/plan/autofill/outcome
semantic classification. Replay never invokes the handler or repeats its decision.
The shared HTTP publisher installs the authority guard before draft projection, composes
any disclosure assertion, checks before reply mutation, in synchronous final `onSend`,
and after actual stream completion. Mapper, serializer and transport failure suppress
unsent output without rewriting finalized execution.

`composePublicationContext` adds a sticky, output-only owner assertion to the original
context: base check, synchronous owner check, base check. It uses the existing
`synchronousResult` helper to reject/consume thenables. It cannot authorize work or
extend the original deadline. Service review publication and HTTP drafts share it.

## Review and control boundaries

- Application review creation retains its existing single admission. Prepare one
  disclosure and pass its view through a context composed with its captured assertion.
  Snapshot trusted publication settings before admission. Lost delivery leaves a pending
  token; creation has no execution operation record and retry allocates a new review.
- Approval inspection/decision prepares exactly one disclosure in the ordinary admitted
  handler. Publication uses the captured view/assertion, never another lookup, decision,
  evidence collection or native read. A duplicate decision publishes operation status.
- Source `assertAuthorized` checks current source permission synchronously in both phases.
  It must not call execution-only page/application reader guards. Collection retains those
  guards; service composition separately pins captured page/review/application ownership
  at publication. Permission changes must advance the existing permission generation.
- Prepare-resume observes pages in one admission and publishes after sealing/draining.
  Only observation collection failure runs cleanup, and only while the authority still
  contains the captured control object. Delivery failure preserves `RESUME_REVIEW`.
  Cleanup cannot take over a replacement that happens to reuse the session ID.

## Explicit transport inventory

The existing registered-route collector records publication categories from registration.
There is no runtime URL regex classifier or parallel capability table.

| Category | Routes | Contract |
| --- | --- | --- |
| guarded | Application discovery/execute/receipt/review, operation status, prepare-resume | Captured owner through bounded JSON delivery |
| when-controlled | Ordinary browser/session reads and writes, artifact JSON, approval get/decide | Same publisher for controlled sessions; explicit legacy path for uncontrolled sessions |
| lifecycle | Session create/list/delete, control status/takeover/delegate, application bind/unbind | Existing lifecycle/control semantics; no publication ticket claim |
| stream | Session WebSocket events | Existing event boundary, outside bounded JSON publication |
| infrastructure | Health, metrics, OpenAPI, operator shell | Existing independent access rules, outside session tickets |

A removed authority cannot turn a controlled session into legacy output: classification
reuses the service's existing `controlledContexts` identity. The legacy marker is separate
from guarded publication state. Unmarked success on a guarded route terminates; static
pre-publication errors retain normal status/error mapping. HEAD follows its GET route.

## Observable ordering changes and gates

A controlled result waits for admitted reads/writes to drain before publication. A verifier
deadline does not detach a non-cooperative evidence read; status remains in flight and
exclusion remains held until that read settles. This is intentional. HTTP cancellation
only cancels publication; it cannot prove that an external effect stopped.

Late publication revocation terminates unsent HTTP instead of replacing a prepared
payload with a late 409. Execution-phase validation/revocation still uses the existing
static errors. Callers may inspect operation status with fresh authority; they must not
retry effects under a new ID merely because delivery failed.

Fastify `inject` resolves at response finish before the authority's final continuation.
In-process fixtures must allow that continuation before starting another operation.
Actual loopback tests independently verify held exclusion, deadlines and late output;
no production queue, retry, shortened exclusion or test timeout relaxation is added.

A4b requires registered-route actor/status/header/error parity, existing SDK/CLI/MCP
acceptance, review owner revocation, same-ID replacement, replay without repeat effects,
HEAD, semantic failure classification, real disconnect/deadline and deliberately late
hooks. Independent exact-head review and normal hooks/CI precede merge. Journal B1/B2
starts from the clean merged head; C1+ runtime integration remains a separate gate.
