# Engineering review remediation

Reviewed baseline: `v1.7.0..0e3bc3b` (2026-09-05). This tracker supplements,
rather than rewrites, the closed historical audits. Findings include inherited
defects exposed by the changed paths. H = safety/substantial correctness;
M = actionable correctness or engineering debt.

## Cohesive change groups

Each group is a PR-sized review boundary. Dependent groups may be stacked;
completion requires implementation, behavioral regression coverage, and the
validation record below. A checked status never means merely documented.

| Group | Findings | Intended PR scope | Dependency | Status |
| --- | --- | --- | --- | --- |
| A | R1, R2, R6 | Evidence ownership, secret boundaries, deterministic extraction | None | Merged: [PR 77](https://github.com/anvai-labs/agentbrowser/pull/77) |
| B | R7, R8, R13 | Wire actions, SDK deadlines/error details, adapter error normalization | A | Merged: [PR 78](https://github.com/anvai-labs/agentbrowser/pull/78) |
| C | R3, R5 | Live element identity and operator-controlled approval policy | B | Merged: [PR 79](https://github.com/anvai-labs/agentbrowser/pull/79) |
| D | R4, R9 | Egress composition, safe download transport, typed captured downloads | B | Merged: [PR 80](https://github.com/anvai-labs/agentbrowser/pull/80); explicitly partial, R4 remains open |
| E | R10, R12 | Shared observation budgets and retention/admission bounds | C, D | Independent review and full local checks passed; delivery pending |
| F | R11 | Safari transport, lifecycle, and explicit deployment capabilities | B | Pending |

## Findings and acceptance criteria

| ID | Finding / location | Severity | Why it matters / reproduced behavior | Fix and required regression | Status |
| --- | --- | --- | --- | --- | --- |
| R1 | Missing-session ownership fallback; api/server.ts, api/service.ts | H | Tenant B reads A's artifact after close and exports A's retained trace | Persist artifact ownership through TTL; reject missing live sessions; filter lists; test close/expiry across tenants | Pending |
| R2 | Incomplete redaction; api/service.ts, api/server.ts, extraction/schema-extraction.ts | H | Secrets survive event replay, extraction evidence, model title and warnings; server omits service registry injection | One injected registry; redact structured inputs/outputs before retention/broadcast; test every boundary | Pending |
| R3 | Playwright ref identity; engine-playwright/index.ts | H | Second same-label button clicks first; resolution compares cached state | Engine-owned node identity and live fingerprint/state checks; duplicate, replacement, detachment, reorder tests | Pending |
| R4 | Egress composition / download bypass; policy/network-policy.ts, engine-playwright/index.ts, api/service.ts | H | Wrapper drops DNS validation; body gate absent; download follows denied redirect; chunked response becomes base64 text; later browser redirect hops bypass routing | D corrects direct downloads, delegation and routed bytes; all-hop browser enforcement requires transport work | OPEN; D is partial, not closure |
| R5 | No production approval trigger; api/service.ts | H | Real engines never produce risk metadata; configurable approval policy ignored | Operator-controlled classification and explicit unknown-risk mode; enforce before execution, bind consent to page/action/identity; real fixture tests | Pending |
| R6 | Adjacency regex backspace escape; extraction/schema-extraction.ts | M | `price: $29.99` fails deterministic matching | Correct escaping; pair positive and substring-negative tests | Pending |
| R7 | SDK deadline ends at headers; sdk-typescript/client.ts | M | 50 ms timeout accepts a body delayed 300 ms | Deadline covers success/error body consumption and decoding; delayed-body HTTP fixture | Pending |
| R8 | Action dialect drift; protocol, sdk-typescript, mcp-server, cli, engine-playwright | M | MCP reload sends empty target; press wrongly requires target; directional scroll is a no-op | Canonical discriminated wire contract, shared translation; assert delivered behavior across surfaces | Pending |
| R9 | Undeclared download port; api/service.ts, engine-playwright/index.ts | M | Engine holds bytes but service returns NOT_FOUND; page close retains downloads | Typed session download port, unique IDs, bounded retention, consume/close cleanup; real capture-to-service regression | Pending |
| R10 | Duplicate/incorrect observation budgets; api/service.ts, core/action-executor.ts | M | 1000-byte budget returns 1093 bytes; repeated serialization is quadratic | One budget component, final-byte accounting and coherent cursor behavior; multibyte/content/diff tests | Pending |
| R11 | Safari transport and deployment contract; engine-safari, api | M | Unscoped execute URL; service rejects all Safari sessions as INTERNAL | Session-prefixed transport, lifecycle checks; explicit typed egress refusal and documented supported deployment; mock transport tests | Pending |
| R12 | Retention/admission limits; api/service.ts, core/approval-gate.ts | M | Event count does not bound bytes; maxTokens=2 admits 3 pending tokens | Per-event and aggregate byte bounds, drop counters, hard token admission after cleanup; capacity tests | Pending |
| R13 | Fragmented error taxonomy; engine, core, api, SDK | M | Error behavior varies by operation; SDK discards approval details | Typed adapter errors, shared normalization/recovery, full protocol error envelope; cross-operation error tests | Pending |

## Design decisions

- Retain explicitly captured artifacts for their existing TTL after session close,
  with immutable tenant ownership. Generating a new trace requires a live owned
  session; this does not introduce session-resume persistence.
- Keep the existing package graph. Extract cohesive modules where behavior needs
  one owner; do not create a general-purpose shared package.
- Raw HTML and image/PDF bytes remain explicit evidence exports, with their
  limitations stated. Structured observations, events, extraction and errors are
  redacted before exposure.
- Safari must never silently bypass egress policy. The direct-engine local mode
  remains distinct from the guarded REST service unless a separate explicit
  deployment capability is designed and tested.
- ADR-008 process/container isolation remains deferred for trusted local use.
  Ownership, consent and resource budgets remain application responsibilities.
  Egress transport interfaces must remain reusable across a future process
  boundary; do not imply that post-buffer checks are streaming memory limits.
- Approval default: operator rules with optional strict unknown-risk handling,
  as recommended while the optional preference question remained unanswered.
  Session approval settings are restrict-only; `allow` cannot relax an operator
  requirement. Consent tokens represent caller confirmation, not an independent
  human-authentication boundary: clients must obtain approval before retrying.

## Validation and delivery record

Groups A-C passed independent correction review and all CI checks before merge.
Other historical per-finding statuses above are implementation notes, not release
claims; the group table governs delivery. D's successful direct-download and
page WebSocket tests do not establish all-hop browser or worker enforcement.
Its operational limitations are documented in [engines](engines.md),
[operations](operations.md), and the [threat model](threat-model.md).

Baseline: workspace build and 740 existing tests passed; four Chromium API tests
passed after one capture setup-timeout rerun. Adversarial local fixtures reproduced
the findings. Real Safari and Obscura were not run during the review.

| Group | Branch / PR | Validation | Remaining limitations |
| --- | --- | --- | --- |
| A | `fix/review-evidence-boundaries` | Workspace build; 195 API/service/boundary tests; 24 extraction tests passed | Raw evidence bytes intentionally not redacted; independent PR review pending |
| B | `fix/review-action-contracts` | Workspace build; 126 service, 65 HTTP, 44 SDK, 46 MCP, 34 CLI, 85 protocol, 33 engine, 173 core tests; real Chromium scroll/keyboard regression passed | Legacy adapter message matching retained at one compatibility boundary; timeout does not imply safe mutation retry |
| C | `fix/review-target-identity-consent` | Workspace build; 127 service/ref-translation tests; 65 core policy/gate/executor tests; 5 real DOM identity and 3 real consent/plan tests passed | Conservative staleness on reorder; exact-match rules are not semantic risk inference; independent human authorization remains the caller's responsibility |
| D | `fix/review-egress-downloads` | Workspace build; 128 service tests; 48 policy tests; 4 direct-transport tests; DNS revalidation/disposal regression; real Chromium chunked-page/captured-download regression | Playwright fetch still buffers before size checks and does not pin DNS; browser temporary-disk quota belongs to ADR-008 deployment isolation |
| E | `fix/review-resource-budgets` | Workspace build; 85 focused core tests; 130 service/budget tests; UTF-8 boundary sweep, full-list cursor, expanding-redaction, event-byte and concurrent token-admission regressions | Serialized service-ledger bounds are not total process-memory limits; engine queues/live snapshots remain separate; text/diff truncation requires larger budgets rather than an element cursor |
| F | Pending | Pending | Pending |

## Separate release-tooling follow-up

Use lockstep first-party package versions with one authoritative product version,
automated manifest synchronization, and CI checks against tags and built artifacts.
Keep `/v1` protocol and underlying browser versions independent. The current API
manifest (`1.2.0`) and hardcoded health version (`1.0.0`) are inconsistent with
the shipped product. This is a separate release-consistency PR, not a version bump
inside the safety fixes. Independent SDK versions can be revisited if it acquires
an independent publishing/support lifecycle.
