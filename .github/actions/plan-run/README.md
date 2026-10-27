# `plan-run` action

Runs a saved AgentBrowser plan file against an **already-running** AgentBrowser service (start
your service in an earlier step; this action starts no browser and no server), with a pinned,
checksum-verified release CLI. The session is created, the start URL opened, the plan run and the
session closed. A JUnit report lands at `junit` (one testcase per step: pass, error code, or
skipped; page text never enters it).

```yaml
- uses: anvai-labs/agentbrowser/.github/actions/plan-run@v1.27.4
  with:
    cli-version: v1.27.4
    base-url: http://127.0.0.1:5709
    tenant: ci
    plan: plan.json
    start-url: https://app.test/login
    api-key: ${{ secrets.AGENTBROWSER_API_KEY }}
```

The action exits with the plan's verdict: 0 only when every step completed. `scope-file`,
`keep-session` and `timeout-ms` are optional (see `action.yml`).
