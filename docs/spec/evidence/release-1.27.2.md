# Release 1.27.2 evidence

*Recorded retroactively on 2026-10-27 (the 1.27.3 and 1.27.4 records shipped first);
every verification row below was re-checked against live sources at writing time.*

| Status | Tag | Commit | Notes |
| --- | --- | --- | --- |
| Released | `v1.27.2` | `ed118c80964b5428cd925904390a69b5035a34cd` | Promotion merge #630; maintenance release (dedup series, hygiene ratchets, tldts lazy-load) |

```text
develop ── #616–#622 dedup ── #623–#626 hygiene ── #615 tldts ── #627 version sync ──► main (#628)
   ├─ tag v1.27.2 on #628 ─► release run 40056367409 ✗ (npm approval stall, then guard-flag bug)
   ├─ retag onto the unlanded fix ─► run 40105919900 ✗ (tag ancestry: not reachable from main)
   └─ #629 fix → develop ── #630 develop → main ── tag recut on ed118c80
                                     └─► release run 40133198130 ─► npm (owner approval)
                                                                ├─ GitHub Release (16 assets, attested)
                                                                └─ winget manifests
main ─► tap dispatch (anvai-labs/homebrew-tap) ─► PR #129 ─► CI approved ─► merged
```

## Release-run history — two failures before the green run

1. **Run [40056367409](https://github.com/anvai-labs/agentbrowser/actions/runs/40056367409)**
   (tag on the #628 promotion merge): the npm job sat ~11.5 h in `waiting`
   (03:04Z → approved 14:34Z) — the `npm` deployment environment has required
   reviewers, and a gated deployment waits indefinitely for a human (by design; the
   owner found and approved it). After approval the job **failed**: the host-question
   guard was invoked as `node --test <file> --test-name-pattern="npm MCP bundle"` —
   node --test ignores the name-pattern flag when it follows the file argument, so all
   three guard tests ran and the compiled-CLI test failed on a missing `dist-bin` (the
   npm job does not run `pnpm compile`). A re-run of the failed jobs (deployment
   `7300265652`, approved promptly) hit the same deterministic failure at 15:06Z.
2. **Run [40105919900](https://github.com/anvai-labs/agentbrowser/actions/runs/40105919900)**:
   the flag-order fix (`3b95f0bb`) was unlanded — on no branch, existing on GitHub
   only as the force-moved tag's target — `check-tag-ancestry` refused it: *"Tag commit 3b95f0bb… is not
   reachable from origin/main: release tags must be cut from main."* Direct pushes to
   protected `main` were (correctly) rejected throughout; the gate did its job.
3. **The sanctioned route landed the fix**: PR #629 (fix → develop, `ffc038bb`) → PR #630
   (develop → main, `ed118c80`) → tag recut on the merged main → run
   [40133198130](https://github.com/anvai-labs/agentbrowser/actions/runs/40133198130)
   green end to end (20m42s).

Lessons: `node --test` flags must precede the file argument (the guard now runs
pattern-first in release.yml); never retag onto an unlanded commit — the ancestry gate
exists exactly for that; a branch-protection rejection is a route to follow (branch →
PR → merge), not an obstacle to push around; and a `waiting` npm deployment is an
approval prompt, not a hung runner.

## Publication, verified after the run

| Channel | Evidence |
| --- | --- |
| tag-guard | Tag matches package version (1.27.2) — success |
| Binaries | 5 targets compiled + smoke — success |
| Windows bundle + server tarballs | success (4 server targets) |
| npm | `@anvailabs/agentbrowser-mcp@1.27.2` published 2026-10-24T21:30:27Z; owner approved the `npm` environment deployment `7304616668` |
| GitHub Release | `v1.27.2` published 2026-10-24T21:31:44Z (not draft), 16 assets |
| Checksums | `agentbrowser-cli-darwin-arm64` verified against `sha256sums.txt` (`OK`) — re-checked 2026-10-27 |
| Attestations | `gh attestation verify` exit 0 on the CLI asset — re-checked 2026-10-27 |
| winget | Manifests job success |
| Homebrew tap | Formula bump PR [anvai-labs/homebrew-tap#129](https://github.com/anvai-labs/homebrew-tap/pull/129) merged 2026-10-24T22:06:05Z (same-evening tap refresh: dq-kernel 0.2.0 #127, victor 0.16.0 #128 → 0.17.0 #130, inferflux 0.5.3 #131) |
| Local deployment | `brew upgrade` to 1.27.2; the 1.27.3 record's `brew upgrade: 1.27.2 → 1.27.3` confirms the local service ran this release as its baseline |

## What shipped

Maintenance window since 1.27.1 — 15 PRs, all merged through required CI checks (10 of
the 15 carry an explicit "Adversarial review pass" findings comment on the PR thread):

- **#615** — tldts lazy-load, the headline: `@agentbrowser/core` loads tldts on the first
  host question instead of at import; the v7 bump (6.1.76 → 7.4.18) lands under the T8
  75 MB gate (MCP idle **81.7 → 59.8 MB**, CLI one-shot **73.4 → 58.3 MB**). Adds the
  behavioral host-question guard whose flag order caused the release-run drama above.
- **#616–#622** — the four-pass jscpd dedup series: 34 → 17 clone pairs at window 120,
  window-50/80 passes, shared test harnesses (journal fixtures, keyed server, rpc
  harness, withPage, storeCleanup).
- **#623** — shared Chromium engine for launch-dense suites (−9% suite time) plus the
  `acquireSharedBrowser` crash-isolation fix.
- **#624** — the two orphaned root test runners wired into CI (`spec-context` in
  test:release; `mcp-catalog-docs` in a post-build Test-job step).
- **#625 / #626** — three two-sided CI ratchets (layering 0, duplication 4373 tokens at
  window 100, dead exports 0) and the 88-export classification (67 kept public API,
  20 de-exported, 1 deleted); window-wide the diffs de-export 26 names — the extras are
  policy-engine test helpers outside the candidate bucket.
- **#627** — version sync; **#629** — the release-guard flag-order fix.

## Upgrade notes

See the CHANGELOG's `[1.27.2]` section. Behavior disclosure: export-surface hygiene
removed previously-importable internal names from the `@anvailabs/agentbrowser-mcp`
barrel (`utf8Boundary`, `advertisedOutputSchema`, `BROWSER_DURABLE_TOOLS`,
`OPERATION_ID_TOOLS`) and `@agentbrowser/engagement` (`FINDING_SEVERITIES`); no in-repo
consumers existed — programmatic importers of these internals should pin their version.
Known follow-ups at the time (both since landed): the tap formula should carry
`AGENTBROWSER_POLICY_FILE` natively (tap #134, shipped with 1.27.3/1.27.4 docs), and
`policy export` did not emit `limits` (#641, shipped in 1.27.4).
