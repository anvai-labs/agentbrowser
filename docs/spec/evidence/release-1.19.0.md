# Release 1.19.0 delivery record

Status: **released 2026-10-16.** Tag `v1.19.0` on main `c963d4f` (promotion PR #526, merge commit).

```
develop ──#524 sync──#525 docs──▶ #526 promote ──▶ main c963d4f ──tag v1.19.0──▶ release.yml (14/14)
                                                                         │
     GitHub Release (16 assets) · npm · Windows zip · winget manifests ◀─┘
     docs site (Deploy Documentation on c963d4f) · Homebrew tap #106 · back-sync #527
```

## Publication, verified after the run

| Channel | Result | How it was checked |
| --- | --- | --- |
| Release run 38859766439 | ✔ 14/14 jobs, 06:10–06:18 UTC | tag guard (version + main ancestry), 5 MCP builds, 4 servers, Windows bundle, npm, checksums + Release, winget |
| GitHub Release | ✔ 16 assets, published, not draft | all 15 binaries/archives match `sha256sums.txt` (`sha256sum -c`) |
| Versions inside the artifacts | ✔ 1.19.0 | CLI `--version`; MCP `initialize` → `serverInfo.version`; server tarball and Windows zip `package.json` |
| npm `@anvailabs/agentbrowser-mcp` | ✔ `1.19.0`, `latest` | `sha512-rAYGLuYalBelfoY0A2PlhSO+UxY9RS+VO3mmckK1R+qVgKsUx8LEASsOebhv73ial3+GM4uHwvFoQg06tl1CQw==`; SLSA provenance attestation present |
| Docs site | ✔ live | Deploy Documentation green on `c963d4f`; new pages (T5 designs, journal evidence, release records) return 200; the durability diagram and status table render |
| Homebrew tap | ✔ formula on 1.19.0 | tap PR #106 (`afaf38a`): all 12 hashes match `sha256sums.txt`; tap CI run 38860802464 green (formula validation, `brew audit` + install tests, cask smoke) after an earlier run on the same SHA failed with no jobs (workflow file issue); post-merge tap CI green |
| winget | ✖ not submitted | no winget credential configured, so the job uploaded manifests as the `winget-manifests` artifact only; the first submission (1.17.1, winget-pkgs #451456) is still open |

## What shipped

| Area | PRs |
| --- | --- |
| Durable journal: runtime wiring, lookup/status, close/settle/continue/reconcile, history namespaces, recovery gates | #488, #490, #492, #494, #498, #503, #506, #509, #512–#515, #517 |
| Browser durability: durable `act`/`plan`/`autofill`, parity, crash and recovery rows per owner | #516–#522 |
| MCP: output schemas for every tool, `notifications/cancelled`; 100-step plan cap | #478, #482, #485, #489 |
| Widgets: real react-select, exact chip sets, staged mappings, Firefox/WebKit | #491, #502, #507, #511 |
| CI/release: least privilege, SHA pins, test-evaluate action, runner minutes | #481, #500, #504 |
| Faster observation (F1 bench, F2); plan no longer re-runs a step whose follow-up read failed | #493, #496, #521 |
| Audit labels and real-ZAP run (T7); T4 parseOutput and restart claims; ADR-026; Q1 re-qualification | #477, #501, #486, #510, #495, #497 |
| Docs site: complete nav with drift validation, visual durability overview | #525 |

Full notes: CHANGELOG `[1.19.0]`.

## Qualification

- Every PR had an independent adversarial review ending CLEAN and CI green on its exact head.
- #526 was green on `88d66a7` (all required contexts) before the merge to main.
- First release on the least-privilege, SHA-pinned workflow: npm OIDC publish and the Release
  upload both succeeded under job-scoped permissions.

## Residual

- **winget**: configure `WINGET_APP_ID`/`WINGET_APP_PRIVATE_KEY` (or `WINGET_FORK_TOKEN`), or
  submit the `winget-manifests` artifact by hand; the 1.17.1 new-package PR still awaits review.
- **R14**: closed 2026-10-16, after this release (tag ruleset + `npm` environment protection).
