# T9: CI runner minutes (measured baseline)

**Measured:** 2026-10-15T18:06Z, by [`scripts/runner-minutes.mjs`](../../../scripts/runner-minutes.mjs)
(`node scripts/runner-minutes.mjs --runs 10`).

The script samples the last 10 successful runs per workflow through the GitHub API (read-only,
`gh` auth) and reports medians. Billed minutes round each job up to a whole minute, the way GitHub
meters hosted runners. The runner type comes from each job's runner name. Any run that used a
self-hosted runner is listed outright, because a median would hide it.

**Scope:**
- successful runs only (cancelled, superseded and failed runs are excluded);
- each run's latest attempt only;
- no macOS or Windows minute multipliers;
- figures are per CI round, so a pull request with several pushes uses a multiple.

| Workflow | Runs | Jobs | Wall min | Hosted job min | Hosted billed min | Self-hosted job min (median) | Runs with self-hosted jobs | Triggers sampled |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |
| `ci.yml` | 10 | 9 | 7.1 | 16.6 | 21 | 0 | — | pull_request, push |
| `windows-ci.yml` | 10 | 1 | 3.8 | 3.7 | 4 | 0 | — | pull_request, push |
| `journal-darwin.yml` | 8 | 1 | 1.7 | 1.4 | 2 | 0 | — | pull_request (journal paths) |
| `docs.yml` | 10 | 1 | 0.6 | 0.5 | 1 | 0 | — | pull_request |
| `release.yml` | 10 | 13 | 8.9 | 16.2 | 22.5 | 0 | **37161202430** | push (tags) |
| Dependabot updates | 10 | 1 | 1.3 | 1.2 | 2 | 0 | — | dynamic |
| Dependabot update-graph | 2 | 1 | 0.8 | 0.7 | 1 | 0 | — | dynamic |

## Reading it

- **Per CI round on a pull request:** about 26 billed hosted minutes (21 CI + 4 Windows + 1 `docs.yml`,
  which runs on every PR). Journal-path PRs add about 2 macOS minutes. Pull requests always run
  everything, because `paths-ignore` applies to pushes only.
- **Runner type:** all sampled jobs ran on GitHub-hosted runners **except in one release run**,
  37161202430 (v1.15.1, attempt 2). Two of its jobs ("Build agentbrowser-mcp-linux-x64" and
  "Server linux-x64") were picked up by self-hosted runners `anvai-wsl-1`/`-2` in the org's
  `public-overflow` group.
  - Those jobs requested the plain `ubuntu-latest` label, not a `vars.CI_*_RUNNER` override.
    Self-hosted runners carrying a standard label can take jobs from any repository the group
    admits.
  - Those runners no longer carry `ubuntu-latest`, so the path appears closed. The script now
    reports such runs explicitly.
- **Billing:** the repository is **public**, so GitHub-hosted minutes, including macOS, are not
  billed. These figures measure runner time and capacity, not cost.
- **Recent CI changes and their cost:**
  - The macOS journal leg (J-f, #492) adds about 1.5 job-minutes, and only on journal-path pull
    requests and the nightly run.
  - Least-privilege permissions and SHA pinning (H2, #481) change no runtime.
  - The dispatch-only ZAP depth workflow (F3) never runs on PRs.

## Before / after

No runner-use optimization has shipped yet, so this is the **before** baseline. Any future
optimization re-runs the script and records its medians here next to these, with the same
sample size.
