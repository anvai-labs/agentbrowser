# T2 installed CLI application outcome

Status: controlled G4 qualification delivered to develop in PR #208. Exact-head and
merge-commit CI passed all eight jobs. Main promotion and release are outside this slice.

## Runtime boundary

The acceptance path invokes the compiled `agentbrowser` CLI in its own process, sends
the canonical outcome request through JSON stdin and checks its exact exit code and
JSON output. The CLI talks over HTTP to a separate local service process assembled from
the audited, extracted server candidate. That service uses the packaged API, control,
policy and Playwright engine modules and a real Chromium browser. The workspace testkit
supplies only the controlled versioned application fixture; it is not a server fallback
or production dependency. MCP is not started or imported.

This check is integrated into the existing extracted-candidate acceptance command and
therefore the existing package-acceptance CI job. It adds no job, runner, service,
package or execution path. The process helper bounds stdin and output, isolates the
working directory and environment, exposes nonzero JSON results for inspection, and
ties CLI cleanup to the existing managed-child lifecycle.

## Grounding contract

The `fixture-counter` adapter reserves a counter command before UI dispatch.
Application authority binds
the receipt reader to the admitted tenant, session incarnation, adapter and resource.
A synchronous permission policy additionally requires the exact delegated QA actor,
source/capability, verifier/version, bounded command input and distinct business
correlation ID. The source claims that reservation before browser dispatch; the only
qualifying receipt is an application-issued event from the exclusive UI actor for the
same scope and command. Evidence output contains a bounded
`fixture-ui-event-<UUID>` reference rather than the receipt body.

The acceptance runner inspects application state and the scoped receipt through a
separate fixture oracle after the CLI exits. It also records claim and evidence-read
counts. This independent observation falsifies accidental success in the CLI/result
projection and proves at-most-one controlled fixture effect. It does not make the
fixture a production oracle.

The qualified layer is G4 for this controlled, exclusive-UI-actor fixture. It
does not qualify G6, a production evidence source, durable receipt recovery or an
independently deployed application. The permission generation is fixture-local and
separate from application version/commit identity.

## Seven-case matrix

| Case | Falsified failure | Expected result and independent oracle |
| --- | --- | --- |
| `pass` | Happy-path projection can pass without the scoped commit. | Exit 0 and passing verification; exactly one reserved UI commit and matching event receipt. |
| `lost-response` | A lost browser response causes a second write or loses committed evidence. | Exit 0 and passing verification from the one receipt; exactly one backend effect. |
| `historical` | A matching pre-existing backend write is relabelled as this UI run. | Exit 1 before UI execution; historical state remains, with no qualifying UI receipt. |
| `ignored` | Browser acknowledgement is mistaken for application commit. | Exit 1 with completed UI execution and unknown verification; state and receipt remain absent. |
| `failed-action` | A failed browser action is repaired by evidence polling or redispatch. | Exit 1 without completed execution, commit or receipt. |
| `stale` | A competing write is attributed to the reserved UI command. | Exit 1 after UI execution; independent state contains only the other writer and no reserved UI receipt. |
| `wrong-resource` | A valid correlation crosses a changed resource binding. | Exit 1 before execution; neither resource gains an effect, claim or evidence read from the request. |

Each case then repeats the exact outer service operation ID. The CLI must return
`OPERATION_RECORDED`, while the independent oracle proves no additional dispatch,
application effect, source claim or evidence read. The outer admission ID remains
different from the application business correlation ID.

## Validation record and delivery

The actual seven-case run passed locally against an audited extracted dirty candidate
based on `03c2144`. It used the real compiled CLI as a separate process, JSON stdin, an
independent temporary working directory, the packaged service modules and real
Chromium. All seven first attempts produced their expected exit and outcome states; all
seven same-operation-ID replays returned recorded-without-dispatch and preserved the
oracle. No MCP binary or transport participated.

Supporting validation is also green: 13 local versioned-fixture tests, one
real-Chromium legacy parity test and 36 executable/package-helper tests, composed of 23
release-smoke tests and 13 package-acceptance tests. The full existing extracted-package
acceptance also passed all eight check groups, including this CLI matrix, with graceful
service and fixture cleanup. The first CI candidate exposed an empty-stdin pipe race
during packaging; a deterministic closed-reader regression reproduces it. Empty input
now sends EOF without a zero-byte write, while undelivered nonempty input still fails.

The dirty local candidate is not release evidence. The subsequent clean candidate
passed all eight jobs in [PR CI](https://github.com/anvai-labs/agentbrowser/actions/runs/35431407886)
and [merge CI](https://github.com/anvai-labs/agentbrowser/actions/runs/35433726360).
Reviewed head: `dfcc9d5bb6d6db4dd5b1a5300f066bfceeb52047`.
Develop merge: `944229096647e5047620a4afafa537b3d78dced6`.
Independent exact-head adversarial review is clean. No gate was skipped or weakened.
See [foundation qualification](t2-foundation-qualification.md) for T2 closure and limits.
