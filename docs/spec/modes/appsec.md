# Mode: authorized application-security regression

Status: proposed extension. Browser primitives do not constitute a scanner. Core applies.

## Job and minimal security contract

Reproduce a specifically authorized security property and preserve its regression test.
Before any testing, require a trusted ScopePolicy: allowed hosts/ports/schemes/paths/
methods, account identities, time window, request/byte/rate limits, permitted test
classes, data handling and cleanup. The server/scanner must enforce it across redirects
and replay. Missing enforceability makes that capability blocked, not best effort.
Active testing requires an explicit grant; selecting this mode grants nothing.

## Data and shared execution

Load the scope, selected identity matrix, one TestCase and evidence references. Use
existing authority/run/report helpers plus a qualified diagnostic port to an external
scanner/proxy. No caller-supplied scripts, arbitrary endpoints, credential export or
payload database in the shared core. Keep each identity's state and evidence separate.

## Required outcome

Focus first on role/account authorization and business-logic regressions. Distinguish
suspected behavior from a confirmed violated predicate. A hidden control does not prove
server authorization, and successful login does not qualify broad vulnerability coverage.
Reports identify scope, test identity, reproducer, evidence, affected property and cleanup.
Never automatically publish findings or send reports outside the granted destination.

## Acceptance and footprint

Known vulnerable and fixed fixtures must yield different independently verified outcomes.
Exercise out-of-scope redirects, identity contamination, expired scope, rate exhaustion
and attempted raw capture leakage. Loading QA/forms must not install or start a scanner.
Before implementing this mode, explicitly expand the security engineering module.

Primary packet: T7 security slice; scope enforcement is a hard prerequisite.
