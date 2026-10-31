# Release 1.29.0 evidence

| Status | Tag | Commit | Notes |
| --- | --- | --- | --- |
| Released | `v1.29.0` | `9cb443e9cb623fbbbe907253e39cdfcfb5ab8235` | Promotion [#661](https://github.com/anvai-labs/agentbrowser/pull/661); minor release |

## Qualified source and delivery

The [release](https://github.com/anvai-labs/agentbrowser/releases/tag/v1.29.0)
was published on 2026-10-31. Release preparation — version stamps and the
changelog entry — landed with the feature merge
[#660](https://github.com/anvai-labs/agentbrowser/pull/660) (`898eab31`), whose
stated release discipline included an independent adversarial review before
merge; no separate preparation PR was needed. The develop head and the main
promotion have identical trees; the back-sync
[#662](https://github.com/anvai-labs/agentbrowser/pull/662) confirmed this by
fast-forwarding with zero file changes. The qualification below is CI- and
delivery-based.

| Gate or channel | Verified evidence |
| --- | --- |
| Develop CI at release head | [41172071630](https://github.com/anvai-labs/agentbrowser/actions/runs/41172071630), success; Windows [41172071785](https://github.com/anvai-labs/agentbrowser/actions/runs/41172071785), success (`898eab31`) |
| Local gates at tag push | Full pre-push suite passed before pushing `v1.29.0`: type-check, all package tests and smoke. The first attempt surfaced only stale local `dist` artifacts (protocol rebuilt from pre-#659/#660 sources), not a source defect |
| Promotion PR CI | [41173304286](https://github.com/anvai-labs/agentbrowser/actions/runs/41173304286), success, including the strict docs build |
| Main postmerge CI | [41174058604](https://github.com/anvai-labs/agentbrowser/actions/runs/41174058604), success; Windows [41174058541](https://github.com/anvai-labs/agentbrowser/actions/runs/41174058541); deployed documentation [41174058582](https://github.com/anvai-labs/agentbrowser/actions/runs/41174058582) |
| Release workflow | [41174333652](https://github.com/anvai-labs/agentbrowser/actions/runs/41174333652), success: tag guard (tag matches package version), five binary targets, four accepted server archives, Windows bundle, npm, checksums and GitHub Release |
| npm | Deployment [7454936451](https://github.com/anvai-labs/agentbrowser/deployments/7454936451) owner-approved; `@anvailabs/agentbrowser-mcp@1.29.0` verified live, with npm `latest` = `1.29.0` |
| GitHub | Published, immutable, not draft; all 16 assets present |
| Downloaded bytes | Native Darwin ARM CLI, MCP and server archive match the published `sha256sums.txt` (`shasum -a 256 -c`) |
| Back-sync | [#662](https://github.com/anvai-labs/agentbrowser/pull/662), merged as `53c36dc5`; fast-forward branch with zero diff, so the main promotion is an ancestor of develop |
| Homebrew | Victor prerequisite [tap #144](https://github.com/anvai-labs/homebrew-tap/pull/144) merged first as `8f6673ba` (the live PyPI latest-version contract test blocks unrelated automation PRs), then [tap #143](https://github.com/anvai-labs/homebrew-tap/pull/143), formula-only with 12 URL/hash pairs; the full required [CI](https://github.com/anvai-labs/homebrew-tap/actions/runs/41176628146) passed, including Linux install/tests and macOS. Squash-merged as `437a88ff`; `brew info` reports stable `1.29.0_1` |
| Winget | Release manifests ship as workflow assets; no winget-pkgs submission was performed in this release session |

## What shipped

- Operator evidence passes, [#659](https://github.com/anvai-labs/agentbrowser/pull/659)
  (T10 B1–B6): exact-origin cookie/localStorage transfer into a fresh scoped,
  ledgered context ([ADR-027](../../adr/027-evidence-pass-state-transfer.md));
  denied-host summaries, offline adoption, site bundles and audited live asset
  appends ([ADR-028](../../adr/028-operator-asset-scope-amendments.md)); bounty
  session defaults; two-window operations guide.
- Containment hardening, [#659](https://github.com/anvai-labs/agentbrowser/pull/659):
  independent enforced `worker-src 'none'` CSP from creation via bounded
  (8 MiB / 15 s) explicit native body delivery, preserving native upload bytes.
- Live diagnostics and recovery, [#660](https://github.com/anvai-labs/agentbrowser/pull/660):
  default live denial tracing with bounded authenticated streams on
  SDK/CLI/MCP; method × destination-class fingerprints including scope-denied
  methods; tenant-local page-load history sizing warnings and explicit import
  presets; operator-approved finite budget increases
  ([ADR-029](../../adr/029-operator-budget-topup.md)) that preserve pages and
  counters; canonical scope export/import with validate-only identity hints.
- Deterministic disclosure-cap coverage fixtures (Fixed section of the 1.29.0 changelog).

Live Wolt/Vinted acceptance remains pending operator verification, as stated in
#660. Unfinished page-fetch and coordinate handoff work is excluded and
continues under the
[bounty flow continuity](../design/t10-bounty-flow-continuity.md) plan. No
service restart is implied by this release.
