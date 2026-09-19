# T2: shared execution, verification and result helpers

Status: complete; AgentBrowser 1.9.0 includes this foundation. Repository: agentbrowser. Depends on: T0.
Inputs: core, architecture, contracts, execution, grounding.

## Reuse and scope

Start in SessionControl, SessionAuthority, ApplicationAuthority, existing action
executor, autofill orchestrator, budget and artifact helpers. Preserve their existing
ownership and wire outcomes. Add one shared result/verifier contract and extract only
demonstrably duplicated sequencing. Do not merge plan/autofill identity semantics.

## Slices

1. Separate execution, verification and cleanup outcomes through compatible projections.
2. Reuse bounded evidence, canonical serialization and operation admission across run
   consumers. Specify any missing shared helper's owner and exact responsibility.
3. Add trusted verifier registration and independent outcome references. Ensure reads,
   final rechecks and uncertainty all obey the same authority/deadline boundaries.

## TDD and acceptance

Test takeover at every boundary, same-ID/different-input conflict, late completion,
changed document/binding, truncated candidates, redaction collision, cross-field resets,
after-commit disconnect and terminal evidence failure. Unknown writes stop the suffix;
read retries never dispatch another write. Pending calls drain before ownership release.

An application rejection and a UI command acknowledgment produce distinct results.
Existing API/SDK/CLI/MCP actions and native autofill remain compatible. No duplicate
state machine, ad hoc retry loop, private-value cache or artifact store is introduced.
Run existing control/authority/autofill suites plus one actual service/stdio fixture.

## Completion / stop

Close R02 execution aspects, R04 foundation and R12 shared helper ownership. Record
unsupported evidence levels rather than inventing commits. Unlock T3/T4/T5/T6.

## Current implementation state

The common foundations below are implemented. Detailed qualification lives in the linked
evidence modules; load those only for the boundary being changed.

| Foundation | Qualified behavior and evidence |
| --- | --- |
| Dispatch and completion | Autofill uses `ActionExecutor.beforeAction`: refusal before dispatch is failed; engine failure afterward is uncertain. One HTTP envelope classifier projects autofill, plan and action completion into `SessionAuthority`, without retrying writes. [Dispatch](../evidence/t2-dispatch-boundary.md), [HTTP classification](../evidence/t2-http-result-classification.md). |
| Application identity | Authority-owned session incarnation separates receipt/write identity across registrations, survives same-registration rebind, and changes on textual ID reuse. Binding generation stays admission provenance. [Identity](../evidence/t2-application-identity.md). |
| Conservative result parsing | Aggregate success requires coherent nested results and request cardinality across SDK, CLI and MCP. Explicit native fill verification retains only value-free G5 readback; this is not commit proof. [Semantic results](../evidence/t2-semantic-result-validation.md), [plan verification](../evidence/t2-plan-verification-evidence.md). |
| Shared outcome runner | Separate availability, execution, verification, cleanup and tested-seam axes; one existing executor; bounded read-only polling; all-settled cleanup; terminal authority recheck. REST, SDK and first-class CLI share the contract; MCP is optional. Verifier input is prepared once before dispatch; legacy definitions without preparation are unsupported. [Verifier foundation](../evidence/t2-outcome-verifier-foundation.md), [vertical slice](../evidence/t2-outcome-run-vertical.md). |
| Receipt preflight | Standalone and admitted receipt lookup share one prepared reader. Frozen admitted actor/tenant/mode comes from the validated grant. Owner, binding, adapter authorization and cancellation are checked around I/O; observed failure cannot revive the reader. No nested ticket or write dispatch. [Preflight](../evidence/t2-application-identity.md#receipt-preflight-and-admitted-identity). |
| Receipt drain | Bounded response completion closes scope authority immediately; explicitly tracked pending receipt I/O retains the busy ticket until settlement. HTTP tests prove in-flight replay, blocked overlap, late-output withholding, takeover and safe replacement ownership. Generic source/cleanup/engine work is not automatically tracked. [Drain](../evidence/t2-application-identity.md#receipt-timeout-and-admission-drain). |
| Business correlation | A bounded receipt ID is separate from the outer service operation ID. Opted-in sources require it and other sources reject it before dispatch. Operator REST fixtures cover scoped reads, replay and conflicts, using public application binding/execution. These fixtures establish correlation only. [Correlation](../evidence/t2-outcome-run-vertical.md#business-receipt-correlation-follow-up). |
| Generic evidence permission | Opted-in sources authorize an exact verifier/version and frozen bounded raw input, with a generation fence through execution, reads, evaluation and cleanup. The runner captures host references before policy callbacks; observed revocation cannot revive. Delegated HTTP fixtures qualify this generic gate. [Permission](../evidence/t2-evidence-permission.md). |

Application permission composition uses the same generic gate with a private per-read
receipt capability, authority-owned identity and a narrow service registry provider.
See [application permission](../evidence/t2-application-evidence-permission.md).

The controlled qualification uses a compiled CLI, independently extracted service and
real Chromium, with seven cases and seven reconciled replays against an application
oracle. PR #208 and its exact develop merge passed all eight CI jobs. See
[installed CLI application outcome](../evidence/t2-cli-application-outcome.md).

AgentBrowser 1.9.0 includes the merged foundation through PR #208. The linked evidence
preserves the exact develop-slice identities and does not by itself claim publication.

## Completion record and remaining limits

The [foundation qualification](../evidence/t2-foundation-qualification.md) maps the
complete acceptance matrix to regression tests and records exact delivery identities.
Independent adversarial audits close R02 execution, R04 foundation and R12 shared
ownership. T3/T4/T5/T6 are dependency-ready; their own acceptance remains required.

The controlled exclusive-UI-actor contract qualifies G4 only. No production evidence
source or G6 independence is qualified. Raw application route permissions have not
expanded. Production UI/API parity and evidence qualification remain T4; persisted
incarnation/receipt recovery remains T5. CLI stays first-class and MCP optional.
