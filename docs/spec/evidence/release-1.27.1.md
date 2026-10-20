# Release 1.27.1 delivery record

| Status | Tag | Commit | Notes |
| --- | --- | --- | --- |
| **released 2026-10-20** | `v1.27.1` | main `a0d02ea` (promotion PR #612, merge commit) | Maintenance: one shared host matcher — the session/engagement semantics drift is closed |

```
develop ─#611 sync─▶ #612 promote ─▶ main a0d02ea ─▶ tag v1.27.1 ─▶ release.yml
   builds ✔ ─▶ npm ⏸ owner approval ✔ ─▶ attest + draft ─▶ upload ─▶ publish ─▶ winget branch
```

## Publication, verified after the run

| Channel | Result | How it was checked |
| --- | --- | --- |
| Release run 39419989960 | ✔ 14/14 jobs, 12:08–15:07 UTC (includes the wait for owner approval) | tag guard (version + main ancestry), builds, servers, Windows bundle, npm, release, winget |
| npm gate | ✔ approved by the owner | environment `npm`, deployment 7199380441 |
| GitHub Release | ✔ 16 assets, published, immutable | `sha256sum -c sha256sums.txt`: 15/15 OK; release `immutable: true` |
| Build provenance | ✔ all 16 assets | `gh attestation verify <file> -R anvai-labs/agentbrowser` |
| Versions inside the artifacts | ✔ 1.27.1 | CLI `--version`; MCP `initialize` → `serverInfo.version`; server tarball `package.json` and `VERSION.json` (commit `a0d02ea`); Windows zip `package.json` |
| npm `@anvailabs/agentbrowser-mcp` | ✔ `1.27.1`, `latest` | `sha512-BsbTsJSZeIw7FR+lhoaNPrqBfpexnU/lFk7tEY1fX4n1hCkHwBW89CgufGVwTycxiU3xb3th4kuNI3X0uRS8Jg==`; SLSA provenance |
| Docs site | ✔ deployed | Deploy Documentation green on the `a0d02ea` push |
| Homebrew tap | ✔ formula on 1.27.1 | tap PR #123 merged (`2eb5f99`): all 12 URLs on `v1.27.1`, 12/12 hashes in `sha256sums.txt`; tap CI green (4/4) |
| winget | branch pushed (note 1) | the App pushed `ab-agentbrowser-1.27.1` to `anvai-labs/winget-pkgs` |
| Back-sync | ✔ main in develop | PR #613 (merge commit `6fe0003`) |

| Note | Detail |
| --- | --- |
| 1 | The 1.19.0 new-package PR (#454058) awaits a moderator; later versions are submitted manually after it is approved. |
| 2 | The sibling `victor.rb` formula's release-contract failure during tap validation was unrelated to this bump (stale 0.13.0 pin vs PyPI's new 0.13.1); fixed separately via tap PR merged as the victor 0.13.1 update. |

## Milestone checks on the released candidate

`scripts/scope-consumer-smoke.mjs` from a `v1.27.1` checkout against the extracted
`agentbrowser-server-linux-x64.tar.gz` and the released Linux CLI and MCP binaries
(`candidateSource: extracted_package`, `packageCommit a0d02ea`, `releaseEvidence: true`): lanes
refused, `SCOPE_HOST_DENIED` on all four surfaces, the POST redirect not leaked and recorded, the
engagement ledger exported/verified/edited-copy-refused, and the saved-plan run green.

The released CLI and server also verified the headline behaviors, re-run live for this record:

| Check | Result |
| --- | --- |
| `scope import` on a text program scope | bare `corp.test` imports to `allowedHosts [corp.test]`, matching the import table |
| Bare-domain subtree matching, released server | a session scoped to bare `app.example.com` let `cdn.app.example.com` through — the navigation reached `dns_unresolved`, not `SCOPE_HOST_DENIED`; the out-of-scope control `other.example.com` was denied. Under the pre-consolidation matcher the subdomain was denied too |
| Exact-only fallback pinned | under a bare `corp.test` scope the subdomain is still denied on 1.27.1: `.test` is unregistrable, so both matchers stay exact-only by design |
| `finding check` | present in the released binary (the MCP pair ships in audit/appsec/bounty modes) |

## What shipped

| Area | PRs |
| --- | --- |
| Host-matcher consolidation: one shared `hostMatchesPattern`; scope adopts bare-subtree; session trailing-dot entries normalized (#610) | #610 |
| Docs: automating a flow; docs audit refresh | #598, #599 |
| Chore: dependency updates (#601–#603) | #601, #602, #603 |

Upgrade notes: CHANGELOG `[1.27.1]` (both behavior widenings disclosed).
