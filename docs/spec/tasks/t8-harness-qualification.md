# T8: harness correlation, schema fidelity and footprint

Status: not started. Repositories: agentbrowser and ../codingagent, tracked separately.
Depends on: T0; profile/run slices additionally require T1/T3.
Inputs: core, interfaces, state-memory, quality-ci, review.

## Reuse and scope

Inspect the current Victor MCP client/registry/projector before assuming old findings
remain. Repair or replace behind the existing interface with one response dispatcher.
Evaluate the official MCP client lifecycle against maintaining custom transport; do
not add another bridge tool, connection pool or alternate schema translation path.
AgentBrowser remains independent of Victor/model SDKs.

## Slices

1. T0 prerequisite only: correlation, bounded pending calls, notifications, timeouts,
   cancellation and retirement. Fix hazards before overlapping calls are enabled.
2. Schema/result fidelity through actual installed Victor, Codex/Claude or CLI paths,
   preserving nested arrays/unions/enums and typed evidence. Record availability honestly.
3. T1/T3 dependent: profile selection, inline accessible decisions, reconnect/recovery
   and comparative context/dependency/startup/RSS qualification.

## TDD and acceptance

Out-of-order replies never satisfy another request. Late responses after timeout cannot
cross generations. Bridge death during a write yields uncertainty/status recovery and
never a replay. Nested autofill schemas arrive intact at the model-facing adapter.
Image/HTML references retain privacy and do not silently become fabricated evidence.

Use two actual bridge processes and one service, then a replacement bridge; qualify
pages, takeover and cleanup. Compare isolated imports/install sizes and RSS separately
from prompt bytes/tokens. Application-only execution needs no browser or model SDK.

## Completion / stop

Close R05/R11 and harness portions of R12/R16 with named installed versions. Each repo
has its own tests, PR, CI and release evidence; one merge does not release the other.
Unsupported client/profile behavior remains explicit; no protocol-version-only upgrade.
