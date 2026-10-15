# `test evaluate` in CI

A composite GitHub Action that evaluates caller-observed AgentBrowser test-case bundles with a
pinned, **checksum-verified** release CLI and writes a JUnit report. It executes no tests, starts
no browser and fetches no evidence: your test job observes the run and produces the bundles
([bundle contract](../../../docs/spec/design/t3-cli-evaluation.md)); this step judges them with the
canonical contract and fails the job unless every bundle passed.

```yaml
- uses: anvai-labs/agentbrowser/.github/actions/test-evaluate@v1.19.0
  with:
    version: v1.18.0            # the CLI release to install (verified against sha256sums.txt)
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
| `bundles` | yes | Newline-separated bundle files or directories (directories expand to `*.json`). |
| `junit` | no | JUnit output path (default `agentbrowser-evaluate.xml`). |
| `reports-dir` | no | Directory for the full JSON reports, written mode `0600`. They can contain sensitive caller data; do not upload them publicly. |

- **Exit status:** 0 only when every bundle passed. A failed verdict is a JUnit `failure`; an
  invalid bundle (or one the CLI cannot judge) is a JUnit `error`. No bundles at all, a missing
  path, an unsupported runner platform or a checksum mismatch stops the step.
- **JUnit carries identities and verdicts only** (`descriptor.id@version` per bundle), never
  report contents.
- **Runners:** Linux and macOS (x64, arm64) and Windows x64, matching the release assets. Node
  22+ must be on the runner (it is on GitHub-hosted runners).
- **Pin the action by commit** like any third-party action; `version` pins the CLI separately.

The entrypoint is `evaluate.mjs` (Node builtins only). It is qualified in this repository by
`scripts/test-evaluate-action.test.mjs`: a stub CLI everywhere, and the real compiled CLI in CI.
