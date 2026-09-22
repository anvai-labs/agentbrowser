# T4 operator reconciliation — U1

Status: implemented candidate on develop `5421d07` (#261). See
[qualification evidence](../evidence/t4-operator-reconciliation.md).

## Owners and finite scope

Extend the existing `/operator` panel's api/handle/refresh helpers and U0 browser
fixture. Use existing GET session `operations/{operationId}` and
`application/receipts/{operationId}` routes. Reuse the protocol operation-ID pattern.
No new endpoint, execution, retry, journal, schema, dependencies or history store.
The control view names an operation only while active; accept an explicit ID and
optionally copy the observed active ID. Do not invent a last-operation history.

Separate buttons and result areas show ledger status and application receipt as
independent observations. A completed ledger record does not prove business
acceptance; a receipt never upgrades outcome_unknown. NOT_FOUND, a null receipt,
and denied/unavailable reads remain distinct. None proves that no effect occurred
or authorizes replay. Include operation ID, session, observed control context and
current binding in results. Receipt lookup is under CURRENT binding and is not
proof that it corresponds to the ledger operation's original binding. Render
arbitrary receipt values as text; no business verifier is added.

## State and reuse

Status lookup requires a current attached authorized session, including agent/busy
control. Receipt lookup requires idle human control and available discovery in this
UI; the backend remains authoritative. Both require a bounded protocol-valid ID.
Do not automatically poll or execute either lookup. Explicit receipt lookup does
not re-execute the original operation.

Extract the current control/discovery observation into one helper shared by refresh
and lookup pre/post checks. Publish a result only when its credential/session request
generation, ID and observed control/binding context remain current. This is a
best-effort observation, not an atomic binding lease: same-identity rebind or
revocation between reads cannot be proven absent without a backend contract.

Clear both results on ID changes, attach/reconnect/Forget, binding or control actions,
and observed authority/binding changes or failed refresh. A new lookup replaces its
own result; the other same-ID observation may remain separately labeled. Reuse the
existing whole-action generation fencing, including errors and finalizers. ID edits
may supersede a pending lookup but must not unlock another pending mutation. Forget
always remains available. No private results persist outside this document.

## TDD and acceptance

Extend the existing U0 fixture and delay helper, reusing the synthetic draft owner
and real server. Browser cases cover real known ledger/receipt reads with zero UI
execute requests; unknown outcome with independently present receipt; NOT_FOUND/null/
denied/busy distinctions; delayed successes and failures crossing ID/session/key/
binding/authority changes; safe rendering and immediate clearing. Test valid ID
bounds and active-ID selection. Response-injection negative controls are labeled;
actual backend admission remains covered by existing application/authority tests.

Run focused failing-first tests, normal hooks and existing CI jobs; independent
exact-head review precedes merge. Receipt UX closes only this bounded operator gap.
Production P0c/P1 and T6 E0c/E1 remain separate gates. No release is required.
