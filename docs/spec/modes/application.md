# Mode: browser-free application operations and parity

Status: typed in-process application authority exists; public REST/MCP and durable
qualification are proposed. Core applies.

## Job and data

Execute a trusted typed application operation under the same human/agent authority
as a browser session. Load the bound adapter/resource, operation schema, expected
business version and receipt locator. No DOM, browser package, profile or scanner is
needed unless an explicitly requested UI parity test attaches a browser.

## Shared execution

Reuse ApplicationAuthority, SessionAuthority and the existing canonical input helper.
Adapter registration belongs to trusted server configuration. Agents cannot supply
arbitrary endpoints, implementations, replacement schemas or credentials. The app
atomically enforces business authorization, version checks, mutation and durable
idempotency; the service journal alone cannot provide that transaction.

## Required outcome

Read, committed and rejected application results remain distinct. Receipt queries
require current authority and binding; old operation IDs cannot revive old grants.
Reconciliation after reconnect/restart precedes any new write. Do not treat an API
success as a UI pass: parity tests execute each seam against an independent oracle.

## Acceptance and footprint

Qualify stale expected versions, account rebinding, revoke-before-output, duplicate
operation IDs, after-commit disconnect, and browser-free isolated installation/startup.
Use the same fixture business predicate for UI/API tests but different execution paths.
Keep one application operation port, not separate QA and operations implementations.

Primary packet: T4, with T5 for durable service recovery and T8 for public harness parity.
