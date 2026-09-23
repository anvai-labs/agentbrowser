# AgentBrowser 1.10.0 release qualification

Status: candidate preparation, not yet published. The owner requested promotion
from develop after PR #275. Candidate base is `2a23ff530caeb3e3a689b49e7fd2b55a9bd8e2a3`.
Version 1.10.0 reflects new public features since 1.9.1; see the
[changelog](../../../CHANGELOG.md#1100---2026-09-23).

## Release review repairs

Independent review reproduced two release blockers on the candidate base:

- Malformed `AGENTBROWSER_API_KEYS` selected anonymous mode; an unauthenticated
  FakeEngine `GET /v1/sessions` returned 200.
- Stored application review get/approve did not recheck application permission.
  Revoked access still invoked the source provider twice; no application effect ran.

The candidate validates the complete environment configuration before allocating
service resources and owns a copy of injected credentials. Explicit empty/malformed
lists and conflicting duplicate mappings fail startup with value-free diagnostics.
An explicitly injected empty map retains the trusted embedding's local-mode contract.

Stored application review resolution reuses `prepareOperationReviewInScope` and
compares the complete stored canonical action before calling the evidence provider.
Consumption reuses its original prepared review handle. Both paths retain existing
page, source, tenant, incarnation and callback guards, with final application pins.
This closes the stored-review permission defect, not the pending A3a2 publication work.

Fourteen regression cases fail against the original production code. The repaired
five-file API/HTTP selection passes 129 tests; built API, CLI and MCP all report
1.10.0, and the spec-context/catalog checks pass. Independent compiled probes also
confirm same-resource rebinding and provider input substitution are refused.

## Delivery gates

Full local hooks, exact-head review, develop/main PR CI, actual merge-tree checks,
release workflow, downloaded artifact checksums/build stamps, npm package integrity,
and Homebrew formula/install qualification remain required. Completed delivery
identities will be recorded after those gates execute; no publication or installed
upgrade is claimed by this candidate document.

The LAN positive/negative headed qualification is recorded in the
[CIDR handoff](../../HANDOFF-LAN-CIDR-ALLOWLIST.md). The public additions do not
complete T4/T6, HTTP publication, durable recovery, production evidence configuration,
installed external-harness qualification, inbound CIDRs, OIDC or Basic authentication.
