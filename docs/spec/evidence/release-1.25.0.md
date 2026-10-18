# Release 1.25.0 delivery record

| Status | Tag | Commit | Notes |
| --- | --- | --- | --- |
| **released 2026-10-18** | `v1.25.0` | main `fa2cefe` (promotion PR #586, merge commit) | T10 milestone M3: program scope and findings bound to the engagement |

```
develop ─#585 sync─▶ #586 promote ─▶ main fa2cefe ─▶ tag v1.25.0 ─▶ release.yml
   builds ✔ ─▶ npm ⏸ owner approval ✔ ─▶ attest + draft ─▶ upload ─▶ publish ─▶ winget branch
```

## Publication, verified after the run

| Channel | Result | How it was checked |
| --- | --- | --- |
| Release run 39106395886 | ✔ 14/14 jobs, 07:05–07:30 UTC (includes the wait for owner approval) | tag guard (version + main ancestry), builds, servers, Windows bundle, npm, release, winget |
| npm gate | ✔ approved by the owner | environment `npm`, deployment 7151325002 |
| GitHub Release | ✔ 16 assets, published, immutable | `sha256sum -c sha256sums.txt`: 15/15 OK; release `immutable: true` |
| Build provenance | ✔ all 16 assets | `gh attestation verify <file> -R anvai-labs/agentbrowser` |
| Versions inside the artifacts | ✔ 1.25.0 | CLI `--version`; MCP `initialize` → `serverInfo.version`; server tarball `package.json` and `VERSION.json` (commit `fa2cefe`); Windows zip `package.json` |
| npm `@anvailabs/agentbrowser-mcp` | ✔ `1.25.0`, `latest` | `sha512-mG10GEsKaAK5IZLhf9yjxKVI2GJiSG/OoYUcSHBx362wnWL2f18Q0SynH5P51Rb32TYB/SrbXxw6erMjipUIOg==`; SLSA provenance |
| Docs site | ✔ deployed | Deploy Documentation green on the `fa2cefe` push |
| Homebrew tap | ✔ formula on 1.25.0 | tap PR #115 merged by the owner (`8f0fbb8`): all 12 hashes in `sha256sums.txt`, every URL on `v1.25.0`; tap CI green (4/4) |
| winget | branch pushed (note 1) | the App pushed `ab-agentbrowser-1.25.0` to `anvai-labs/winget-pkgs` |
| Back-sync | ✔ main in develop | PR #587 (merge commit `beb6988`, owner) |

| Note | Detail |
| --- | --- |
| 1 | The 1.19.0 new-package PR (#454058) awaits a moderator; later versions are submitted manually after it is approved. |
| 2 | Findings (`checkEngagementFindings`, `buildEngagementSarif`) ship as a library in `@agentbrowser/audit`; there is no CLI or MCP command because the audit package stays out of those closures (T7 gate 7). Exposing them is an owner decision. |

## Milestone checks on the released candidate

`scripts/scope-consumer-smoke.mjs` from a `v1.25.0` checkout against the extracted
`agentbrowser-server-linux-x64.tar.gz` and the released Linux CLI and MCP binaries
(`candidateSource: extracted_package`, `packageCommit fa2cefe`, `releaseEvidence: true`): lanes
refused, `SCOPE_HOST_DENIED` on all four surfaces, the POST redirect not leaked and recorded, and the
engagement ledger exported, verified and an edited copy refused.

The released Linux CLI's `scope import` on a text program scope:

| Input | Result |
| --- | --- |
| `*.corp.test`, `corp.test`, `https://portal.corp.test/app/*` | `allowedHosts [.corp.test, corp.test]`; the `/app/*` entry adds no rule (host fully in scope) |
| `- vpn.corp.test`, `- https://portal.corp.test/app/admin/*` | `excludeHosts [vpn.corp.test]`, `excludePaths [portal.corp.test /app/admin]` |
| `10.0.0.0/8` | refused (CIDR); `allowedSchemes [http, https]`, `allowedPorts [80, 443]` |
| `- 10.0.0.0/8` (an exclusion) | the import fails, exit 1 |

## What shipped

| Area | PRs |
| --- | --- |
| Scope: restrictive program fields (excludes, schemes, ports, program metadata) | #573 |
| Scope: `rateLimit` pacing, 15 s cap then `SCOPE_RATE_LIMITED` | #582 |
| Program scope importer (`scope import`) | #583 |
| Findings bound to the engagement, SARIF draft (library) | #584 |
| Docs and release: the 1.24.0 record; version sync | #581, #585 |

Upgrade notes: CHANGELOG `[1.25.0]` (TypeScript: `SCOPE_RATE_LIMITED` is a new union member).
