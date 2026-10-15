# T9: CI runner minutes (measured baseline)

**Measured:** 2026-10-15T17:43Z, by [`scripts/runner-minutes.mjs`](../../../scripts/runner-minutes.mjs)
(`node scripts/runner-minutes.mjs --runs 10`).

The script samples the last 10 successful runs per workflow through the GitHub API (read-only,
`gh` auth) and reports medians. Billed minutes round each job up to a whole minute, the way GitHub
meters hosted runners. The runner type comes from each job's runner name.

| Workflow | Runs | Jobs | Wall min | Hosted job min | Hosted billed min | Self-hosted job min | Triggers sampled |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| `ci.yml` | 10 | 9 | 7.3 | 16.5 | 20.5 | 0 | pull_request, push |
| `windows-ci.yml` | 10 | 1 | 4.1 | 4.0 | 4.5 | 0 | pull_request, push |
| `journal-darwin.yml` | 8 | 1 | 1.7 | 1.5 | 2 | 0 | pull_request (journal paths) |
| `docs.yml` | 10 | 1 | 0.6 | 0.5 | 1 | 0 | pull_request |
| `release.yml` | 10 | 13 | 8.9 | 16.2 | 22.5 | 0 | push (tags) |
| Dependabot | 10 | 1 | 1.3 | 1.2 | 2 | 0 | dynamic |

## Reading it

- **Per pull request:** about 25 billed hosted minutes (CI plus Windows). Journal-path PRs add
  about 2 macOS minutes. A docs-only PR runs `docs.yml` plus the full suites, because pull
  requests always run everything.
- **Runner type:** every sampled job ran on GitHub-hosted runners, although the workflows allow
  self-hosted runners through `vars.CI_*_RUNNER`.
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
