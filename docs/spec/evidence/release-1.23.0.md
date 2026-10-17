# Release 1.23.0 delivery record

| Status | Tag | Commit | Notes |
| --- | --- | --- | --- |
| **released 2026-10-17** | `v1.23.0` | main `82b06ca` (promotion PR #564, merge commit) | T10 milestone M2 completes: the engagement ledger |

```
develop ─#563 sync─▶ #564 promote ─▶ main 82b06ca ─▶ tag v1.23.0 ─▶ release.yml
   builds ✔ ─▶ npm ⏸ owner approval ✔ ─▶ attest + draft ─▶ upload ─▶ publish ─▶ winget branch
```

## Publication, verified after the run

| Channel | Result | How it was checked |
| --- | --- | --- |
| Release run 39028240408 | ✔ 14/14 jobs, 11:19–13:33 UTC (includes the wait for owner approval) | tag guard (version + main ancestry), builds, servers, Windows bundle, npm, release, winget |
| npm gate | ✔ approved by the owner | environment `npm`, deployment 7138843391 |
| GitHub Release | ✔ 16 assets, published, immutable | `sha256sum -c sha256sums.txt`: 15/15 OK; release `immutable: true` |
| Build provenance | ✔ all 16 assets | `gh attestation verify <file> -R anvai-labs/agentbrowser` |
| Versions inside the artifacts | ✔ 1.23.0 | CLI `--version`; MCP `initialize` → `serverInfo.version`; server tarball and Windows zip `package.json` |
| npm `@anvailabs/agentbrowser-mcp` | ✔ `1.23.0`, `latest` | `sha512-keLGjVwyL15ShFQr6VTSl3JvttUngIn4AuGCK9cs+PW8iAW6pmY799ih+sTkI6xVDzne+CB5tO6E9OMDMzPBiw==`; SLSA provenance |
| Docs site | ✔ deployed | Deploy Documentation green on the `82b06ca` push |
| Homebrew tap | ✔ formula on 1.23.0 | tap PR #110 merged (`19e16bd`): all 12 hashes match `sha256sums.txt`; tap CI green (4/4) |
| winget | branch pushed (note 1) | the App pushed `ab-agentbrowser-1.23.0` to `anvai-labs/winget-pkgs` |
| Back-sync | ✔ main in develop | PR #565 (merge commit `fc26dd4`) |

| Note | Detail |
| --- | --- |
| 1 | The 1.19.0 new-package PR (#454058) awaits a moderator; later versions are submitted manually after it is approved. |
| 2 | 1.22.0 (main `4eb7885`, run 39008344538) was released by the owner; its delivery is recorded in `docs/consumer-field-handoff-2026-10-16.txt` (#555, #557), not as a record here. |
| 3 | #566, #567 and #568 (scope-denial reporting in page creation, downloads, navigation and autofill) merged to develop after the promotion and are **not** in 1.23.0. |

## Milestone smoke on the released candidate

`scripts/scope-consumer-smoke.mjs` against the extracted `agentbrowser-server-linux-x64.tar.gz`
and the released Linux CLI and MCP binaries (`candidateSource: extracted_package`,
`packageCommit 82b06ca`, `releaseEvidence: true`):

| Check | Result |
| --- | --- |
| Lanes refused with a scope | REST: service workers, `cdpAttach`, top-level scope all `400`; CLI: service workers refused |
| Out-of-scope navigation | `SCOPE_HOST_DENIED` on REST, SDK, MCP and CLI (the M1 MCP/CLI gap is closed) |
| Form POST redirected out of scope | not leaked; recorded as a blocked `request.failed` |
| Engagement ledger | 5 records; REST export `200`; released CLI `engagement verify` ok and closed; an edited copy refused (exit 1) |

## What shipped

| Area | PRs |
| --- | --- |
| Feature: the engagement ledger (hash-chained, metadata-only, fail closed) | #550 |
| Feature: export and offline verify (REST, SDK, CLI) | #556 |
| Fixes: unobserved body-bearing outcomes recorded at close; crash keeps close-time records; crash close tracked | #558, #559, #561 |
| Tests: ledger release smoke; close-wait pins; canonical engagement fixture | #559, #562, #560 |
| Docs and release: 1.22.0 delivery records; version sync | #555, #557, #563 |

Upgrade notes: CHANGELOG `[1.23.0]`.
