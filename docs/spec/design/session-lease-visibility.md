# R5a: active-session lease visibility

Status: implemented source slice, unreleased. Based on develop `72d1a6e` after
1.11.0. Load only for R5 lifecycle work from [research intake](consumer-research-intake.md).

## Boundary and owners

Extend SessionCoordinator, the existing lifetime owner. Its injected clock supplies
creation, activity, expiration and inspection timestamps. One synchronous inspection
samples time once (once for a whole scoped list), applies the existing expiration predicate, and returns the live
context with a detached lease snapshot. No new registry, heartbeat, executor or route.
The service's existing session view projects that snapshot on create/get/list;
SDK types alias the protocol view, CLI renders it, and MCP forwards it unchanged.

The optional `lease` object contains integer Unix epoch milliseconds: `sampledAt`,
`expiresAt`, `lastActivityAt`, `idleExpiresAt`. Its absence on older servers means
unknown. Deadlines describe the service session, not delegated grant expiry or
browser attachment lifetime. TTL expires at `now >= expiresAt`; existing idle
semantics expire at `now > idleExpiresAt`. Effective expiration is either condition.
Polling inspection/listing does not refresh activity. Existing work paths keep their
activity semantics. Do not publish a cached remaining-time counter or promise
survival until a deadline: crashes, explicit closure and policy can end it earlier.
Invalid clock samples and unsafe deadline arithmetic fail closed with static errors;
creation releases its allocated engine session on lifetime-validation failure.
Creation returns an internal allocation record carrying the exact context beside its
response; the existing coordinator create method preserves its response shape through
a wrapper over the same implementation. Ownership is never recovered by ID after an
await. Trusted teardown uses a no-clock current-identity check and conditional discard
composed with the existing termination owner. It is never a liveness or authority
read. Service initialization rolls back its captured allocation and partial state
on failure; delayed old closes cannot delete a replacement session.
Wall-clock adjustment remains visible; this slice does not change timeout semantics
to a monotonic clock or introduce keep-alive behavior.

## Privacy, identity and termination

Existing tenant and delegated authorization apply without new capabilities. Each
inspection uses the current context in the coordinator's map and never accepts an
old context supplied by a transport. Only READY/ACTIVE sessions with a live signal carry a lease. Existing closing or
failed-close views retain their status with no lease. Expiration removes the record
before cancellation and never starts a second teardown for a CLOSING owner. A
settled failed close retains the existing best-effort expiry retry.
Closed or expired sessions remain not found;
there is no post-close tombstone or raw error disclosure. Session reads remain
per-request authorized and MCP aggregation is not atomic guarded publication.

R5b remains a separate design/implementation packet: typed TTL/idle/explicit-close
and observed engine-event causes, scoped bounded retention, incarnation checks for
late events, and transport authorization after removal. Preserve current page-close
semantics (including the last page); do not equate renderer crash or target-closed
exceptions with operator intent or browser termination. Reuse lifecycle/event owners.
This lease slice does not complete R5 or T5 recovery.

## Failing-first acceptance and delivery

Use an injected clock to pin exact TTL/idle boundaries, activity refresh, inspection
without refresh, background expiration, detached snapshots and ended-session refusal.
HTTP create/get/list must agree on authoritative deadlines, omit other tenants,
refuse stale grants, and leave inspection activity unchanged. CLI human output shows
sampling/deadline facts; JSON and bound/unbound MCP preserve canonical fields.
The existing headed research smoke qualifies all four surfaces and large documents;
compare deadline identity, not varying sample timestamps. Update OpenAPI from its
existing emitter. Run normal hooks, independent adversarial review, one final PR CI
cycle and merge to develop. Keep 1.11.0 immutable; no new release is implied.

Qualification and adversarial repairs are recorded in the [R5a evidence](../evidence/session-lease-visibility.md).
