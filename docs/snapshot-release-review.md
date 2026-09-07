# Snapshot release review — PR 95

Reviewed head: `474525a63163dc12eb341437d1c6136eb4821843`.
[PR 95](https://github.com/anvai-labs/agentbrowser/pull/95) has all eight
[CI checks green](https://github.com/anvai-labs/agentbrowser/actions/runs/34148395862).
Initial review: **changes required** despite green CI. A concurrent delivery
merged that head at `9eeb624` before corrections were delivered. The focused
`fix/snapshot-evidence-safety` follow-up is based on develop `b754262`, preserving
the subsequent page-listing and idle-timeout changes. Its implementation has
independent review approval and local regression evidence below; fresh PR and
post-merge CI remain required. Keep [M1](release-milestones.md) gated on this fix.

Locations below refer to the reviewed commit, not the changing shared checkout.

| ID | Finding / location | Severity / why it matters | Concrete fix and acceptance | Status |
| --- | --- | --- | --- | --- |
| S1-R1 | `engine-playwright/src/index.ts:1238–1242`: failed fresh snapshot is replaced with the stored snapshot | High: failure to validate semantic state becomes successful validation; this also affects elements whose original snapshot succeeded, and suppresses unrelated errors | Never substitute old evidence for failed live validation. Preserve typed failures outside a deliberately supported timeout case. For timed-out observations, represent unavailable evidence explicitly; action execution must either validate an independently sufficient live semantic state or fail with a recoverable typed error. Add stable-then-failed, degraded-then-mutated and unrelated-error controls before implementing the fix | Implemented and independently reviewed; fresh CI pending |
| S1-R2 | `engine-playwright/src/index.ts:159–166,191–192`: permissive environment parsing and unvalidated explicit option | Medium: `parseInt` accepts malformed prefixes; explicit `0`, nonfinite or invalid values pass through to the browser API, defeating the intended positive bounded deadline contract | Share a finite positive safe-integer validator for both inputs; define an upper bound and an explicit invalid-configuration policy. Test zero, negative, fractional, nonfinite, oversized and trailing-text values, plus valid overrides | Implemented and independently reviewed; fresh CI pending |
| S1-R3 | `engine-playwright/src/target-identity.test.ts`: degradation is induced by assuming a 1 ms timeout always fails | Medium: wall-clock assumptions make the regression host-dependent; the existing mutation tests do not exercise degraded semantic evidence | Keep a real Chromium control, but inject timeout/error outcomes at a narrow snapshot boundary deterministically. Cover observation success without revision churn, stable-to-failed and degraded-to-stable transitions, same-node semantic mutation, replacement/reorder and unrelated failures | Implemented and independently reviewed; fresh CI pending |

## Reproduction evidence and limitations

Additional S1-R4 (medium): recovering every element timeout sequentially added
approximately N times the configured wait. The shared snapshot budget and
deterministic body/element budget-exhaustion controls close this gap locally;
fresh CI remains pending with the other corrections.

The main review extracted the exact `resolve()` method from the PR head and its
parent with `git show`, stripped TypeScript in memory, and executed it against
the same mocked live node/locator. The stored snapshot was present; the fresh
snapshot threw an injected transport error. The parent rejected that error;
the PR head returned a resolved target using the stored fingerprint. No source
or build files were changed. This is a method-level differential reproduction,
not a claim that a complete browser exploit was executed.

DOM identity is necessary but does not by itself prove unchanged semantics:
the same node can change checked state or destination without changing its
role/name. Do not fix observation availability by silently weakening the action
validation contract. A bounded fallback needs explicit evidence and mutation
tests; a broad exception handler is not such evidence.

## Delivery boundary

Corrections are one follow-up PR, not mixed into release automation. An approved
temporary worktree isolates this work from the other task's shared checkout;
remove it after delivery. No existing work was overwritten or stashed. No
release, Homebrew change, managed-service restart or containment rollout is
part of this unit.

## Correction and validation record

- `snapshot-evidence.ts` owns bounded configuration, timeout-only recovery,
  snapshot hashing and evidence comparison. Digests are fixed-size; whole-page
  YAML is not retained per binding. Element evidence is never silently replaced
  by document evidence during action validation.
- Observations may fall back to successful whole-document accessibility evidence.
  Actions must revalidate the same document digest and node identity; unrelated
  document changes can conservatively stale these refs. No available semantic
  evidence means a recoverable `STALE_TARGET`, never an identity-only action.
- One monotonic budget covers snapshot waiting across body and elements. It
  does not bound locator resolution, visibility checks or title/content work.
  Exhausted budgets skip capture rather than passing Playwright's unlimited zero.
- Eighteen of the initial twenty-five tests failed against the original PR code.
  Real Chromium demonstrated same-node checked/pressed/destination mutations and
  failed live captures proceeding to actions before the correction. All initial
  tests pass after correction. The final focused suite has 35 passing tests,
  including evidence transitions, failed rebuild cleanup, duplicate targets and
  replacement/removal/reorder/rename with and without fallback.
- Independent code re-review approved the correction with no blocking findings.
  Workspace build passes. Local Obscura integration reported eight skips because
  its binary is unavailable in this worktree; this is not real-Obscura proof.
  Full hooks and fresh CI are the remaining delivery gates.
