# T8: harness correlation, schema fidelity and footprint

Status: active source-level qualification; installed harness acceptance remains open.
Repositories: agentbrowser and ../codingagent, tracked separately.
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

## Source-level schema checkpoint

[Victor PR #1168](https://github.com/anvai-labs/victor/pull/1168) repairs the proven
schema loss in its existing MCP client/tool model/adapter. Capture preserves the
complete server contract; the adapter delegates to its existing full renderer
instead of flattening nested fields in compact/stub modes. Legacy tools keep
existing behavior. No AgentBrowser runtime, dependency or default catalog changes.

Failing-first tests covered nested arrays/unions/enums/references, detached mutable
state, invalid schema-root refusal and legacy compatibility. Independent review also
found boolean/union assumptions in the existing exporter and argument coercion;
both have regression coverage. A real built AgentBrowser catalog now matches every
model-facing adapter schema level, and bound execution/takeover acceptance passes.

This source evidence does not qualify installed Victor 0.9.3, a live model loop,
provider-final schema conversion or a modern Victor server relay. Full schema
preservation costs more than lossy stubs; reduce selected tools through existing
mode/profile controls, not by discarding constraints. CLI remains first-class and
MCP optional. Details and commands are owned by
[Victor's schema fidelity record](https://github.com/anvai-labs/victor/blob/95612eddc52ac264edd91d61f97b109ad8af0bc0/docs/architecture/mcp-schema-fidelity.md).

A later adversarial audit withdrew the initial source verdict before merge:
preserved references could trigger external retrieval and permissive fallback.
The repair uses the existing JSON Schema library with offline reference resolution,
recognized dialect validation and static refusal. The executor preserves captured
arguments, requires validation and refuses the reserved context field instead of
silently stripping it. Regression coverage includes direct dispatch and all executor
validation modes. Provider/ToolPipeline transformations before the executor remain
an explicit installed-harness acceptance gate.

Next qualify a released installed harness and the provider's actual tool-call
path, then the remaining correlation/reconnect/cancellation and footprint gates.
Retain explicit limits until those named acceptance runs exist; no whole-milestone
completion or release is implied by this source repair.
