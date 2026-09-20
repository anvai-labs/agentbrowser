# T3 application-owned CLI recipe qualification

Status: implemented and locally qualified from develop `0762554` (PR #226).
Design: [application-owned recipe](../design/t3-application-recipe.md).
Usage: [standalone Node example](../../../examples/node-test/README.md).

## Boundary being qualified

A Node test owns session setup, a fixed application binding, QA delegation, the
installed CLI outcome, an independent application-state read and session cleanup.
The deployment owner owns the service and fixture. The example imports only Node
built-ins; it shares its assertion, descriptor and CLI environment helpers with the
existing acceptance coordinator instead of introducing another protocol or package.

The same packaged host runs three fresh recipe cases after the existing 13-case
matrix settles its sessions and fixtures. Success commits once; ignored click fails
without a commit; failed primary cleanup retains passing assertion evidence but fails
the case after real fallback deletion. The parent checks the exact canonical reports,
independent fixture state and closed sessions. Neither an arbitrary child exit 1 nor
an evaluator verdict by itself is sufficient evidence.

## Failing-first record

The initial four tests failed before the example module existed. Later adversarial
review and focused falsifiers caught lost cancellation between spawn and listener
registration, empty-stdin EPIPE, endpoint origin changes caused by URL resolution, and
session cleanup registration after engine validation. Those paths now have regression
coverage. A real child-process test sends SIGTERM to the Node recipe while its CLI
ignores SIGTERM, verifies escalation/drain, and rejects report publication.

The local live run preserved all 13 existing cases and qualified the three additional
recipe cases with Node exits 0/1/1. Success and cleanup-failure committed exactly once;
broken left application state unchanged. All three sessions and bindings returned 404
after cleanup. This precommit run reused the prior clean extracted server because
production modules did not change; the final candidate is packaged again with its own
commit identity. Evaluator discovery measured 73,925 bytes, so only that call has a
128 KiB output ceiling; actual requests/reports keep their 64 KiB limit.

The final focused test counts, compiled-binary/extracted-package result, adversarial
head identity and PR/post-merge CI runs belong to the PR delivery record. No release
qualification is inferred from the shared `1.9.0` version string. Normal hooks and the
existing required checks remain mandatory; no extra CI job or browser matrix is added.

## Limits and next step

This is a controlled counter recipe, not arbitrary website provisioning, production
verifier configuration, public `test run`, a plugin loader or a scheduler. A stock
service without the registered adapter/verifier fails closed. Fixture identity comes
from the deployment owner and is not remote attestation. Unknown sessions after lost
create responses and hard process termination still require external reclamation;
this slice is not T5 durable recovery.

Failure-linked artifact conventions, any justified HTML adapter and local impact
selection remain. T3 stays active; T7 and T3-dependent T8 gates stay closed. Published
v1.9.0 does not include the offline evaluator or this recipe. Continue on develop;
main promotion and a release remain a separate checkpoint decision.
