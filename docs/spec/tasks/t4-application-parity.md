# T4: public application operations and UI/API parity

Status: active. Repository: agentbrowser. Depends on: T2.
Inputs: core, application mode, contracts, grounding, security, interfaces.

## Reuse and scope

Extend the existing ApplicationAuthority typed port and application-only lifecycle.
Use the same SessionAuthority, canonical-json helper, protocol owner and SDK. Public
REST, SDK and CLI adapters translate validated operations; they do not accept arbitrary
URLs, replacement schemas, scripts or credentials. The CLI is a first-class service
client; MCP remains an optional projection and is not part of the delivered application
surface. Reuse operator binding UI components.

## Slices

1. Qualify typed output/rejection/receipt semantics and scoped binding metadata.
2. Expose bounded authenticated application operations through existing public adapters.
3. Exercise UI/API parity against one independent application-state oracle, with
   separate coverage results and browser-free package/startup qualification.

Slices 1 and 2 have a bounded first delivery in 1.8.20 through PR #201. The shared
`ApplicationAuthority` now backs authenticated bind, discovery, execute and receipt
operations over REST, the TypeScript SDK and CLI. Deployment code injects trusted
adapters; unauthenticated local mode cannot bind, missing adapters fail closed, browser
modes cannot request application capabilities, and duplicate write identities return
the recorded operation without re-execution. This delivery does not qualify slice 3 or
complete T4. Subsequent develop composition adds explicit delegated predicate
permission over authority-owned identity via the shared evidence registry; see
[permission qualification](../evidence/t2-application-evidence-permission.md).

## TDD and acceptance

Test stale expected versions, resource/account rebinding, revoked grants, duplicate IDs,
invalid nested input, output schema mismatch and after-commit response loss. Application
mutation, idempotency and expected-version validation are atomic at the app fixture.
The service cannot report a browser command as that fixture's commit receipt.

Run existing application independence audits with browser packages unavailable.
UI and API paths both reach the intended state; break only the UI and require only
the UI test to fail. Public receipt lookup requires current read authority; revoking
the grant that created a receipt must not erase an operator-authorized receipt.

## Completion / stop

The public-interface portion of R10 is partially delivered. Completion still requires
production qualification of the delegated receipt predicate, operator-binding UX,
an independent UI/API parity oracle,
a production evidence source and the remaining receipt-correlation acceptance. Durable
service-restart claims depend on T5. If an external app cannot supply durable idempotency
or receipts, advertise weaker observed outcomes and refuse automatic replay. No
application-specific executor fork.
