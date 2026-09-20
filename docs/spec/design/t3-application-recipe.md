# T3: application-owned installed-CLI recipe

Status: implemented and locally qualified from develop `0762554` (PR #226).
Load only for this slice. T3 remains active.

## Decision

Provide one concrete counter-application Node test example, built from Node built-ins
and the installed CLI. The application owner supplies a preconfigured AgentBrowser
service and an exclusive, fresh application resource. The example owns its session,
application binding, QA grant, CLI calls and session cleanup. It does not start or
stop the service, application fixture or browser host. Those remain deployment-owned.
This is an executable reference recipe, not a new runner, plugin contract or scheduler.

The canonical outcome and TestCase evaluator remain behind `outcome` and `test evaluate`.
No protocol package import, dependency installation, MCP connection or verdict copy is
needed in the example. Applications adapt its concrete preparation/oracle code as local
test support. Stock deployments without the registered adapter/verifier fail closed.

## Inputs and trust

The trusted application owner supplies a private bounded JSON file containing CLI
executable/entry paths, service origin, expected product version, application resource
and origin, observed fixture identity, verifier identity and a private output path.
This is example configuration, not a public product schema or model-authored task.
The operator key enters only the trusted Node test environment. A shared CLI environment
allowlist forwards runtime essentials and the explicit QA token, never the operator key,
proxy settings or Node injection variables. Offline evaluation receives no token.

Fixture identity is the deployment owner's observation (the existing fixture host's
ready identity during qualification), not remote attestation. Product/CLI versions and
session engine are independently observed; expected descriptor pins remain separate.
Never source an observed product/engine version from an expected pin. Configured HTTP
origins are trusted; reject embedded credentials and redirects. Bound all bodies and
calls, and keep private values out of thrown diagnostics and JUnit output.

## Lifecycle and evidence

1. Discover installed command schemas and CLI version; observe service health/readiness,
   application baseline and deployment-supplied fixture identity. Reject drift.
2. Create/register the session immediately; bind the resource, reserve the application
   intent, navigate a page and resolve one enabled Add button from a fresh snapshot.
3. Obtain a QA grant through prepare-resume/delegate. Run the installed CLI outcome
   using a distinct outer operation ID and the reserved business correlation.
4. Read the independent application `/state` oracle. Reserved UI receipts remain hidden
   from the generic `/receipts` route; do not weaken that boundary for this example.
5. Close the session and confirm absence. On primary cleanup failure, retain
   `cleanup: failed`; attempt bounded operator fallback. Fallback failure prevents
   evaluation and publication. No blind retry of the UI action or uncertain write.
6. Evaluate the original bound bundle through the installed offline CLI, then let Node
   require both a passed canonical verdict and the independent oracle assertion.

A process timeout/signal is infrastructure failure, not a canonical failed report.
The serial example owns asynchronous, bounded direct CLI processes. On handled SIGTERM
or SIGINT, it aborts HTTP work, terminates the active CLI, escalates to SIGKILL after
200 ms if needed, and awaits close before failing without publishing evidence. It never
creates a service/browser subtree. Hard termination can still leave externally owned
resources; deployment reclamation and request reconciliation remain necessary. This is
not T5 crash recovery. Failed cleanup can never be repaired into a passing case by
fallback success.

The example's three named controls are concrete fixture cases, not a general injection
API: a successful commit, an ignored click, and an injected primary cleanup failure.
Every Node test requires success. Negative controls therefore exit 1 honestly. The outer
qualification recognizes only their exact expected report/oracle/cleanup identities;
an arbitrary exit 1 does not satisfy the gate.

## Reuse and qualification

Keep the existing 13-case matrix and its lifetime coordinator. Run three small recipe
cases against the same already-running composed host, using existing fixture/oracle/
close RPC solely in the trusted parent. No second browser-host startup or extra CI job.
The parent always closes fixtures; failure anywhere prevents package report publication.
Preserve the original 13-case counts; record the three recipe calls separately.

Share the counter assertion/descriptor builders and CLI environment allowlist from the
example with existing acceptance. Their identities are unchanged. Do not extract a
new package or generic callback framework; the standalone distribution boundary justifies
its small bounded Node CLI/HTTP adapters. The existing parent process supervisor remains
in use. The ordinary application owner supplies external service lifetime management.

## Failing-first gates

- Missing example is RED; its focused tests prove private environment isolation,
  malformed/empty nonzero output refusal, canonical exit-1 preservation, bounded input,
  timeout/signal/output overflow, and value-free diagnostics.
- Missing evaluator, version/engine/fixture drift and unconfigured application service
  fail setup. Setup failures settle resources whose identities were returned. A lost
  or malformed session-creation response requires external service reclamation; this
  recipe cannot reconcile an unknown session or delete other callers' sessions.
- Real compiled CLI: pass commits once; ignored action does not commit; cleanup failure
  retains passing assertion evidence and a failed case after fallback. Node exits must
  match exact canonical identities and independently observed oracle state.
- Primary and fallback cleanup failure cannot publish evaluation. Wrong oracle state
  cannot pass merely because an action or verifier reports success.
- Normal local hooks, one ready PR, exact-head adversarial review, required CI and verified
  develop merge/post-merge CI. No release or main promotion is implied.

## Remaining scope

This reference recipe demonstrates the fixed counter deployment, not arbitrary website
or production verifier configuration. Failure-linked artifact conventions, justified
HTML export and impact selection remain separate T3 steps. T7 and T3-dependent T8
qualification gates remain closed until their full prerequisites pass.
