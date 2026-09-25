# R5b1: bounded session close causes

Status: implemented source candidate, unreleased. Based on R5a plus navigation
classification at `e8d50a5`. Load only for R5 lifecycle work from
[research intake](consumer-research-intake.md).

## Boundary and owners

`SessionCoordinator` remains the only logical-session lifetime owner. It classifies
TTL and idle expiration from the same injected clock and retains a small detached
terminal record after a session leaves the live map. The service does not add a
second lifecycle registry. HTTP attaches the record only to the existing
`404 SESSION_NOT_FOUND` envelope after independent operator authentication and an
exact tenant match.

The public close causes are `ttl_expired`, `idle_expired`, `explicit_close`,
`policy_terminated`, `engine_disconnected`, `engine_crash`, and `unknown`. This packet
produces only TTL, idle, explicit, policy and unknown. The two engine values reserve
the canonical wire vocabulary for later typed engine evidence. A generic
`ENGINE_CRASHED` error remains `unknown`; free-form error text is never parsed.
`operator_window_closed` is deliberately absent because the current engine contract
cannot distinguish a window close from process loss, remote disconnect or host
shutdown. Closing the last page continues to leave the logical session live.

## Terminal facts and bounds

The retained view contains only close cause, a normalized public terminal state,
`endedAt`, the last authoritative lease, and `leaseRemainingMs`. The public state is
aligned with the first cause (`explicit_close` is `closed`, even if a pending cleanup
later crosses its TTL). It is not a trace of every detached internal state. Live remaining time is derived at
projection from one lease sample:

```text
max(0, min(expiresAt, idleExpiresAt) - sampledAt)
```

It is an upper bound at that sample, not a survival promise or cached countdown. Every
detached terminal view reports zero availability while preserving the original lease
deadlines, so a client can still see that an explicit or policy transition ended the
session before its scheduled deadline. A tracked CLOSING or failed-close live view also
reports zero availability but intentionally omits the active lease. Live create/get/list
use the shared derivation helper. Older servers may omit both the live value and
terminal details.

The default terminal window is five minutes, with a global cap no larger than 1,000
records. The per-tenant cap is at most one quarter of the global cap and never more
than 100, so one tenant cannot occupy the whole multi-tenant window when the global
cap is greater than one. A global cap of one necessarily degenerates to one tenant.
Configuration is validated once. Expired records are removed during insert,
lookup and the existing cleanup tick. Per-tenant and global eviction use insertion
order, and lookup never refreshes retention. A record contains no engine, context,
abort controller, listener, promise, page or raw error.

The first observed terminal trigger wins. An explicit close that later fails engine
cleanup retains `explicit_close` on the failed-close live context and publishes no
tombstone until the allocation is actually removed. Diagnostic clock failure never
blocks cancellation or engine teardown. Service shutdown clears the in-memory record
set and makes no durable or restart claim.

Explicit close is single-flight per captured context. Concurrent callers share the
same engine teardown and first reason. Abnormal termination derives its public cause
from the requested state: policy termination becomes `policy_terminated`; every other
R5b1 abnormal state becomes `unknown`. Callers cannot inject TTL, idle or explicit
facts through the abnormal teardown API.

## Identity and authorization

Creation retries a bounded number of generated IDs and refuses exhaustion rather than
overwriting a live allocation. Asynchronous teardown accepts a captured context and
checks object identity before any delete, cancellation, tombstone write or engine
close. A late callback for an old allocation cannot terminate a replacement that later
reuses the same textual ID. Successful registration removes an older tombstone with
that ID.

Terminal lookup does not restore `SessionAuthority`, delegated grants or application
bindings. A removed delegated token fails in the existing authentication hook and gets
no close facts. An authenticated operator sees details only for its tenant; another
tenant receives the same generic 404 body as a random ID. Local no-key mode retains its
documented trusted single-user behavior. Tombstone requests short-circuit before a
session handler, so they cannot dispatch browser work. Error serialization still uses
the existing detach, secret-redaction and static status mapping.

CLI and MCP use one protocol-owned projector that validates and copies the strict
terminal shape before rendering. Arbitrary sibling detail keys, callbacks and private
reasons never reach their text output. No new route, capability or MCP tool is added.

## Engine-signal follow-up

R5b2 remains separate and must land after the current CDP attachment work resolves the
engine overlap. It may emit `engine_disconnected` only from a typed session-level
disconnect signal, captured against the exact current context. Page close and passive
page crash remain page facts. `engine_crash` still requires a stronger typed signal.
This packet does not reconnect, replay operations, restore profile state or complete
T5 durable recovery.

Qualification is recorded in the [R5b1 evidence](../evidence/session-close-causes.md).
