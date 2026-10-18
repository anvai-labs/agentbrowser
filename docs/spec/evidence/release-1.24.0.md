# Release 1.24.0 delivery record

| Status | Tag | Commit | Notes |
| --- | --- | --- | --- |
| **released 2026-10-17** | `v1.24.0` | main `400ba54` (promotion PR #579, merge commit) | T10 milestone M2 completes: denial reporting everywhere; strict session requests |

```
develop ─#578 sync─▶ #579 promote ─▶ main 400ba54 ─▶ tag v1.24.0 ─▶ release.yml
   builds ✔ ─▶ npm ⏸ owner approval ✔ ─▶ attest + draft ─▶ upload ─▶ publish ─▶ winget branch
```

## Publication, verified after the run

| Channel | Result | How it was checked |
| --- | --- | --- |
| Release run 39071090253 | ✔ 14/14 jobs, 21:28–22:02 UTC (includes the wait for owner approval) | tag guard (version + main ancestry), builds, servers, Windows bundle, npm, release, winget |
| npm gate | ✔ approved by the owner | environment `npm`, deployment 7146098309 |
| GitHub Release | ✔ 16 assets, published, immutable | `sha256sum -c sha256sums.txt`: 15/15 OK; release `immutable: true` |
| Build provenance | ✔ all 16 assets | `gh attestation verify <file> -R anvai-labs/agentbrowser` |
| Versions inside the artifacts | ✔ 1.24.0 | CLI `--version`; MCP `initialize` → `serverInfo.version`; server tarball `package.json` and `VERSION.json` (commit `400ba54`); Windows zip `package.json` |
| npm `@anvailabs/agentbrowser-mcp` | ✔ `1.24.0`, `latest` | `sha512-fBRTTUobTozAk3Ck43HILYFTANoIO0zhraI8Z6h5ULScEA5XTWzQBqsDXFj3cVTmb1g4twQFh7h6QbXuD9bJSg==`; SLSA provenance |
| Docs site | ✔ deployed | Deploy Documentation green on the `400ba54` push |
| Homebrew tap | ✔ formula on 1.24.0 | tap PR #113 merged (`79eb1d0`): all 12 hashes match `sha256sums.txt`; tap CI green (4/4) |
| winget | branch pushed (note 1) | the App pushed `ab-agentbrowser-1.24.0` to `anvai-labs/winget-pkgs` |
| Back-sync | ✔ main in develop | PR #580 (merge commit `34dc810`) |

| Note | Detail |
| --- | --- |
| 1 | The 1.19.0 new-package PR (#454058) awaits a moderator; later versions are submitted manually after it is approved. |
| 2 | #573 (T10 M3 program-scope fields) was reviewed CLEAN but held for 1.25.0; it is **not** in 1.24.0. |

## Milestone smoke on the released candidate

`scripts/scope-consumer-smoke.mjs` from a `v1.24.0` checkout against the extracted
`agentbrowser-server-linux-x64.tar.gz` and the released Linux CLI and MCP binaries
(`candidateSource: extracted_package`, `packageCommit 400ba54`, `releaseEvidence: true`):

| Check | Result |
| --- | --- |
| Lanes refused with a scope | REST: service workers, `cdpAttach`, top-level scope all `400`; CLI: service workers refused |
| Out-of-scope navigation | `SCOPE_HOST_DENIED` on REST, SDK, MCP and CLI |
| Form POST redirected out of scope | not leaked; recorded as a blocked `request.failed` |
| Engagement ledger | 5 records; REST export `200`; released CLI `engagement verify` ok; an edited copy refused |

## What shipped

| Area | PRs |
| --- | --- |
| Denial reporting: page creation, downloads, completed actions, autofill (owner) | #566, #567, #568, #569 |
| Security: unknown scope fields refused; strict session requests and embedder validation; path rules bind the hosts they name | #572, #574, #576 |
| Fix: named session-create refusals keep their guidance | #577 |
| Docs: site aligned with 1.23.0 and the plan; T10 plan; 1.23.0 record | #575, #571, #570 |
| CI: winget credential check (owner) | #530 |
| Release: version sync | #578 |

Upgrade notes: CHANGELOG `[1.24.0]` (breaking: top-level policy fields in `POST /v1/sessions`).
