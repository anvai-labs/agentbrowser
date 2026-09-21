# Application-owned test using the installed CLI

This reference recipe runs a fresh counter application through the installed
`agentbrowser` CLI and a separately managed service. Node owns setup, the session,
the UI outcome call, the independent application check and session cleanup. The CLI
owns the canonical `outcome` and offline `test evaluate` contracts. No MCP connection,
workspace imports, extra package or model call is needed.

This is a concrete example for the repository's controlled counter deployment. It is
not a general website runner. A stock service does not register `fixture-counter` or
`fixture.ui-commit`; it must reject this recipe. Application owners adapt the fixed
setup and oracle code to their own registered adapter/verifier. See the
[design and trust boundary](../../docs/spec/design/t3-application-recipe.md) and the
[private report-link design](../../docs/spec/design/t3-report-artifacts.md), delivered
by PR #229. The [live JUnit design](../../docs/spec/design/t3-live-junit.md) describes
the same three invocations delivered by PR #230.

## Requirements

- Node 22 or newer and a CLI build that advertises `test evaluate`.
  Published v1.9.0 predates that command; use a qualified develop candidate.
- Local copies of both `application-outcome.mjs` and `report-artifacts.mjs` in the
  same directory. The recipe intentionally has no package or workspace import.
- A preconfigured, authenticated AgentBrowser service exposing the fixed counter
  adapter and UI receipt verifier. The owner keeps this service alive for the test.
- One exclusive fresh counter resource with `/state` initially
  `{"version":0,"total":0}`. Its owner manages its lifetime and cleanup.
- The service operator credential in `AGENTBROWSER_RECIPE_OPERATOR_KEY`. This belongs
  to the trusted Node test. Only the scoped QA grant reaches the CLI child; offline
  CLI discovery and evaluation receive no API key.

## Run one case

Create a private directory and a mode-0600 JSON configuration file. Substitute actual
CLI/service/application locations and the fixture identity observed by the deployment
owner. The expected version is a separate test pin, not proof of the observed build.

```json
{
  "caseName": "pass",
  "serviceBaseUrl": "http://127.0.0.1:5709",
  "cli": ["/absolute/path/to/agentbrowser"],
  "expectedVersion": "1.9.0",
  "application": {
    "adapter": "fixture-counter",
    "resource": "recipe-pass",
    "url": "http://127.0.0.1:5800",
    "fixture": { "id": "fixture-counter", "version": "1" },
    "verifier": { "id": "fixture.ui-commit", "version": "1" }
  },
  "reportPath": "/absolute/private/directory/evaluation.json"
}
```

With the operator key already in the environment, run:

```sh
node examples/node-test/application-outcome.mjs /absolute/private/directory/config.json
```

When moving the recipe outside this checkout, copy both modules and keep them together:

```sh
cp examples/node-test/application-outcome.mjs examples/node-test/report-artifacts.mjs /private/recipe/
node /private/recipe/application-outcome.mjs /absolute/private/directory/config.json
```

The current T3 closure candidate exercises this exact two-file copy from a private
temporary source directory and an unrelated working directory. It reuses the existing
three live cases and preconfigured service, so it adds no browser case or host start.
This qualifies absence of workspace imports and current-working-directory assumptions;
it does not configure an arbitrary application's adapter, verifier or fixture.

The direct Node entry emits native test results. Exit zero requires a passed canonical
case **and** an independently observed application commit. It writes the private
evaluation at `reportPath` and a sibling `<reportPath>.manifest.json` only after the
recipe lifecycle settles. Both names must be unused and their parent directory must be
private and exclusively owned by the caller.

The manifest records a relative encoded evaluation filename, JSON media type, exact
byte length, SHA-256 and the separately observed `oracleMatches` boolean. Node diagnostics
print only the fixed label and digest, never the local path. `readRecipeArtifacts`
reads the two owner-derived paths and verifies their bounded bytes and metadata. It
does not prove authenticity, freshness or who produced them; anyone able to replace
both files can replace both values. The independent oracle and Node exit remain
separate requirements, so neither a digest nor the evaluation file alone proves the
application outcome.

### Native JUnit output

Node's native reporter is an opt-in for the same application-owned test. Redirect it
to a mode-0600 file in a private directory and capture the process status directly:

```sh
umask 077
private_junit=$(mktemp /absolute/private/directory/application-outcome.XXXXXX) || exit 1
recipe_status=0
node --test-reporter=junit examples/node-test/application-outcome.mjs \
  /absolute/private/directory/config.json >"$private_junit" || recipe_status=$?
test "$recipe_status" -eq 0
```

Do not pipe this command through another program without separately preserving the Node
exit status. The `broken` and `cleanup-failure` controls intentionally return 1, so their
caller must require that exact failure together with the canonical evaluation and oracle
checks rather than applying the final `test` above. The native testcase name is bound to
`pass`, `broken` or `cleanup-failure`; the current package candidate qualifies those same
three live cases without starting another host or browser case.

Treat the raw XML as private. Node can include runner paths and host metadata. Its fixed
digest diagnostic links to the sibling manifest and evaluation bytes, but the comment,
manifest and digest do not authenticate the producer or prove freshness. Preserve the
Node exit, canonical evaluation and independent oracle result as separate requirements.

The two fault controls use their own fresh deployment resources:

| `caseName` | Resource | Deployment behavior | Expected Node exit |
| --- | --- | --- | --- |
| `pass` | `recipe-pass` | One UI commit, version 1 and total 2 | 0 |
| `broken` | `recipe-broken` | Ignore the click; state remains unchanged | 1 |
| `cleanup-failure` | `recipe-cleanup-failure` | Commit once; recipe injects primary cleanup failure and performs real fallback deletion | 1 |

These negative cases deliberately fail conventional tests. The repository's package
qualification checks their exact reports and independent fixture oracles; an arbitrary
exit 1 is never enough. Fallback deletion does not erase the original cleanup failure.
Failed fallback prevents evaluation/report publication entirely.

## Ownership and limits

Calls and private input/output have fixed limits. Handled termination aborts HTTP and
terminates the active CLI, escalating if needed and waiting for it to close. A hard
kill, uncertain session creation or service failure still needs external reclamation;
this example does not implement durable recovery. No uncertain UI write is retried.
The deployment owner closes the application fixture and service even when the test
fails. Fixture identity is an owner observation, not remote attestation. A handled
abort after publication removes only files created by that invocation; hard-kill and
hostile parent-directory recovery remain outside this example.

The existing package gate exercises all three cases against the same composed service
used by its 13-case matrix. Live JUnit changes their reporter, not their process owner,
and adds no browser matrix or CI job. The package parent
validates the artifact pair, the independent fixture oracle and session cleanup, then
removes both private files. HTML export, a general public artifact API and arbitrary
application provisioning remain separate work.

The closure candidate records one local sample of the three-case elapsed time and the
largest config, evaluation, manifest and JUnit byte counts. Its Node-test and CLI call
counts describe fixed, validated recipe paths; they are not process telemetry and do
not include browser descendants or executable internals. The matrix invokes no model
or MCP, so schema/config byte counts are not model context. One sample is a bounded
baseline, not latency percentiles or evidence of a speedup. Default qualification uses
Node 24.21.0; Node 22 remains the supported floor and requires its focused compatibility
check before this candidate can claim closure. No candidate measurement or compatibility
result is asserted here before that evidence exists.
