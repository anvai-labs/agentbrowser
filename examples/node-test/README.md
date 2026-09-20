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
[design and trust boundary](../../docs/spec/design/t3-application-recipe.md).

## Requirements

- Node 22 or newer and a CLI build that advertises `test evaluate`.
  Published v1.9.0 predates that command; use a qualified develop candidate.
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

The direct Node entry emits native test results. Exit zero requires a passed canonical
case **and** an independently observed application commit. The private evaluation file
preserves the canonical verdict; never treat the file alone as proof that the Node
oracle assertion passed. The output path must not exist beforehand.

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
fails. Fixture identity is an owner observation, not remote attestation.

The existing package gate exercises all three cases against the same composed service
used by its 13-case matrix. This adds no browser matrix or CI job. HTML export, general
artifact-link conventions and arbitrary application provisioning remain separate work.
