# Release 1.28.0 evidence

| Status | Tag | Commit | Notes |
| --- | --- | --- | --- |
| Released | `v1.28.0` | `0efc9582dbe349633a3173759bff798930329bd4` | Promotion [#656](https://github.com/anvai-labs/agentbrowser/pull/656); minor release |

## Qualified source and delivery

The [release](https://github.com/anvai-labs/agentbrowser/releases/tag/v1.28.0)
was published on 2026-10-30. Preparation [#655](https://github.com/anvai-labs/agentbrowser/pull/655)
qualified `45fe995549dc92e760b6632aaf02e96c01e5245b`; the develop merge `dcaa001d`
and main promotion have the identical tree `a6928173ab1a643e5c657d0342b41934f750c06b`.
Independent adversarial review covered both the release delta and the full promotion
range from 1.27.4, with no remaining findings. The unrelated CLA/hygiene PR #654
is excluded from the release.

| Gate or channel | Verified evidence |
| --- | --- |
| Local hooks | Full pre-commit and pre-push checks passed: 6,229 tests, 25 existing optional/platform skips |
| Release contracts | 67 release tests, generated OpenAPI/catalog freshness, version consistency, documentation and spec checks passed |
| Minimum Node smoke | Built API, CLI and MCP smoke passed on official checksum-verified Node 22.12.0; this is not full Node 22 browser/journal qualification |
| Candidate package | Clean Darwin ARM archive, native CLI/MCP compiled with checksum-verified Bun 1.4.0, all 11 extracted-package checks passed on Node 24.21.0 |
| Preparation CI | [41001957840](https://github.com/anvai-labs/agentbrowser/actions/runs/41001957840), success |
| Promotion PR CI | [41004013223](https://github.com/anvai-labs/agentbrowser/actions/runs/41004013223), success |
| Main postmerge CI | [41005848562](https://github.com/anvai-labs/agentbrowser/actions/runs/41005848562), success; Windows and deployed documentation also passed |
| Release workflow | [41006480989](https://github.com/anvai-labs/agentbrowser/actions/runs/41006480989), success: tag guard, five binary targets, four accepted server archives, Windows bundle, npm, signed assets and Winget manifests |
| npm | `@anvailabs/agentbrowser-mcp@1.28.0` verified live, with npm `latest` = `1.28.0`, after normal owner approval of the `npm` environment deployment `7431254734` |
| GitHub | Published, immutable, not draft; all 16 assets present |
| Downloaded bytes | Native Darwin ARM CLI, MCP and server archive match published `sha256sums.txt` |
| Provenance | CLI signer-workflow verification passed; server verification also binds source commit `0efc9582` and `refs/tags/v1.28.0`, refusing self-hosted signers |
| Published acceptance | Actual downloaded Darwin ARM server and matching CLI/MCP passed all 11 checks, `releaseEvidence: true`, clean source stamp `0efc9582`, verified child/fixture cleanup |
| Back-sync | [#657](https://github.com/anvai-labs/agentbrowser/pull/657), merged as `b1266139`; main promotion is an ancestor of develop, with zero file changes |
| Homebrew | [tap #141](https://github.com/anvai-labs/homebrew-tap/pull/141), formula-only change; independent review matched all 12 URL/hash pairs to published checksums. After Victor #140 merged, current-base head `c532d1a6` passed the full [required CI](https://github.com/anvai-labs/homebrew-tap/actions/runs/41055672957), including Linux install/tests, macOS and `CI Success`. Merged normally as `d37e4820` after this qualification; the upstream x86_64 Linux Node bottle became available, so no shared CI workaround was needed |
| Winget | Normal account submission [microsoft/winget-pkgs#465991](https://github.com/microsoft/winget-pkgs/pull/465991) followed the release app's permission refusal. All ten validation stages passed. Microsoft's policy bot requests the contributor agreement; upstream merge and availability are not claimed |

## What shipped

- T10 M5, [#653](https://github.com/anvai-labs/agentbrowser/pull/653): bounded
  per-destination research headers, session user-agent override, hashed configuration
  and dispatch ledger evidence; restrictive network policy composition is preserved.
- Explicit subrequest engagement sizing and low-budget warnings; page-local scope
  denial diagnostics; session pacing and budget counters; private forced re-export.
- Operations guidance for headed program browsing, engagement sizing and CLI page creation.
- [#645](https://github.com/anvai-labs/agentbrowser/pull/645): disclosure CDP state
  survives navigation, concurrent initialization and dead-session replacement.
- Reviewed build-stage Node and setup-python dependency updates (#643, #644).

See the versioned changelog for behavior disclosures. Injection evidence records dispatch
intent and does not prove remote receipt. No new live-program testing, worker/WebSocket
coverage, hostile-browser containment or local service upgrade is implied by this release.

## Timing failures retained as evidence

The first local hook hit an unchanged pending-iframe fixture whose final readiness assertion
can race the existing 30-second route timeout. Its isolated three tests and subsequent full
hooks passed without changing tests or production code. The first develop push CI hit the
previously diagnosed 500 ms disclosure-scan cap fixture; its complete rerun passed. The documentation follow-up encountered the unchanged iframe assertion again under host load; its failed hook is retained separately. These
failures were retained, and neither was treated as a green gate before successful reruns.

Candidate and downloaded-asset reports and verification JSON are preserved locally under
`/private/tmp/agentbrowser-v1.28.0-qualified/` and
`/private/tmp/agentbrowser-v1.28.0-published/` for this run; these temporary directories are
not durable repository evidence. CI run links above preserve the public delivery evidence.
