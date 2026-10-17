# Release 1.21.0 delivery record

| Status | Tag | Commit | Notes |
| --- | --- | --- | --- |
| **released 2026-10-16** | `v1.21.0` | main `c921e1b` (promotion PR #544, merge commit) | T10 milestone M1: an engagement scope without holes |

```
develop ─#543 sync─▶ #544 promote ─▶ main c921e1b ─▶ tag v1.21.0 ─▶ release.yml
   builds ✔ ─▶ npm ⏸ owner approval ✔ ─▶ attest + draft ─▶ upload ─▶ publish ─▶ winget branch
```

## Publication, verified after the run

| Channel | Result | How it was checked |
| --- | --- | --- |
| Release run 38974842067 | ✔ 14/14 jobs, 22:17–22:31 UTC | tag guard (version + main ancestry), builds, servers, Windows bundle, npm, release, winget |
| npm gate | ✔ approved by the owner | environment `npm`, deployment 7130792737 |
| GitHub Release | ✔ 16 assets, published, immutable | `sha256sum -c sha256sums.txt`: 15/15 OK; release `immutable: true` |
| Build provenance | ✔ all 16 assets | `gh attestation verify <file> -R anvai-labs/agentbrowser` |
| Versions inside the artifacts | ✔ 1.21.0 | CLI `--version`; MCP `initialize` → `serverInfo.version`; server tarball and Windows zip `package.json` |
| npm `@anvailabs/agentbrowser-mcp` | ✔ `1.21.0`, `latest` | `sha512-X4ZZxD/zpGnysexYJ9S7YKfdlp7Qp3ikFYOcJulYBzB1LjtiPhiewjeIUjQGxDVc9MO+YfN8kv+b4HR5n5WPzw==`; SLSA provenance |
| Docs site | ✔ live | Deploy Documentation green on `c921e1b`; the T10 page is served |
| Homebrew tap | ✔ formula on 1.21.0 | tap PR #108 merged (`3e91bdd`): all 12 hashes match `sha256sums.txt`; tap CI green |
| winget | branch pushed (note 1) | the App pushed `ab-agentbrowser-1.21.0` to the fork |

| Note | Detail |
| --- | --- |
| 1 | The 1.19.0 new-package PR (#454058) has passed validation and awaits a moderator; 1.20.0 and 1.21.0 are submitted manually after it is approved. |

## Milestone smoke on the released candidate

`scripts/scope-consumer-smoke.mjs` against the extracted `agentbrowser-server-linux-x64.tar.gz`
and the released Linux CLI and MCP binaries (`candidateSource: extracted_package`,
`packageCommit c921e1b`, `releaseEvidence: true`):

| Check | Result |
| --- | --- |
| Lanes refused with a scope | REST: service workers, `cdpAttach`, top-level scope all `400`; CLI: service workers refused |
| Out-of-scope navigation | REST and SDK `SCOPE_HOST_DENIED`; MCP and CLI `egress_policy` (the recorded M2 gap); none reached the wire |
| Form POST redirected out of scope | not leaked; recorded as a blocked `request.failed` |

## What shipped

| Area | PRs |
| --- | --- |
| Security: redirects after POST/PUT/PATCH checked in scoped sessions | #540 |
| Security: a scope refuses `cdpAttach`, service workers and a top-level scope | #541 |
| Tests: engagement-scope release smoke | #542 |
| Docs: T10 plan and record hygiene; the 1.20.0 record | #539, #538 |

Upgrade notes: CHANGELOG `[1.21.0]`.
