# Release 1.26.0 delivery record

| Status | Tag | Commit | Notes |
| --- | --- | --- | --- |
| **released 2026-10-19** | `v1.26.0` | main `09e3bca` (promotion PR #594, merge commit) | T10 milestone M4: automation runs — saved plan runs end to end, the `plan-run` CI action, durable runs |

```
develop ─#593 sync─▶ #594 promote ─▶ main 09e3bca ─▶ tag v1.26.0 ─▶ release.yml
   builds ✔ ─▶ npm ⏸ owner approval ✔ ─▶ attest + draft ─▶ upload ─▶ publish ─▶ winget branch
```

## Publication, verified after the run

| Channel | Result | How it was checked |
| --- | --- | --- |
| Release run 39194733802 | ✔ 14/14 jobs, 03:26–04:58 UTC (includes the wait for owner approval) | tag guard (version + main ancestry), builds, servers, Windows bundle, npm, release, winget |
| npm gate | ✔ approved by the owner | environment `npm`, deployment 7165081811 |
| GitHub Release | ✔ 16 assets, published, immutable | `sha256sum -c sha256sums.txt`: 15/15 OK; release `immutable: true` |
| Build provenance | ✔ all 16 assets | `gh attestation verify <file> -R anvai-labs/agentbrowser` |
| Versions inside the artifacts | ✔ 1.26.0 | CLI `--version`; MCP `initialize` → `serverInfo.version`; server tarball `package.json` and `VERSION.json` (commit `09e3bca`); Windows zip `package.json` |
| npm `@anvailabs/agentbrowser-mcp` | ✔ `1.26.0`, `latest` | `sha512-9Qbw2fisAHrI+bFarfQI367r6eR5SSzOnzzUU4ixns7pzeR90z1jxEMf7wucSRQhH6+n7bIPJXnUXNRaAFk1vw==`; SLSA provenance |
| Docs site | ✔ deployed | Deploy Documentation green on the `09e3bca` push |
| Homebrew tap | ✔ formula on 1.26.0 | tap PR #119 merged (`c34230d`): all 12 hashes in `sha256sums.txt`, every URL on `v1.26.0`; tap CI green (4/4) |
| winget | branch pushed (note 1) | the App pushed `ab-agentbrowser-1.26.0` to `anvai-labs/winget-pkgs` |
| Back-sync | ✔ main in develop | PR #595 (merge commit `98e51bd`) |

| Note | Detail |
| --- | --- |
| 1 | The 1.19.0 new-package PR (#454058) awaits a moderator; later versions are submitted manually after it is approved. |
| 2 | The findings library (`checkEngagementFindings`, `buildEngagementSarif`) still has no CLI/MCP command: the audit package stays out of those closures (T7 gate 7). Exposing it is an owner decision. |

## Milestone checks on the released candidate

`scripts/scope-consumer-smoke.mjs` from a `v1.26.0` checkout against the extracted
`agentbrowser-server-linux-x64.tar.gz` and the released Linux CLI and MCP binaries
(`candidateSource: extracted_package`, `packageCommit 09e3bca`, `releaseEvidence: true`):

| Check | Result |
| --- | --- |
| Lanes refused with a scope | REST: service workers, `cdpAttach`, top-level scope all `400`; CLI: service workers refused |
| Out-of-scope navigation | `SCOPE_HOST_DENIED` on REST, SDK, MCP and CLI |
| Form POST redirected out of scope | not leaked; recorded as a blocked `request.failed` |
| Engagement ledger | 5 records; REST export `200`; released CLI `engagement verify` ok; an edited copy refused |
| **Saved plan run (new in 1.26.0)** | the released CLI ran a scoped sign-in plan that submitted the form; JUnit `tests=2 failures=0`; a failing plan exited 1 with `PLAN_WAIT_TIMEOUT`; no session left open |

The released CLI's `scope import` on a text program scope (wildcard, apex, exclusion) produced the
expected scope.

## What shipped

| Area | PRs |
| --- | --- |
| CLI `run`: saved plan end to end, JUnit with error codes only, the `plan-run` action | #590 |
| Scope: async-loaded and recycled-option coverage on the real react-select | #591 |
| Durable runs inside an existing controlled session, with reconcile output on lost verdicts | #592 |
| Policy: bare allow/block domains cover their subtree (owner) | #588 |
| Docs and release: 1.25.0 record; version sync | #589, #593 |

Upgrade notes: CHANGELOG `[1.26.0]` (TypeScript: `PLAN_ERROR_CODES` and `ErrorCode` are new SDK
exports).
