# T2 outcome and verifier foundation

Status: active implementation evidence for the sixth T2 slice. No public TestCase
runner, application oracle, polling loop or cleanup coordinator is delivered here.

## Defect and ownership

Existing plan, autofill and application results express different combinations of
command completion and observation. None is a safe canonical input for a future QA
pass: a completed command, `verify: none`, or application acknowledgement could be
mistaken for an independently verified outcome, while cleanup failure had no separate
axis.

The protocol now owns a strict internal `OutcomeProjection` with independent
availability, execution, verification, cleanup and tested-seam fields. Verification
contains only a registered verifier identity, required and achieved grounding layers,
and bounded opaque evidence-reference IDs. It carries no expected value, observed
value or caller-supplied aggregate pass flag. `isPassingOutcome` derives a pass only
for available capability, completed execution, passed verification at or above the
required layer, and cleanup `complete` or `not_needed`.

The existing descriptor-only JSON snapshot helper is reused before schema and semantic
validation. Accessors, exotic prototypes, symbols, cycles, unknown fields and later
producer mutation cannot change the accepted projection. Shared object aliases remain
compatible. New outcome, descriptor and verifier-evidence boundaries invoke the shared
snapshot with caps of 16 levels, 4096 values and 65,536 UTF-8 bytes, and reject an
oversized dense array before cloning its elements. Existing plan/autofill report
parsers retain their prior shape compatibility.

Control owns an immutable trusted verifier registry. Trusted composition registers
bounded descriptor data and local parser/predicate functions. Runtime callers can
select an exact ID/version and supply already acquired evidence; they cannot register
scripts. Evaluation invokes one predicate once and returns only the canonical
reference-only verification projection. Parser or predicate exceptions, invalid
return types and cancellation before or during evaluation become `unknown`. The
registry performs no authorization, evidence acquisition, polling, write retry,
dispatch, artifact storage or cleanup.

## TDD and validation

Tests reject false passes for unavailable capability, incomplete or unknown execution,
missing/failed/unknown verification, insufficient grounding and failed/pending/unknown
cleanup. They also cover private sibling fields, inherited/accessor/cyclic data,
mutation after parsing, caller-supplied pass flags, descriptor mutation, duplicates,
executable descriptor fields, unknown verifier versions, excessive or duplicate
evidence references, thrown predicates, cancellation and non-boolean predicate output.
A raw registered evaluator receives the same stable bounded snapshot as a verifier
created by the helper. A counter equality negative control proves unequal evidence
fails.

Validation on 2026-09-17:

```sh
pnpm --filter @agentbrowser/protocol test
# 7 files; 166 tests passed

pnpm --filter @agentbrowser/control test
# 4 files; 49 tests passed

pnpm --filter @agentbrowser/protocol type-check
pnpm --filter @agentbrowser/control type-check
# passed
```

This is an additive internal contract with no REST, OpenAPI, SDK, CLI, MCP catalog,
existing schema ID or dependency change. It does not itself qualify G6 or unlock T3.
The next vertical slice must acquire evidence under current authority, perform bounded
read polling, settle every cleanup independently and expose a report through a
delivered surface without adding another executor.
