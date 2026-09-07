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
| E | R10, R12 | Shared observation budgets and retention/admission bounds | C, D | Merged: [PR 81](https://github.com/anvai-labs/agentbrowser/pull/81) |
| F | R11 | Safari transport, lifecycle, and explicit deployment capabilities | B | Merged: [PR 82](https://github.com/anvai-labs/agentbrowser/pull/82) |
| G | Release follow-up | Lockstep product/package versions and release checks | F (delivery stack only) | Merged: [PR 83](https://github.com/anvai-labs/agentbrowser/pull/83) |
| T0 | Egress contract baseline | Accepted local/contained profiles, truthful guarantees, durable redirect gap fixture | Separate from release-version changes | Design and evidence recorded; independently reviewed; runtime gates T1-T4 remain open |

## Findings and acceptance criteria

### Current baseline and next decision milestone

Fresh baseline: `v1.8.4`, with `main` and `develop` synchronized at `085b8e1`
([promotion PR 90](https://github.com/anvai-labs/agentbrowser/pull/90)). All eight
[main CI checks](https://github.com/anvai-labs/agentbrowser/actions/runs/34077686481)
and all twelve [release jobs](https://github.com/anvai-labs/agentbrowser/actions/runs/34081727897)
passed. GitHub artifacts, npm and the [Homebrew formula](https://github.com/anvai-labs/homebrew-tap/pull/24)
are published. Release completion does not close T1/R4.
Reuse the single worktree; do not recreate the A-G stack. The next artifact is
the [integration contract and milestone proposal](transport-integration-contract.md),
with owner-authorized inquiry and local T2a design work. A new T1 mechanism,
private patch or fork still requires a separate decision.

| Unit | Scope | Acceptance / stop condition | Status |
| --- | --- | --- | --- |
| T1a | Compare policy delivery and diagnose replay failures | Preserve HTTP controls; correlate browser failures, CSP violations and server hits | Merged in PR 85; 36-case comparison, 27-case worker follow-up, 20 offline tests; all eight post-merge CI checks green; T1/R4 remain open |
| T1b | Test target startup ownership and nested-worker coverage | Independent review of startup ordering and all-target controls; no production claim from page-only coverage | Merged in PR 86; independent review, 47 offline tests, two 27-worker runs and all eight post-merge checks pass. **Startup gate failed:** all 12 attached workers issue HTTP before this client's release; shared controls uncovered |
| T1c | Reassess transport feasibility against the complete acceptance matrix | T1 remains open until semantics and coverage pass; revisit design explicitly if they cannot | [Reassessment independently reviewed](egress-transport-reassessment.md). Assessment artifact complete, not T1 closure. Separate lifecycle ownership from semantic compatibility; recommend one bounded ownership comparison before choosing integration or maintenance commitments |
| T1d | Bounded sole-owner / competing-resumer comparison from T1c | Three arms, three repeats; native positive controls, all-owner command/target identity; stop without expanding if the T1b distinction is not reproduced | Merged in PR 88 and shipped in v1.8.4; independent review and all eight post-merge checks passed. Two 27-worker runs preserve controls but do not reproduce early execution; 79 offline tests pass. Stop condition reached; T1 remains open |
| T1e | Supported integration contract and maintenance decision | Separate first-request admission, execution initialization and browser-semantic enforcement; no automatic probe expansion or private patch | Owner authorized focused inquiry. [Message prepared](playwright-integration-inquiry.md), not sent: upstream support requires Discord access unavailable here. No upstream-supported mechanism selected |
| T2a | Connection-authority design and test contract | Ground extraction in the direct-download caller; define DNS/peer/TLS ownership, revocation, admission and failure tests | [Design prepared](connection-authority-design.md). Independent source review reproduced R14; T2b0 canonical-address correction precedes connection extraction. No runtime implementation or T1/R4 closure |

T1a is a bounded probe/evidence PR, not a production adapter change. Keep
historical evidence immutable. No gateway deployment, host networking changes,
CA installation, worker disabling, or weakening of the WS/WSS contract is
included. R4 remains open throughout this investigation.

T1a narrows the data-worker HTTP failure to the tested body-fulfillment path,
including replay without added connection policy. Native server-delivered policy
preserves HTTP and denies WS/WSS in these four modes. This is not a root-cause
diagnosis or full target-coverage result; see the
[comparison and limitations](egress-transport-feasibility.md#t1a-native-policy-versus-body-fulfillment).
Independent review caught missing delivery/denial assertions in the evidence
verifier; three failing mutation tests reproduced that gap before correction.
The initial ten offline tests pass. The follow-up adds five child-session
lifecycle tests and five diagnostic-attribution tests; all twenty pass.
Worker-scoped evidence identifies `LocalNetworkAccessPermissionDenied` for
replayed data-worker HTTP to the loopback fixture, including no-policy replay.
The browser's underlying reason for changing that decision is still unproven;
this does not establish a general public-network HTTP failure. No production
security checks were disabled. The observer also misses one native request-start
event, so it cannot establish race-free startup or all-target enforcement.

| ID | Finding / location | Severity | Why it matters / reproduced behavior | Fix and required regression | Status |
| --- | --- | --- | --- | --- | --- |
| R1 | Missing-session ownership fallback; api/server.ts, api/service.ts | H | Tenant B reads A's artifact after close and exports A's retained trace | Persist artifact ownership through TTL; reject missing live sessions; filter lists; test close/expiry across tenants | Merged in A |
| R2 | Incomplete redaction; api/service.ts, api/server.ts, extraction/schema-extraction.ts | H | Secrets survive event replay, extraction evidence, model title and warnings; server omits service registry injection | One injected registry; redact structured inputs/outputs before retention/broadcast; test every boundary | Merged in A |
| R3 | Playwright ref identity; engine-playwright/index.ts | H | Second same-label button clicks first; resolution compares cached state | Engine-owned node identity and live fingerprint/state checks; duplicate, replacement, detachment, reorder tests | Merged in C |
| R4 | Egress composition / download bypass; policy/network-policy.ts, engine-playwright/index.ts, api/service.ts | H | Wrapper drops DNS validation; body gate absent; download follows denied redirect; chunked response becomes base64 text; later browser redirect hops bypass routing | D corrects direct downloads, delegation and routed bytes; all-hop browser enforcement requires transport work | OPEN; D is partial, not closure |
| R5 | No production approval trigger; api/service.ts | H | Real engines never produce risk metadata; configurable approval policy ignored | Operator-controlled classification and explicit unknown-risk mode; enforce before execution, bind consent to page/action/identity; real fixture tests | Merged in C |
| R6 | Adjacency regex backspace escape; extraction/schema-extraction.ts | M | `price: $29.99` fails deterministic matching | Correct escaping; pair positive and substring-negative tests | Merged in A |
| R7 | SDK deadline ends at headers; sdk-typescript/client.ts | M | 50 ms timeout accepts a body delayed 300 ms | Deadline covers success/error body consumption and decoding; delayed-body HTTP fixture | Merged in B |
| R8 | Action dialect drift; protocol, sdk-typescript, mcp-server, cli, engine-playwright | M | MCP reload sends empty target; press wrongly requires target; directional scroll is a no-op | Canonical discriminated wire contract, shared translation; assert delivered behavior across surfaces | Merged in B |
| R9 | Undeclared download port; api/service.ts, engine-playwright/index.ts | M | Engine holds bytes but service returns NOT_FOUND; page close retains downloads | Typed session download port, unique IDs, bounded retention, consume/close cleanup; real capture-to-service regression | Merged in partial D; R4 remains open |
| R10 | Duplicate/incorrect observation budgets; api/service.ts, core/action-executor.ts | M | 1000-byte budget returns 1093 bytes; repeated serialization is quadratic | One budget component, final-byte accounting and coherent cursor behavior; multibyte/content/diff tests | Merged in E |
| R11 | Safari transport and deployment contract; engine-safari, api | M | Unscoped execute URL; service rejects all Safari sessions as INTERNAL | Session-prefixed transport, lifecycle checks; explicit typed egress refusal and documented supported deployment; mock transport tests | Merged in F |
| R12 | Retention/admission limits; api/service.ts, core/approval-gate.ts | M | Event count does not bound bytes; maxTokens=2 admits 3 pending tokens | Per-event and aggregate byte bounds, drop counters, hard token admission after cleanup; capacity tests | Merged in E |
| R13 | Fragmented error taxonomy; engine, core, api, SDK | M | Error behavior varies by operation; SDK discards approval details | Typed adapter errors, shared normalization/recovery, full protocol error envelope; cross-operation error tests | Merged in B |
| R14 | Resolved-address representation gaps; policy/network-policy.ts | H | Strict policy denies ordinary loopback but allows mapped/expanded loopback and malformed address text; independently reproduced at policy level, not as an end-to-end network exploit | T2b0 canonical parsing/classification, mapped IPv4 handling, malformed resolver validation; policy and real transport regressions before reusable connection authority | OPEN; found during T2a design, not fixed by v1.8.4 |

## Design decisions

- Owner approved the [two-profile egress direction](egress-transport-design.md):
  native local mode remains supported; contained Chromium starts on Linux and
  requires OS-enforced gateway-only egress before release. Pull forward only
  that ADR-008 slice. Continue unrelated corrective PRs independently; no host
  firewall change, production deployment, release or full Phase 4 rollout is
  implicit. R4 remains open until transport acceptance tests pass.

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

Groups A-G passed independent correction review and all CI checks before merge.
Other historical per-finding statuses above are implementation notes, not release
claims; the group table governs delivery. D's successful direct-download and
page WebSocket tests do not establish all-hop browser or worker enforcement.
Its operational limitations are documented in [engines](engines.md),
[operations](operations.md), and the [threat model](threat-model.md).

### Historical independent review and integration update (before v1.8.4)

A merged into `develop` at `b72510c`, B at `c0798d8`, C at `b865868`, and partial D
at `d04d77f`, E at `c7903f8`, F at `92e7efa`, and G at `d9ddfc5`, each after
independent correction review and all eight GitHub CI checks passed. Their local and remote task branches were deleted;
there was only one worktree, so no duplicate dependency trees were removed.
The remaining local stack was rebased onto that merge. No promotion to `main`,
release, or package publication was performed. B's first publication attempt was
stopped by three local Chromium test/hook timeouts; its full commit checks had
passed earlier. A subsequent full workspace check passed without changing the
tests or increasing timeouts. B subsequently passed all CI and merged.
A-G were delivered sequentially as PRs 77-83. T0 is the separate final
design/evidence unit; its branch was rebased onto G without creating another
worktree. This delivery does not close R4 or implement a contained profile.

E/F/G correction commits were folded into their original local groups rather
than new branches. Their full validation hooks passed. F's 18 always-on
mock/HTTP tests include cross-page execution, shutdown races, queue admission,
closing-handle suppression and 100 successful close cycles without enumeration.
The real Safari suite remains enablement-gated (six tests skipped on this host).
Release version/dependency tests and documentation-link checks also passed.

| Review follow-up | Group | Disposition |
| --- | --- | --- |
| Secret-bearing dictionary keys, navigation URLs and nested policy spans | A | Corrected and independently approved before merge |
| Caller `type` overrides canonical wire `action` | B | Reject conflicting discriminator before decoding; full local checks and independent correction review passed |
| Consent uses missing/stale observation URL | C | Live engine URL port with legacy observation fallback; no-observe/history/external-navigation/token regressions; full checks and independent review passed |
| Session-only policy omits default page WS denial | D | Corrected; real Chromium page probe confirms zero server connections; worker coverage is not implied |
| Direct transport omits operator redirect limit | D | Typed policy delegation corrected; zero-limit fixture contacts only initial URL |
| Later browser redirect hops bypass route callback and policy | D / R4 | **Open, high severity.** Owner approved [local and contained profiles](egress-transport-design.md); partial D may proceed only with explicit limitations; contained release requires T1-T4 |
| Candidate worker WS/WSS controls bypassed | T1 / R4 | **Feasibility gate failed.** Page routing and header-only CSP miss workers; body fulfillment changes blob inheritance but breaks a data-worker HTTP control and still misses nested external workers; [evidence](egress-transport-feasibility.md). No production transport fix claimed |
| Diff observation discards continuation/maxElements | E | Corrected; 420-element diff paginates 300+120 and honors maxElements; independent review passed |
| Safari selected-window races and late resource creation after close | F | Corrected; bounded shared operation queue, stable close promises, pending-start cleanup and identity-safe closing markers; independent review passed |
| npm publishing lacks tag-guard dependency | G | Corrected; direct dependency plus regression test; independent review passed |

The implementation-only statuses in the historical finding table above are not
closure claims; the current group/review tables govern delivery. In particular,
R4 is not fixed by the successful direct-download tests. The route-only browser
experiment is preserved in a named Git stash, not included in the delivery
stack. T0 now retains the end-to-end bypass as the explicitly labeled
`redirect-gap-real-chromium.test.ts` truth guard; it is not a security acceptance
test and must be inverted when transport enforcement closes the gap.

Baseline: workspace build and 740 existing tests passed; four Chromium API tests
passed after one capture setup-timeout rerun. Adversarial local fixtures reproduced
the findings. Real Safari and Obscura were not run during the review.

| Group | Branch / PR | Validation | Remaining limitations |
| --- | --- | --- | --- |
| A | [PR 77](https://github.com/anvai-labs/agentbrowser/pull/77), merged | Workspace build; 195 API/service/boundary tests; 24 extraction tests; independent correction review and all CI passed | Raw evidence bytes intentionally not redacted |
| B | [PR 78](https://github.com/anvai-labs/agentbrowser/pull/78), merged | Workspace build; 126 service, 65 HTTP, 44 SDK, 46 MCP, 34 CLI, 85 protocol, 33 engine, 173 core tests; real Chromium scroll/keyboard regression passed | Legacy adapter message matching retained at one compatibility boundary; timeout does not imply safe mutation retry |
| C | [PR 79](https://github.com/anvai-labs/agentbrowser/pull/79), merged | Workspace build; 127 service/ref-translation tests; 65 core policy/gate/executor tests; 5 real DOM identity and 3 real consent/plan tests passed | Conservative staleness on reorder; exact-match rules are not semantic risk inference; independent human authorization remains the caller's responsibility |
| D | `fix/review-egress-downloads` | Workspace build; 128 service tests; 48 policy tests; 5 direct-transport tests; DNS revalidation/disposal regression; real Chromium chunked-page/captured-download regression | Playwright fetch still buffers before size checks and does not pin DNS; browser temporary-disk quota belongs to ADR-008 deployment isolation |
| E | `fix/review-resource-budgets` | Workspace build; 85 focused core tests; 130 service/budget tests; UTF-8 boundary sweep, full-list cursor, expanding-redaction, event-byte and concurrent token-admission regressions | Serialized service-ledger bounds are not total process-memory limits; engine queues/live snapshots remain separate; text/diff truncation requires larger budgets rather than an element cursor |
| F | `fix/review-safari-contract` | Safari build; 18 always-on mock transport/lifecycle, queue, race and HTTP deadline tests; guarded API refusal regression | Real Safari remains enablement-gated and unavailable on this host; direct-engine local use has no egress enforcement or console/network evidence |
| G | `chore/review-release-consistency` | Workspace build; 35 CLI tests; version-sync/drift/tag fixture; built API/CLI/MCP version checks; documentation links passed | Metadata aligned to existing 1.8.3; no new release or publication |

## Separate release-tooling follow-up

Implemented in group G: lockstep first-party package versions with one authoritative product version,
automated manifest synchronization, and CI checks against tags and built artifacts.
Keep `/v1` protocol and underlying browser versions independent. The current API
manifest (previously `1.2.0`) and hardcoded health version (`1.0.0`) were inconsistent with
the shipped product. This is a separate release-consistency PR, not a new release
inside the safety fixes. Independent SDK versions can be revisited if it acquires
an independent publishing/support lifecycle.
