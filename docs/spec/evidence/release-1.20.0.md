# Release 1.20.0 delivery record

Status: **released 2026-10-16.** Tag `v1.20.0` on main `92a98ee` (promotion PR #536, merge commit).
The first release under the R14 gates: drafted then published, every asset attested, immutable,
and npm published only after the owner approved the deployment.

```
develop ─#535 sync─▶ #536 promote ─▶ main 92a98ee ─▶ immutable ON ─▶ tag v1.20.0 ─▶ release.yml
   builds ✔ ─▶ npm ⏸ owner approval ✔ ─▶ attest + draft ─▶ upload ─▶ publish ─▶ winget branch
```

## Publication, verified after the run

| Channel | Result | How it was checked |
| --- | --- | --- |
| Release run 38940171264 | ✔ 14/14 jobs, 17:30–17:49 UTC | tag guard (version + main ancestry), builds, servers, Windows bundle, npm, release, winget |
| npm gate | ✔ approved by the owner | environment `npm` deployment 7125519381; the agent's own approval attempt was refused by its permission policy, by design |
| GitHub Release | ✔ 16 assets, published, **immutable** | `sha256sum -c sha256sums.txt`: 15/15 OK; release `immutable: true` |
| Build provenance | ✔ all 16 assets | `gh attestation verify <file> -R anvai-labs/agentbrowser`: signed by `release.yml` at `refs/tags/v1.20.0` |
| Versions inside the artifacts | ✔ 1.20.0 | CLI `--version`; MCP `initialize` → `serverInfo.version`; server tarball and Windows zip `package.json` |
| npm `@anvailabs/agentbrowser-mcp` | ✔ `1.20.0`, `latest` | `sha512-bV+p0aA+RbBWXRUbWrogQHslZ739YIdP2ChLEAQfVlwSk7WA1iDDrNd00v+vnw0P73kX2ENlUIldBr89hoZO+A==`; SLSA provenance |
| Docs site | ✔ live | Deploy Documentation green on `92a98ee`; the new pages (observation gotchas, policy "Start here") are served |
| Homebrew tap | ✔ formula on 1.20.0 | tap PR #107: all 12 hashes match `sha256sums.txt`; tap CI green |
| winget | branch pushed, PR held | the App minted its token and pushed `ab-agentbrowser-1.20.0` to the fork; the PR into microsoft/winget-pkgs is held until the 1.19.0 new-package PR (#454058) is approved |

## What shipped

| Area | PRs |
| --- | --- |
| Release hardening (R14): tag ruleset, npm review, provenance attestations, draft → publish, immutable releases | #529 |
| Policy: a file's approvalRules apply; startup refuses invalid rules and unread decisions; secure starter policy and operator guide | #531 |
| Observation: native disclosures as `html-summary` with `expanded`, from Chromium's AX tree; follow-ups | #532, #533, #534 |
| Records: 1.19.0 release record | #528 |

Full notes and upgrade table: CHANGELOG `[1.20.0]`.

## Residual

- **winget:** submit the held 1.20.0 PR after Microsoft approves #454058 (then it is a routine update).
- **Obscura (experimental):** an unreadable disclosure state is refused as retryable `STALE_TARGET`;
  a distinct non-retryable message is a recorded follow-up.
