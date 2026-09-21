# AgentBrowser 1.9.1 delivery evidence

Published 2026-09-20 (America/Chicago). Tag `v1.9.1` identifies protected-main
commit `310e01d43982824caac2c63ed8d98355e17efdce`, tree
`4e6c85697280b397a1d956b839db4f449c488d57`. The annotated tag object is
`dc073bd313490bb3fa834a54a1e69248634591a2`.

## Scope and review

This checkpoint includes the integrated T3 regression/reporting vertical, foundation
alignment, Node 24 baseline, bounded widget commitment verification and CLI cookie-file
handoff. The [changelog](../../../CHANGELOG.md#191---2026-09-20) describes the surface;
the [cookie contract](../design/cli-cookie-file-handoff.md) specifies formats and refusals.
CLI/MCP executables are compiled with Bun 1.4; the service ships compiled JavaScript
and production dependencies and uses Node 24 through Homebrew. MCP remains optional.

Independent adversarial review approved candidate
`bbaca451123399efd8f429661b9f3ee22e0435c8` and independently reran 39 focused tests.
The failed-write pathname cleanup finding was fixed with two failing-first tests before
approval. The develop and main merge trees exactly match that reviewed tree. All
promotion used PRs; no force push, administration bypass, GitHub workflow rerun or artifact replacement
was used for this release.

| Gate | Identity | Result |
|---|---|---|
| Cookie/checkpoint [PR 233](https://github.com/anvai-labs/agentbrowser/pull/233) | `bbaca451` | [8/8 checks](https://github.com/anvai-labs/agentbrowser/actions/runs/35547617463) |
| Develop merge | `2b89ced9db66cfc7885739de0467cd1cfc21bfe6` | [8/8 post-merge checks](https://github.com/anvai-labs/agentbrowser/actions/runs/35548007397) |
| Main promotion [PR 234](https://github.com/anvai-labs/agentbrowser/pull/234) | `2b89ced9` | [8/8 checks](https://github.com/anvai-labs/agentbrowser/actions/runs/35548035685) |
| Main/tag commit | `310e01d4` | [8/8 post-merge checks](https://github.com/anvai-labs/agentbrowser/actions/runs/35548233350) |
| Published release | `v1.9.1` | [12/12 release jobs](https://github.com/anvai-labs/agentbrowser/actions/runs/35548598192) |

Main retains eight strict required checks, administrator enforcement, and force-push
and deletion blocks. Develop remains operationally gated; it does not have equivalent
branch protection. T9 remains recurring work.

## Published artifacts

All fourteen binary/server downloads from the [release](https://github.com/anvai-labs/agentbrowser/releases/tag/v1.9.1)
matched the published `sha256sums.txt` (the fifteenth asset). Each of the four server
archives contains version 1.9.1, the exact main commit above, and `dirty: false`.
The downloaded Darwin ARM CLI/MCP and extracted service passed the existing complete
acceptance harness on Node 24.21.0 with `releaseEvidence: true`.

The exact npm package `@anvailabs/agentbrowser-mcp@1.9.1` was downloaded and its bytes
matched registry integrity:

```text
sha512-ddBFDTaaO3fadiJmYsTVHz46mKHf3nwSwlrZHlDpkFp/kNpEMdL0Xqn3RkZtRlSxD92MzZz6Sr9P2XEfkpfmMw==
```

Its bundled executable passed MCP initialization/catalog checks and both supported
protocols' delegated/unbound contract checks. Registry signature and provenance
metadata were present; this local check verified tarball integrity and executable
behavior, not independent cryptographic verification of the attestation chain.

## Installed consumer qualification

On macOS ARM64, Homebrew upgraded the existing 1.9.0 installation to 1.9.1 using
the candidate formula in [tap PR 58](https://github.com/anvai-labs/homebrew-tap/pull/58).
The Node 24.21.0 dependency, formula audit and formula tests passed. Installed paths
resolve under `/opt/homebrew/Cellar/agentbrowser/1.9.1/`.

The actual installed `bin/agentbrowser-server` wrapper started an isolated service on
a temporary loopback port. Its 1.9.1 health identity, authentication refusal, authorized
session/page creation and graceful cleanup passed. The full existing acceptance harness
then ran against the installed `libexec` and CLI/MCP binaries with `releaseEvidence: true`.
This includes all three cookie imports, four authenticated fixture sessions, private
export/re-import, missing-cookie/partitioned-input/existing-output controls, and the
existing browser, download, coexistence and T2/T3 checks. No live account credentials
were used. Existing background services and logged-in headed sessions were not restarted;
an installed upgrade is not a hot upgrade of an already running process.

Independent tap review approved `a69a998647675e2e6d0fe8c235505152f794d338` after hashing
all twelve referenced artifact bytes and checking the Node 24 dependency/wrapper and
installed CLI tests. [Tap PR 58](https://github.com/anvai-labs/homebrew-tap/pull/58)
passed [all three checks](https://github.com/anvai-labs/homebrew-tap/actions/runs/35549476917)
and merged as `9f9fa1b3c3960575417274ac9e983775b8c367a7`. Its
[post-merge validation](https://github.com/anvai-labs/homebrew-tap/actions/runs/35549837273)
is tracked separately. The installed tap checkout was restored to its updated main
branch with a clean tree. This evidence branch starts from release main so its
documentation PR also synchronizes main's ancestry back into develop; that PR and
tap post-merge validation must pass before final delivery is closed.

## Local validation and limits

- Normal pre-commit/pre-push gates passed: typecheck, lint, build and workspace tests.
  CLI coverage includes 156 passing tests, 30 of them cookie-file cases.
- Existing packaging/version/spec checks passed (46 tests), and 539 relative links
  across 147 Markdown files resolved before candidate publication.
- Bounded Node 22 compatibility passed eleven packaging/version tests and CLI
  version/help. This is not a claim of the full acceptance matrix on Node 22.
- Full job applications, broader widget/popup readiness, custom-adapter callback
  hardening, production verification/G6, durable recovery and installed third-party
  harness qualification remain open. See the
  [future job checkpoint](../design/t6-job-application-checkpoint.md).
- No runtime dependency, service endpoint, MCP tool or CI job was added by cookie-file
  handoff. This release reuses the existing jobs and acceptance harness; no measured
  CI runner-minute savings claim is made.
