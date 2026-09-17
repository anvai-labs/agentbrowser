# T4: public application operations and UI/API parity

Status: not started. Repository: agentbrowser. Depends on: T2.
Inputs: core, application mode, contracts, grounding, security, interfaces.

## Reuse and scope

Extend the existing ApplicationAuthority typed port and application-only lifecycle.
Use the same SessionAuthority, canonical-json helper, protocol owner and SDK. Public
REST/MCP adapters translate validated operations; they do not accept arbitrary URLs,
replacement schemas, scripts or credentials. Reuse operator binding UI components.

## Slices

1. Qualify typed output/rejection/receipt semantics and scoped binding metadata.
2. Expose bounded authenticated application operations through existing public adapters.
3. Exercise UI/API parity against one independent application-state oracle, with
   separate coverage results and browser-free package/startup qualification.

## TDD and acceptance

Test stale expected versions, resource/account rebinding, revoked grants, duplicate IDs,
invalid nested input, output schema mismatch and after-commit response loss. Application
mutation, idempotency and expected-version validation are atomic at the app fixture.
The service cannot report a browser command as that fixture's commit receipt.

Run existing application independence audits with browser packages unavailable.
UI and API paths both reach the intended state; break only the UI and require only
the UI test to fail. Public receipt lookup requires fresh current authorization.

## Completion / stop

Close R10 public-interface/parity aspects. Durable service-restart claims depend on T5.
If an external app cannot supply durable idempotency or receipts, advertise weaker
observed outcomes and refuse automatic replay. No application-specific executor fork.
