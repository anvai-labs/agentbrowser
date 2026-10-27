# `test evaluate` in CI

A composite GitHub Action that evaluates caller-observed AgentBrowser test-case bundles with a
pinned, **checksum-verified** release CLI and writes a JUnit report. It executes no tests, starts
no browser and fetches no evidence: your test job observes the run and produces the bundles
([bundle contract](../../../docs/spec/design/t3-cli-evaluation.md)); this step judges them with the
canonical contract and fails the job unless every bundle passed.

The action first ships with 1.19.0. Pin it by commit, like any third-party
action; `version` separately pins the CLI it installs.

```yaml
- uses: anvai-labs/agentbrowser/.github/actions/test-evaluate@<commit-sha> # release that ships it
  with:
    version: v1.27.4            # the CLI release to install (verified against sha256sums.txt)
    bundles: |
      test-results/agentbrowser  # a directory: every *.json in it
    junit: agentbrowser-evaluate.xml
- uses: actions/upload-artifact@<pinned-sha> # v4
  if: always()
  with:
    name: agentbrowser-evaluate
    path: agentbrowser-evaluate.xml
```

| Input | Required | Meaning |
| --- | --- | --- |
| `version` | yes | Release tag whose CLI evaluates (`v1.9.1` or later has `test evaluate`). |
| `bundles` | yes | Newline-separated bundle files or directories. A directory contributes its own `*.json` files (not subdirectories); a file listed twice is evaluated once. |
| `junit` | no | JUnit output path (default `agentbrowser-evaluate.xml`). |
| `reports-dir` | no | Directory for the full JSON reports, named `NNN-<bundle>.report.json` in evaluation order and set to mode `0600` (an existing directory's own mode is left as is). They can contain sensitive caller data; do not upload them publicly. |

- **Exit status:** 0 only when every bundle passed. A failed verdict is a JUnit `failure`; an
  invalid bundle (or one the CLI cannot judge) is a JUnit `error`. No bundles at all, a missing
  path, an unsupported runner platform or a checksum mismatch stops the step.
- **JUnit carries identities and verdicts only** (`descriptor.id@version` per bundle), never
  report contents.
- **What the checksum proves.** The CLI is verified against the same release's
  `sha256sums.txt`. That catches a corrupted, truncated or mismatched download. It does not prove
  the release itself is authentic: someone able to replace release assets could replace both. The
  release tag is also movable; pinning the action by commit does not pin the CLI bytes.
- **Runners:** release assets exist for Linux and macOS (x64, arm64) and Windows x64. This
  repository qualifies the entrypoint on Linux. Node 18 or later must be on the runner (it is on
  GitHub-hosted runners). Each evaluation is bounded at two minutes.

The entrypoint is `evaluate.mjs` (Node builtins only). It is qualified in this repository by
`scripts/test-evaluate-action.test.mjs`: a stub CLI on POSIX, and the real compiled CLI in CI.
