# AgentBrowser 1.10.0 delivery evidence

Published 2026-09-23 (America/Chicago). Tag `v1.10.0` identifies protected-main
commit `2ba4efe3992f5372881f988624dde4a9807c07e8`, tree
`008b95b43d1b708f053432f9d6544d85ae5f1537`. The annotated tag object is
`b7b4058e7b5b5a226a9d1d748f70aca39a011715`.

The owner requested promotion after PR #275. Version 1.10.0 reflects new public
features since 1.9.1: reusable form mappings, verified uploads, operator-reviewed
application consent/reconciliation, and operator-scoped outbound private CIDRs. See the
[changelog](../../../CHANGELOG.md#1100---2026-09-23).
CLI/MCP executables are compiled with Bun 1.4.0; the service ships compiled
JavaScript and production dependencies and uses Node 24 through Homebrew. MCP is optional.

## Release review repairs

Independent review reproduced two release blockers on candidate base
`2a23ff530caeb3e3a689b49e7fd2b55a9bd8e2a3`:

- Malformed `AGENTBROWSER_API_KEYS` selected anonymous mode; an unauthenticated
  FakeEngine `GET /v1/sessions` returned 200.
- Stored application review get/approve did not recheck application permission.
  Revoked access still invoked the source provider twice; no application effect ran.

The release validates the complete environment configuration before allocating
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

Independent adversarial review approved exact candidate
`b40ee27c9bedb932f7c032c5a6cd4badbab1b8a3`. Develop and main merge trees match
the reviewed tree above, and the reviewer independently reconfirmed main. Normal
commit/push hooks passed with 3,601 tests passing and 24 existing skips, plus
typecheck, lint and builds. Version, catalog, spec-context and 796 relative-link
checks passed. No force push, administration bypass, workflow rerun or published
artifact replacement was used.

| Gate | Identity | Result |
|---|---|---|
| Release preparation [PR 276](https://github.com/anvai-labs/agentbrowser/pull/276) | `b40ee27` | [8/8 checks](https://github.com/anvai-labs/agentbrowser/actions/runs/35905720170) |
| Develop merge | `502fa734cdf84286022a28e5b616318b4be3d6d0` | [8/8 checks](https://github.com/anvai-labs/agentbrowser/actions/runs/35906524045) |
| Main promotion [PR 277](https://github.com/anvai-labs/agentbrowser/pull/277) | `502fa73` | [8/8 checks](https://github.com/anvai-labs/agentbrowser/actions/runs/35906597459) |
| Main/tag commit | `2ba4efe` | [8/8 checks](https://github.com/anvai-labs/agentbrowser/actions/runs/35911175894) |
| Published release | `v1.10.0` | [12/12 jobs, attempt 1](https://github.com/anvai-labs/agentbrowser/actions/runs/35913045396) |

Main retains all eight strict required checks, administrator enforcement, and
force-push/deletion blocks. All promotion used PRs.

## Published artifact qualification

All fourteen downloads from the [release](https://github.com/anvai-labs/agentbrowser/releases/tag/v1.10.0)
matched `sha256sums.txt`, the fifteenth asset. All four server archives identify
1.10.0, the exact main commit above, and `dirty: false`. The downloaded Darwin ARM
CLI/MCP and extracted service passed the complete existing acceptance harness on
Node 24.21.0 with `releaseEvidence: true` and graceful cleanup.

The exact npm `@anvailabs/agentbrowser-mcp@1.10.0` tarball matched registry integrity:

```text
sha512-5DQB3ebUeVpPCW0GNGbFt00+gXjhmkwP7Pi3IytWjZbOmr+sKxt0dZLDbdWvb2IJ+h0Cs1MigF3PZMUdh9cDzg==
```

Its bundled executable passed MCP initialization/catalog checks and both supported
protocols' unbound/delegated contracts. Registry signature/provenance metadata was
present; local verification covered tarball integrity and executable behavior,
not independent cryptographic verification of the attestation chain.

Release CI exercised all five CLI/MCP executable targets and four server packages.
Darwin x64 service acceptance runs on ARM Node with Rosetta clients; it is not native
Intel service-runtime proof. Windows has executable acceptance, with no Windows
server package. Browser/package acceptance is not hostile-browser containment evidence.

## Installed consumer qualification

The actual Homebrew installation upgraded from 1.9.1 to 1.10.0 on macOS ARM64,
using the candidate in [tap PR 69](https://github.com/anvai-labs/homebrew-tap/pull/69).
All twelve formula URLs/hashes were computed from downloaded bytes and independently
reviewed. Strict audit found one pre-existing CLI test path-style issue; the equivalent
Homebrew Pathname expression fixed it. Strict audit and formula tests then passed.
Node 24, the wrapper, service settings and localhost default remain unchanged.

The installed wrapper started an isolated loopback service and passed version,
authentication refusal, authorized session/page creation, private-network denial
and graceful cleanup checks. The complete acceptance harness also passed against
the actual Cellar 1.10.0 service and clients with `releaseEvidence: true`, including
all nine top-level browser, artifact, download, cookie, coexistence and foundation
checks. No live account credentials were used.

The existing background service and logged-in sessions were preserved. Its observed
health version remained 1.9.0; installing new binaries does not hot-upgrade a running
process. A deliberate service restart is required to use 1.10.0 on that port.

Independent tap review approved exact head
`769158c39eeb79f237495d1ee3046c095d20ee8d`. Tap PR 69 passed
[all four checks](https://github.com/anvai-labs/homebrew-tap/actions/runs/35914636056)
and merged as `b4bc408d7fb9543e433cd020a82d19f3e3f3e0fd`. Its
[post-merge validation](https://github.com/anvai-labs/homebrew-tap/actions/runs/35915516529)
is a separate gate. The installed tap checkout was restored to its updated clean
main branch. This evidence branch starts from release main, so its documentation
PR also synchronizes main's ancestry back into develop; that PR requires its own
passing CI before final delivery closes.

## Scope limits

The LAN positive/negative headed qualification is recorded in the
[CIDR handoff](../../HANDOFF-LAN-CIDR-ALLOWLIST.md). The public additions do not
complete T4/T6, HTTP publication, durable recovery, production evidence configuration,
installed external-harness qualification, inbound CIDRs, OIDC or Basic authentication.
