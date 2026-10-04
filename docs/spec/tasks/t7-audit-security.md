# T7: optional audit and security adapters

Status: slice 2a (engagement scope enforcement) DELIVERED 2026-10-02; the
N2 prerequisite (OS-enforced egress pairing) is documented
([t7-os-egress-pairing](../design/t7-os-egress-pairing.md), enforcement
NOT SHIPPED, gated behind the deferred gateway program) —
the `EngagementScopePolicy` primitive (hosts/paths/methods/identities/
time/budgets, enforced per request and per redirect hop through the F1
all-hop walker) with real-Chromium gates and nine acceptance rows in
[the design record](../design/t7-scope-enforcement.md); the service
surface for scope (policy.scope / MCP scope / CLI --scope-file) is
delivered with it; slice 3 (the OWASP ZAP client adapter) DELIVERED 2026-10-03 with the
real-ZAP recorded run EXECUTED (ZAP 2.17.0, six normalized findings
including the seeded reflected-XSS confirmed high — see the evidence
record); reports (slice 4) remain. Repository: agentbrowser.
Depends on: T3; security parity also T4.
Inputs: core, selected audit/appsec/bounty mode, security, contracts, quality-ci.

## Reuse and scope

Use shared TestRun, authority, scoped evidence and report adapters. Optional integrations
wrap existing specialist engines. Do not build an accessibility rule engine, image
comparison library, vulnerability payload database, scanner or bounty executor.

## Separately qualified slices

1. Audit: one accessibility or visual adapter with baseline/versioned measurements.
2. Security scope: validate/enforce test hosts/paths/methods/identities/time and budgets
   across traffic and redirects. This slice blocks dependent active testing if incomplete.
3. Security regression: external ZAP/Burp adapter plus a role/business-logic fixture.
4. Reports: SARIF or program-specific templates over common evidence only after demand.

## TDD and acceptance

For audits, seeded defects fail and clean controls pass; baseline changes are explicit.
For security, vulnerable/fixed fixtures differ, identities do not leak, expired scope
and excluded redirects are blocked, and budget exhaustion prevents further traffic.
Confirmed findings include independent evidence and cleanup; suspected findings remain
labeled. No report submission or outside communication is implicit in execution.

Scanners are absent from default bridge/form/QA/application-only dependency closures.
Installed scanner version and capability scope are recorded. Existing browser egress
limitations cannot be concealed by a test-mode flag or described as complete containment.

## Completion / stop

Close only the R03/R13 capabilities actually qualified. If scope enforcement needs the
deferred gateway program, report the prerequisite and do not restart that project
implicitly. Audit-only work can remain independently usable. Bounty is a profile/report
extension, not another product stack.
