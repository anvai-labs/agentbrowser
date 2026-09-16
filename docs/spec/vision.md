# Product vision and boundaries

Status: proposed evolution from the delivered browser service.

## Customer outcome

Explore a web workflow with an agent or a person, turn it into a repeatable verified
operation, and retain enough evidence to explain failures. The same shared control
contract supports browser UI, typed application operations and future agent-native
application tools. Reliability is measured against application state and explicit
UI assertions, not the model's account of its actions.

The initial buyer is a solo developer, small software team or agency shipping web
applications with coding agents. Their recurring job is checking whether a change
broke a workflow and producing a reproducible regression. Secondary opportunities
are narrow recurring SaaS operations and application-security regression. Forms
and job applications remain demanding qualification workloads, not separate engines.

## Priority and value hypothesis

| Order | Product increment | Value to validate |
| --- | --- | --- |
| 1 | Deterministic regression from an explored UI flow | Fewer escaped bugs and less manual verification per change |
| 2 | Reliable workflow mappings and receipts | Less repair work for one recurring business process |
| 3 | Agency audit adapters | Repeatable visual/accessibility/performance reports |
| 4 | Appsec identity and business-logic regressions | A fixed authorization bug stays fixed |
| 5 | Bounty report assistance | Less time reproducing and documenting a scoped finding |

These are product judgments, not measured TAM estimates. Validate willingness to
pay and retained usage before adding a hosted dashboard, scheduler or enterprise
integration. Track support hours per active workflow as well as subscriptions.

## Differentiation and competitive response

Simple semantic browser control is a baseline capability. Playwright already offers
an agent CLI, reusable skills and a session dashboard with human control. Use it as
a compatible backend and a comparison baseline; do not rebuild its test framework
just to own another runner. [Playwright coding agents](https://playwright.dev/docs/getting-started-cli)

The differentiating hypothesis is a small, verifiable execution contract across
interfaces: revocable authority, scoped resolution, uncertain-write reconciliation,
portable evidence, and deterministic regressions. Prove each against alternatives
on the same fixtures with measured correctness, cost and human repair effort.

## Explicit non-goals

- A general agent planner, another model SDK, or a replacement for Victor/Codex/Claude.
- A new browser renderer or maintained browser fork without measured necessity.
- A scanner payload library, CAPTCHA bypass product, or universal website support.
- Distributed active-active orchestration before single-owner recovery is qualified.
- Automatic repair that silently changes a test's expected outcome or tested seam.
- Separate product stacks or packages for resumes, QA, business operations and bounty.

## Success measures

Measure verified task completion, false passes on negative controls, ambiguity
refusals, escaped writes after revocation, recovery correctness, retained bytes,
tool-schema bytes/tokens, harness RSS, startup latency and operator repair time.
Record browser/process cost separately from bridge and service cost. Report p50/p95
with corpus, sample count, executable identities and confidence limitations.

The first acceptance workload is a fixture-backed UI regression with an intentional
bug that fails consistently, passes after its fix, and exports reusable evidence.
The existing live form target of less than four minutes and zero per-field agent
round trips remains an unqualified acceptance target, dependent on actual widgets.

## Specification ownership

One implementation owner maintains each shared contract; each mode owner adds only
its policy, data and acceptance cases. A new mode must identify paying/user demand,
existing primitives reused, incremental memory/dependencies, and a removal path.
Features have statuses: proposed, implemented, qualified (named surface/backend),
released (artifact identity). These are separate facts, never one generic checkmark.
