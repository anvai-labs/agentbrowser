# Code-grounded findings

Inspected develop `9b80675` and unchanged relevant sources in the isolated T3 worktree.
These observations are independent of paper rankings. “Static” means source inspection,
not a reproduced exploit or completed browser regression. The table records that
historical baseline. Q0 is now implemented as a separate candidate with
[failing-first and actual-surface evidence](../../spec/evidence/t6-widget-commitment.md);
the other findings remain open.

| Priority | Observed owner / finding | Evidence level | Smallest next proof |
| --- | --- | --- | --- |
| P0 | `packages/api/src/autofill.test.ts:237–412`: four widget tests are nested inside an async test | Reproduced: 15 `it` declarations; Vitest executes 11. Root and independent reviewer agree. | Correct registration and run unchanged expectations before fixing code. |
| P0 | `packages/api/src/autofill.ts:366–370,421`: immediate verification accepts committed evidence or native value; final verification accepts only native value | Static confirmed. Empty native value can downgrade a valid selection; query text can count as selection without commitment. | Strategy-owned predicate shared by both passes; prove query-only failure and committed-selection success. |
| P0 | `packages/control/src/application-authority.ts:108–117,129–143,192–200`: synchronous boolean `authorize` is used through truthiness without runtime async rejection | Static confirmed. An incorrectly supplied Promise/thenable is truthy. This is trusted deployment callback misconfiguration, not a demonstrated remote exploit. | Async-false, rejecting Promise, thenable and nonboolean returns must fail closed before bind/dispatch; reuse `trusted-callback.ts`. |
| P1 | `packages/api/src/service.ts:2183–2256` matches diff identity by engine ref, but Playwright rewrites refs with revision prefixes at `engine-playwright/src/index.ts:1554–1568` | Static mismatch; no real-browser diff failure reproduced yet. Existing modified-diff test uses a fake engine. | Mutate one input in real Chromium; require one modified element without unrelated remove/add churn. Preserve stale-action rejection while separating observation identity from action refs. |
| P1 | `packages/api/src/autofill.ts:85–145`: custom widget strategies use fixed waits and a single option observation; `maxReobserve` does not poll option readiness | Static confirmed; named widget strategies exist, general async widget support does not follow. | Option arrives on the last allowed read; bounded polling, one committed click, no replay. |
| P1 | `engine-playwright/src/index.ts:155–160`: committed capture uses React Select's single-value markup; no general chip-membership set contract | Static confirmed. Existing real-Chromium bulk fixture exercises native text/select and repeated fieldsets, not custom widgets. | Real chip fixture: query/menu text is not membership; selected set, removal and partial effects must be independently observed. |
| P1 | `packages/api/src/service.ts:2080–2089,3281–3357`: visual/compact-DOM modes are rejected; screenshot artifacts are separate and masking is warning-only | Static confirmed; do not advertise masking or atomic DOM/pixel evidence. | Test explicit unsupported behavior, provenance under mutation, redaction boundary and output budgets before richer observation claims. |
| P2 | `engine-playwright/src/index.ts:2551–2567`: requested JPEG/WebP quality is not forwarded | Static confirmed; output cost control is not yet proven. | Pin forwarding at the engine boundary and check a real requested capture format. |
| P1 | `core/session-control.ts`, `control/session-authority.ts`, API ledgers: recovery state is bounded and in-memory; crash cleanup is not restoration | Existing documented limitation, not a newly discovered regression. | T5 design must add an awaited durable intent/dispatch boundary before effects; crash-inject every transition. |

The runtime callback repair should also validate registered operation names/modes
against existing protocol constraints at construction. Registration currently checks
the adapter ID but can expose malformed operation descriptors from trusted configuration.
Reject invalid configuration centrally; do not sanitize it differently in CLI and REST.

The observation repair must preserve a crucial distinction: action refs should become
stale when required, while stable document-scoped node identity may support diffing.
Do not make old action refs valid merely to reduce diff bytes. Existing engine-private
node identity and shared revision/budget owners are the reuse candidates.

## Reproduction recorded

Command executed against unchanged autofill source in the dependency-installed T3 worktree:

```sh
pnpm --filter @agentbrowser/api exec vitest run src/autofill.test.ts
```

Observed: one file passed, **11 tests passed**, Vitest 2.1.9. There are 15 static test
declarations. The four nested tests begin around lines 267, 320, 347 and 391. This is
evidence of missing registration, not proof that the widget behavior passes. No raw
profile, account, credential or application data was involved.

## Existing strengths to preserve

Bulk resolution pins nearest-fieldset and node identities; it rejects ambiguous or
degraded evidence and does not replay writes on failed verification. ApplicationAuthority
owns operation identity, canonical input and scoped receipts. SessionAuthority owns
grant revocation, admission and drain. The outcome runner distinguishes command completion
from verified business state. The eight-revision history, observation budgets and artifact
TTL/size owner already exist. Extend these owners rather than adding competing machinery.

Broader gaps remain intentional: arbitrary repeated cards are not qualified block scopes,
production evidence is deployment-owned, no general binding UX ships, recovery is not
durable, and Firefox/Safari capabilities differ. The review proposes qualification work;
it does not convert protocol enum values or comments into delivered features.
