# ADR-027: Operator-approved evidence-pass state transfer

Status: Accepted for T10 B2 implementation (2026-10-30); merge requires independent review.
Related: [ADR-025](025-operator-cookie-handoff.md),
[T10 operator workflow](../spec/design/t10-bounty-operator-workflow.md).

## Decision

An authenticated human operator may create a fresh, contained, ledgered evidence
session from an unscoped session owned by the same tenant. This is a separate
operator route, never an agent-controlled `approved` boolean or an export API.
The CLI exposes `session create --evidence --from SOURCE --scope-file FILE` with
the existing operator-key-file/no-echo credential flow. A tenant API credential
cannot authorize transfer. The source's context generation, tenant, exact origin
selection, validated destination scope and current server policy are revalidated
after asynchronous work. There is no continuous synchronization or write-back.

Only cookies and localStorage transfer. Origins are exact HTTP(S) origins selected
from source-owned pages or explicitly supplied by the operator, checked against
the destination's **program** hosts, schemes, ports and exclusions. Asset hosts
never qualify. Paths do not partition browser storage; a selected origin grants
that origin's storage, while the destination's path rules still govern traffic.
Cookie domain/path/secure/expiry/SameSite/HttpOnly attributes are retained. A parent
Domain cookie is refused/omitted unless its entire domain subtree is authorized;
it is never rewritten into a host-only cookie. Partitioned cookies are refused.
No sessionStorage, IndexedDB, service workers, caches, saved passwords or profile
files transfer. An unsupported adapter refuses the operation.

Initialization has one 30-second bound tied to both source and target lifetimes;
late capture/seed completions cannot publish a session. The target is hidden
from session lookup, listing and actions while initializing.
It is marked as carrying operator credentials before seeding. Existing cookie
export refusal, high-risk/unknown action review, WebSocket denial, service-worker
refusal, WebRTC-removal script, domain policy grants and secret registration apply.
Secret values are registered before any state write and never returned or logged.
Third-party asset access does not authorize third-party state transfer or change
these floors; it is separately classified and cannot carry program markers.

The ledger must durably acknowledge a prepared transfer record **before** seeding,
and a completion record before publishing the session. Records contain source and
destination identities, policy/scope digests, exact origins, counts and SHA-256
state digests, never values or storage keys. Missing/full/failed ledgers, source
replacement, partial seeding and completion-write failure close the target and
return no successful session. The operator's authenticated request is the explicit
decision for this one operation; an agent request cannot mint that authority.

## Consequences and limits

Origin-bound storage handles applications whose authentication lives in
localStorage without exposing tokens to the agent. Copying does not promise that
a site accepts the new context or that independently rotating state is a single
application transaction. Browser egress remains subject to the immutable base,
tenant, metadata floor and the destination scope at every covered hop. This does
not make the CDP source contained or broaden documented worker coverage.

## Validation

Test operator versus API credentials, cross-tenant and stale-source refusal,
exact-origin and cookie-subtree filtering, unsupported engines, secret-free
ledger/results, hidden target state, partial seed cleanup and critical-write
failure. Real Chromium fixtures must demonstrate cookie and localStorage login
transfer and absence at non-program destinations.
