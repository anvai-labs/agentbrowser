# Foundation and use-case checkpoint — 2026-09-20

Latest recheck: published 1.11.0 at protected main
`e00539eca682b60e5761702d1851472bb6401b12` (2026-09-24, America/Chicago).
Release, npm, Homebrew PR #73 and installed acceptance are complete; the live service
was preserved on 1.10.0. Extraction budgets (#281), guarded publication (#282–284),
journal contracts (#285), research adapters (#286), ownership (#287) and diagnostics
(#288) are included. The [delivery evidence](release-1.11.0.md) distinguishes published
and installed binaries from the running service and records main ancestry for the back-sync.
The historical records below preserve earlier baselines; the current table and final
checkpoint describe the latest acceptance position. The release does not change finite milestone completion.

Develop recheck: `a06a31c745d81bc25500ff0b34e0c719f64ef1b2` (PR #296).
Unreleased continuation through #292–296 adds navigation reasons, operator Chrome
attachment, the EDGAR recipe, active leases, bounded terminal facts and observed
engine disconnection. PR #296 and its post-merge CI each passed 8/8 checks; see
[disconnect evidence](session-disconnect.md). None establishes durable recovery or
changes installed/released version claims. Original roadmap work resumes at
[T5 C1a journal settlement](t5-journal-settlement.md), merged #297 at `aeb7fdd`
with PR and post-merge CI 8/8 green. [C1b internal authority composition](t5-journal-authority.md)
merged #298 at `a1443c7` with clean review and pre/post-merge CI 8/8.
[C2 application pins and C3 terminal/replay](../design/t5-journal-application-terminal.md)
merged #299 at `e4b5e74` with clean exact-head review and pre/post-merge CI 8/8.
[C4a control views](../design/t5-journal-control-views.md) now use the shared ACK
projection. Runtime selection, concrete storage and recovery remain gated.
C4a merged #300 at `e812fbc` with clean review and pre/post-merge CI 8/8.
[J2a SQLite audit](../design/t5-journal-sqlite-audit.md) merged #301 at `83b747b`
with clean review and pre/post-merge CI 8/8.
[J2b qualification](../design/t5-journal-sqlite-qualification.md) now has an internal
[owner/anchor primitive](t5-journal-sqlite-owner.md); raw adapter, bounded
child manager and remaining qualification gates are next.
The primitive merged in PR #303 at `7ccddb2`; PR and post-merge CI each passed
8/8 checks after exact-head independent review. The [1.12.0 candidate](release-1.12.0.md)
qualifies the completed browsing/session checkpoint without enabling journal recovery.
No public durability or recovery is enabled.
The estimates below remain unchanged.

## Acceptance progress

Percentages below are coarse engineering estimates of each task's acceptance scope,
not measured code coverage, effort, elapsed time or market readiness. Status and
remaining gates take precedence. T9 recurs and is excluded from the finite count.

| Task | Status | Estimate | Remaining acceptance |
| --- | --- | ---: | --- |
| T0 contracts/discovery | Complete, released | 100% | Maintenance with each changed surface |
| T1 context/profiles | Active | ~80% | Installed harness consumption/qualification with T8 |
| T2 shared execution/verification | Complete, released | 100% | Production evidence belongs to T4; restart durability to T5 |
| T3 QA regression | Complete, released | 100% | Broader provisioning and demand-backed report adapters are follow-ups |
| T4 application operations/parity | Active | ~40% | Production UI/API oracle and evidence; U0/U1 operator UX merged; synthetic parity qualified; callback repair merged #236 |
| T5 durable recovery | Active publication/journal foundation | ~10% | HTTP/replay publication merged; B1/B2 contract merged; runtime journal/recovery and process-loss qualification remain; no durable guarantee yet |
| T6 forms/operations | Active | ~40% | Production sources, candidate/job eligibility and live qualification; C3c public synthetic workflow merged #257 |
| T7 audit/security/bounty | Design/gated | 0% | Audit adapter; additional scope and parity gates for security modes |
| T8 installed harnesses | Active source repair; installed acceptance unqualified | 0% installed qualification | Actual installed Victor/Codex/Claude acceptance; registration is insufficient |
| T9 release hardening | Recurring | 100% of 1.11.0 checkpoint | Repeat per later release |

Exact milestone count: **3 of 9 finite tasks complete (33%)**. Counting all original
ten rows gives 30%, including recurring T9. No defensible effort-weighted overall
percentage is available. Partial estimates are intentionally not averaged.
Victor source repair merged at `f3ca959579793b52ed7555b7af53aa458c5ce828`
in [PR #1168](https://github.com/anvai-labs/victor/pull/1168). The last checked
installed Victor was 0.9.3 and remains unqualified; source progress does not establish
release acceptance.

## Incremental continuation and code owners

1. **T4 Q0a callback contracts (merged #236)**: extend ApplicationAuthority, synchronousResult and
   the protocol discovery validator. Falsify malformed authorization, mutable scope,
   reentrant session replacement and preparation-before-dispatch failures. See the
   [bounded design](../design/t4-application-callback-contracts.md). Deliver one reviewed
   PR to develop; keep 1.9.1 immutable. This does not close full T4.
2. **T6 owned-popup/readiness (merged #237)**: extend the existing strategy registry and engine
   fixtures. Qualify popup ownership, repeated labels/options, async readiness and
   focus purity. Reuse the existing autofill closed loop and receipts. Q0 commitment
   verification already shipped in 1.9.1; do not implement it again.
3. **T6 reusable mapping and job dogfood**: version mapping data, keep private values
   outside shared context, and consume existing CLI/REST autofill and verifier seams.
   Qualify an entire local application fixture before authorized live applications;
   require field receipts and independent completion evidence. Search and application
   approval policy remain distinct from form instrumentation.
4. **T4 independent UI/API parity**: both paths reach the same app-owned state oracle;
   break only the UI and require only its test to fail. Reuse the application port,
   receipt identity and T2 verifier composition. Qualify binding UX and production
   evidence separately; do not equate a browser action with an app commit.
5. **T8 harness qualification** can run alongside dependency-ready slices. Use existing
   CLI help/schema discovery and harness transport/projector; measure bounded context,
   cancellation, operation identity and cursor consumption. Repair proven gaps in the
   owning repo through its own PR/release gates.
6. **T5 durability and T7 audit/security** follow their packets and demand gates.
   Recovery must reuse operation identity and qualify restart ambiguity. Audit reuses
   T3 reports; active security modes additionally need T4 and qualified scope controls.
   Do not add an executor, scanner suite or persistent store merely to fill a mode.

Each slice starts with its mode/task context only, failing-first tests and an owner
reuse check. Reconcile the latest develop before branching; run focused tests locally,
then existing mandatory gates on one ready PR candidate. Merge only after green CI
and independent review, verify the actual merge and post-merge checks, and carry exact
evidence into the next checkpoint. Release later when a usable slice is qualified.

## Current bounded increment

PR #236, #237 and #238 each passed eight PR and eight post-merge checks with independent
review. Mapping #238 merged at `098d5ba`, with candidate
`8d1eb6442fe267aad5dd6df75c5e71f93f7c0021`, PR run `35558005447` and post-merge
run `35558255402`. The [mapping evidence](t6-form-mapping.md) remains scoped to
preparation and server preflight in the existing executor.

The [checked-upload/draft slice](../design/t6-verified-upload-draft.md), merged as PR #239, adds
one shared file-integrity helper and a synthetic compiled-CLI draft fixture; see
[local evidence](t6-verified-upload-draft.md). It corrects the earlier assumption
that action approval binds a complete application payload. Final submission stays
denied in this qualification. Do not count a draft as an accepted application or
increase the completed milestone count: T6 remains active and estimates stay conservative.

PR #239 candidate `c03cfaf29555368fc1d2667e482d51492bc54ce6` passed independent
review; PR run `35562728724` and post-merge run `35562976042` each passed all eight
jobs without reruns. Merge `f12ac89` retained the reviewed tree. Main is still the
published 1.9.1 commit above.

The next [consent sequence](../design/t6-reviewed-payload-consent.md) starts by
hardening ApprovalGate ownership and atomic consumption (C0), reusing the existing
bounded serializer. [Evidence](t6-approval-consumption.md) separates this implemented
foundation from future operator approval, complete payload witnesses and submission.

C0 merged as PR #240 at `4b9b155`, preserving reviewed head `744630c`'s
tree. PR run `35565250458` and post-merge run `35565613386` each passed all eight
jobs without reruns; independent review returned SHIP. The next
[C1 foundation](../design/t6-review-authority-binding.md) adds a control-review
version and authority-owned review binding, with captured-owner configuration cleanup.
It merged as #241 at `a57b143`, with PR run `35567615627` and post-merge
run `35567910796` each passing all eight jobs. That foundation alone adds no approval
surface. The [C1a implementation](../design/t6-operator-approval.md) now implements explicit
operator action decisions through REST/SDK/CLI, sharing the token owner, authority
and operation ledger. Complete payload consent and qualified submission remain pending;
milestone count and conservative estimates are unchanged.

C1a merged in #242 at `d5cef8c`, preserving reviewed head `8118754` and tree
`69818b4`. PR run `35570814721` and post-merge run `35571215331` passed all eight
jobs; independent review returned SHIP. The next [C2a draft oracle](../design/t6-draft-oracle.md)
qualifies a named application-owned draft and received attachment bytes through the
existing UI and application interfaces; see [evidence](t6-draft-oracle.md). This is
a test-only candidate, not full-payload consent. C2b witness binding and C3 submission
remain pending, and the milestone count/estimates remain unchanged.

C2a merged in #243 at `7f2e533`, retaining reviewed tree `27c3c96`. PR run
`35573168247` and post-merge run `35573557138` each passed all eight jobs; exact-head
independent review returned SHIP. The [C2b read foundation](../design/t6-scoped-application-read.md)
adds authorized in-admission application reads before witness binding; see
[evidence](t6-scoped-application-read.md). This does not complete full-payload consent
or T4/T6; milestone counts and conservative estimates stay unchanged.

C2b prepared reads merged in #244 at `c8f896a`, retaining reviewed tree `3aa6b0a`.
PR run `35602853928` and post-merge run `35603408458` each passed all eight jobs.
The next [read-source increment](../design/t6-application-read-evidence.md) reuses
the evidence registry and service-owned authority, with a strict test-only named
draft data validator. [Evidence](t6-application-read-evidence.md) keeps this distinct
from page correlation, live payload witnesses and consent. No milestone is newly
complete and published 1.9.1 is unchanged.

Read-source composition merged as #245 at `422fb62`, preserving reviewed head
`0587a06` and tree `59e6f78`. PR run `35622958447` and post-merge run `35623609531`
each passed all eight jobs; independent review returned SHIP. The
[native form witness design](../design/t6-native-form-witness.md) extends the existing
engine read seam and service admission, then correlates a synthetic draft with actual
native controls and file bytes. Its [qualification evidence](t6-native-form-witness.md)
does not claim full-payload consent, atomic submission or live portal readiness.

Native form evidence merged as #246 at `5712475`, preserving reviewed head
`5a18308` and tree `377060e`. PR run `35633182816` and post-merge run `35635284786`
each passed all eight jobs without reruns; independent review returned SHIP. Local
hooks passed 2,618 tests with 24 existing skips. The next
[internal evidence review](../design/t6-evidence-review-binding.md) reuses the existing
ApprovalGate and scoped evidence owners. Its [qualification](t6-evidence-review-binding.md)
keeps public disclosure policy and atomic submission as explicit follow-ups.


Internal evidence review merged as #247 at `9a87b49`, preserving reviewed head
`4bf116b` and tree `14d3582`. PR run `35640744315` and post-merge run `35641304408`
each passed all eight jobs without reruns; independent review returned SHIP. Normal
hooks passed 2,664 tests with 24 existing skips. The next
[public inspection/decision slice](../design/t6-public-evidence-review.md) shares
existing routes, SDK and CLI with a trusted deployment source resolver; see
[qualification](t6-public-evidence-review.md). C3 atomic submission, production
sources and live qualification remain open. Milestone count remains 3/9; T4/T6
estimates stay conservative and published 1.9.1 is unchanged.


Configured public review merged as #248 at `c968280`, preserving reviewed head
`d550ccb` and tree `197ea9e`. PR run `35650334955` and post-merge run `35650850545`
each passed all eight jobs without reruns; independent review returned SHIP. Both
mandatory hooks passed 2,678 tests with 24 existing skips. The next
[C3a oracle](../design/t6-atomic-submission.md) establishes atomic synthetic acceptance
before any submission operation can be exposed. Its [evidence](t6-atomic-submission.md)
keeps mandatory service consent, public usability, production receipts and live
qualification as explicit follow-ups. Estimates and published 1.9.1 remain unchanged.

C3a merged as #249 at `0e86033`, retaining reviewed head `d949646` and tree
`7b30fdf`. PR run `35656689816` and post-merge run `35657268277` passed all eight
jobs; independent review returned SHIP. Both mandatory hooks passed 2,725 tests with
24 existing skips. This qualifies the test owner's atomic acceptance only: no submit
operation is publicly registered.

Coverage expansion #250 merged at `803f078`; PR run `35673258833` and post-merge run
`35674276640` passed all eight jobs. An ancestry check confirms #249 is retained;
the diff from #249 contains tests and a development coverage dependency only. The PR
reports line coverage of 91.67% versus 84.72% on its base. This is test coverage, not
product completion, and was not remeasured during this alignment.

The [coverage findings repair](foundation-coverage-findings.md) addresses five concrete
validation, receipt, CLI and lifecycle defects before C3b. It adds no milestone or
submission permission. Next: design and independently review mandatory consent inside
ApplicationAuthority's existing dispatch path, then implement it with failing-first
tests. C3c public usability/independent acceptance follows that gate. Published 1.9.1,
the 3/9 completed milestone count and conservative estimates remain unchanged.


Foundation repairs #251 merged at `9c82a49`, retaining reviewed head `00acd05`
and tree `c1fc62a`. PR run `35679483754` and post-merge `35679835320` passed all eight
jobs without reruns; independent review returned SHIP. Both mandatory hooks passed
3,206 tests with 24 existing skips.

The [C3b internal consent gate](../design/t6-mandatory-application-consent.md) now
has [focused qualification](t6-mandatory-application-consent.md): authority-derived
intended operations, mandatory protected dispatch, fresh evidence consumption and
one synthetic native/app acceptance through the existing executor. At that checkpoint,
public application schemas rejected the internal approval credential. C3c public review
creation, transport projection, CLI usability and named T2 acceptance qualification
follow below; production sources and live ATS use remain gated. Do not count this
internal increment as a finished T4/T6 milestone or a released feature.

C3b merged as #254 at `9eb43b5`; PR run `35686322253` and post-merge
`35687160556` passed all eight jobs, with exact-head SHIP review. Error-containment
#253 merged at `74bda24`; PR run `35688434370` and post-merge `35688774753`
also passed all eight jobs. Parallel #255 merged at `2bdd535`; a later adversarial
review reproduced serialization/logging/navigation leaks, fixed in #256 at `5bdb89f`.
Reviewed head `fc5f601` and merge retain tree `293351e`; PR run `35695807804` and
post-merge `35696315271` each passed all eight jobs without reruns. Normal hooks and
exact-head independent SHIP review passed.

The [C3c design](../design/t6-public-application-review.md) is implemented and
[qualified](t6-public-application-review.md): public review creation and
consent forwarding, separate operator admissions, named independent accepted-receipt
verification, uncertain-return reconciliation and public visible/hidden/file drift
refusal. It reuses shared authority, evidence and CLI infrastructure. PR #257 merged
as `d53829e`, retaining reviewed head `e31df5b` and tree `9c80b4a`. PR run
`35700286133` and post-merge `35700787754` each passed all eight jobs without reruns.
Both normal hooks passed 3,329 tests with 24 existing skips; exact-head review was SHIP.
T4/T6 estimates remain
conservative: production source configuration, eligibility and live portal coverage
are separate work, and no whole milestone is newly complete.

## Next design checkpoint

[P0 trusted evidence composition](../design/t4-production-evidence-composition.md)
closes the unsupported private-service access used by the synthetic witness fixture.
It reuses the captured admission-owned native reader in the existing trusted provider
callback. P0a/P0b merged #259 at `836cc65`; see the
[bounded qualification](t4-production-evidence-composition.md). Production registration
(P0c) and a real application qualifier (P1) remain separate gates.

[E0 job eligibility](../design/t6-job-eligibility.md) refines the existing job checkpoint
into application-owned normalized facts and a pure eligible/hold/reject predicate.
Its data/schema stays out of the default browser protocol and context. E0a/E0b are
merged in #260 ([evidence](t6-job-eligibility.md)); private integration and live headed qualification need
their named inputs and current evidence. E0c/E1 remain gated; neither the E0 predicate nor the P0 embedding seam increases
whole-milestone completion or claims live application readiness.

Independent design review returned SHIP after clarifying native-reader lifetime versus
witness/app guards, private identifier/digest handling, and unconfigured policy versus
malformed input. All 82 existing context selections and 692 relative documentation links
passed. Default forms/application views still load only core plus their mode (8,880 and
8,215 serialized UTF-8 bytes respectively); detailed designs remain opt-in. These are
context-byte measurements, not token/RSS savings or implemented runtime limits.


The [U0 operator binding delivery](../design/t4-operator-application-binding.md)
reuses the existing panel, application routes and authority with shared stale-request
fencing. It merged in #261 with 8/8 PR and post-merge CI, clean independent review and
reviewed-tree preservation. It covers bounded binding/discovery UX; the next
[U1 reconciliation delivery](../design/t4-operator-reconciliation.md) adds read-only
status/receipt observations. Neither qualifies a production application. T4/T6 estimates remain conservative at ~40%; no additional
finite milestone is complete. Published 1.9.1 and existing browser sessions are unchanged.


U1 merged in #262 with clean exact-head independent review and 8/8 PR and post-merge
CI; see [evidence](t4-operator-reconciliation.md). The next [N0 document-read
repair](../design/t6-document-read.md) removes avoidable interactive binding from
extraction/export after actual headed public capture timed out. E0c private integration
and E1 live draft qualification remain open; no whole milestone or release changes.

N0 merged #263 with 8/8 PR and post-merge CI, clean exact-head review and 3,370
passing tests in each normal hook (24 existing skips). Headed public capture passed;
see [evidence](t6-document-read.md). The next [private listing-review consumer](../design/t6-listing-review.md)
uses existing bounded owners and returns unreviewed source data only. T4/T6 estimates
and the 3/9 complete milestone count remain unchanged; complete private eligibility
and authenticated live draft qualification still need their actual source inputs.


## Listing review and harness schema continuation

The listing-review consumer merged in #264 at `5cbdb99`, preserving reviewed tree
`3eac55c`. PR run `35804055133` and post-merge run `35804457610` each passed 8/8
checks without reruns; both normal hooks passed 3,370 tests with 24 existing skips.
It consumes shared private-file, bounded CLI and JSON owners and reports source
capture as unreviewed. It does not normalize eligibility or authorize an application.
See [listing-review evidence](t6-listing-review.md). Private policy/source/history
qualification and authenticated live drafts remain open.

The next independent [T8 source checkpoint](../tasks/t8-harness-qualification.md#source-level-schema-checkpoint)
repairs demonstrated schema loss in the owning Victor repository. Local evidence:
589 CI-selected tests, 33,338 full-suite collection, 100% changed-production-line
coverage and two real AgentBrowser catalog/delegation acceptances. The unchanged
resource-limit suite previously passed all 25 tests on Linux; this Mac rejects
`RLIMIT_AS` in two real-child cases, without any weakened policy or assertion.

The initial source verdict was withdrawn before merge after an adversarial audit
found implicit reference retrieval and permissive fallback. The repair validates
captured contracts offline, refuses malformed/unresolved schemas and preserves
executor arguments instead of repairing or stripping them. Failing-first tests
also pin reserved-context refusal and static diagnostics. Exact Victor head
`95612eddc52ac264edd91d61f97b109ad8af0bc0` received independent SHIP review;
this supersedes the earlier `6a6bbb` evidence. CI/merge evidence belongs to
[Victor PR #1168](https://github.com/anvai-labs/victor/pull/1168). Provider and
ToolPipeline transformations before the executor still require qualification.

No AgentBrowser runtime or release change is required for that harness repair.
T4/T6 remain ~40%, T8 installed acceptance stays unqualified, and exactly 3/9
finite milestones remain complete. Keep subsequent installed-provider acceptance
separate from registration, a source test or a protocol-version bump.

## T5 dispatch prerequisite — 2026-09-23

The [J0 design and journal sequence](../design/t5-operation-journal.md) starts from
the existing SessionControl and SessionAuthority owners. Guarded page writes, page
creation and application writes use one dispatch helper and the existing drain
tracker. A parent exiting with unresolved writes retains its ticket through drain
and leaves an unknown outcome, even if the abandoned write later succeeds. Awaited
operations, handled failures, read tracking and synchronous admission keep their
existing semantics. No engine, REST, CLI or MCP owns another journal/executor.

Six failing-first authority tests preceded the shared helper and consumer migration.
Follow-up tests cover multiple writes, late rejection, replaced owners and API page
creation. This is a live-process prerequisite, not evidence for restart recovery.
J1–J4 still need durable intent/dispatch/terminal acknowledgments, response ordering,
runtime/store qualification and authorized historical lookup. Exactly 3/9 finite
milestones remain complete; the T5 estimate reflects foundation work only. Published
1.9.1 and running services remain unchanged.

J0 merged through [PR #267](https://github.com/anvai-labs/agentbrowser/pull/267)
at `dbe23b587882d3fe62a6ad07dcc11259d51de81e`. Reviewed candidate `72aef165`
and merge share tree `04aa26ac89ef72f6f23fc610da1e10a0d64ab2e2`. Normal commit
and push hooks each passed 3,378 tests with 24 existing skips. PR CI run
`35826719915` and post-merge run `35827242740` each passed all eight checks;
independent exact-head adversarial review was clean.

The next design checkpoint splits J1 into
[finalization/publication](../design/t5-finalization-publication.md) and
[journal contract/integration](../design/t5-journal-contract.md). Source review
confirmed the Fastify reply-thenable cycle risk, output-guard scope coupling,
post-ACK consent revalidation, concurrent marker sharing and in-memory/durable
replay distinction. Application writes are the first qualification target; native
browser approval/target revalidation remains a separate gate. The packets name
existing owners and failing-first tests instead of creating another executor.
They are proposed only: T5 stays ~10%, exactly 3/9 finite milestones are complete,
and no durability, installed-harness qualification or release is claimed.


## T5 A1: core finalization — 2026-09-23

The [A1 evidence](t5-finalization.md) records finalization separately from ticket
release in the existing SessionControl owner. SessionAuthority composes it after
J0 drain; terminal status cannot be overwritten by a late classification attempt.
No second record store, executor, publisher or dependency was introduced. HTTP
publication remains A2–A4 work, and J1-B/C journal integration is still unimplemented.
The coarse T5 estimate remains ~10%; exactly 3/9 finite milestones are complete.
Published 1.9.1 and running services remain unchanged.


## T5 A2a: session publication — 2026-09-23

A1 merged [#269](https://github.com/anvai-labs/agentbrowser/pull/269) at `3dad07c`;
reviewed tree `f12b5f17cfef9cb92ee263a8df90378fd4576099` was preserved. Both
normal hooks passed 3,387 tests with 24 existing skips; PR run `35847260132` and
post-merge run `35847860435` each passed all eight checks without reruns.

[A2a evidence](t5-session-publication.md) records optional session publication in the
same authority lifecycle, reuse of the outcome runner's bounded-wait helper, closed
execution scope and immutable terminal facts through output failures. This is session
authority only. Application permission/binding publication fencing (A2b), actual HTTP
migration (A3) and authorized replay publication (A4) remain open. Durable recovery
is unimplemented; T5 stays ~10% and exactly 3/9 finite milestones remain complete.
No release or service restart is included.


## T5 A2b: application publication — 2026-09-23

A2a merged [#270](https://github.com/anvai-labs/agentbrowser/pull/270) at `9eb5def`;
reviewed tree `f3d43215886aae52738149cde82370deebd6a2c9` matched the actual merge.
Normal hooks passed 3,410 tests with 24 existing skips; PR CI `35851337246` and
post-merge CI `35851959277` each passed all eight checks without reruns.

[A2b evidence](t5-application-publication.md) records application publication built
on that shared session primitive. Reads/publication share one access guard while
retaining different lifetimes. No new executor, consent consumption or public wire
surface is added. HTTP draft migration (A3), authorized replay publication (A4) and
durable journal/recovery remain open. T5 stays ~10%; 3/9 finite milestones remain
complete. Release 1.9.1 and running services are unchanged.


## T5 A4a1: explicit status publication — 2026-09-23

A2b merged [#271](https://github.com/anvai-labs/agentbrowser/pull/271) at `df1d0a9`;
reviewed tree `f2bf71cc411a4461a6910200bd1a8f1fbe53e43b` matched the actual merge.
Both normal hooks passed 3,434 tests with 24 existing skips. PR CI `35868864909`
and post-merge CI `35869656371` each passed all eight checks without reruns.

[A4a1 evidence](t5-operation-status-publication.md) records explicit status publication
using existing principal/record owners and the shared bounded publication lifetime.
It does not acquire or finish an execution ticket. The next sequence is A4a2 captured
replay/application composition, A3 HTTP integration, then A4b full wire parity. Status
lookup alone cannot authorize publication of a retained duplicate from another owner.
T5 remains ~10%; exactly 3/9 finite milestones remain complete. Release/service unchanged.

## T5 A4a2: captured replay publication — 2026-09-23

A4a1 merged [#272](https://github.com/anvai-labs/agentbrowser/pull/272) at `61ad5c1`;
reviewed tree `6ebe250f022f7bb6ab4deb3931eff0860aa11c77` matched the actual merge.
Both normal hooks passed 3,457 tests with 24 existing skips. PR CI `35885869338`
and post-merge CI `35886682069` each passed all eight checks without reruns.

[A4a2 evidence](t5-replay-publication.md) records captured-owner replay publication
with fresh application access and unchanged core deduplication/consent ownership.
It reuses the status guard, publication lifetime and application-access fence. The next
sequence is A3 HTTP integration and A4b wire parity before journal ACK/recovery work.
Internal replay qualification adds no HTTP adoption or durability claim. T5 stays ~10%;
3/9 finite milestones are complete. Published 1.9.1 and running services are unchanged.

## T5 A3a1: review publication owner pins — 2026-09-23

A4a2 merged [#273](https://github.com/anvai-labs/agentbrowser/pull/273) at `8752c6b`;
reviewed tree `7cbc37f6534288f20cccdbbd1d133df5ad248937` matched the actual merge.
Both normal hooks passed 3,481 tests with 24 existing skips. PR CI `35890344580`
and post-merge CI `35891111476` each passed all eight checks on attempt 1.

[A3a1 evidence](t5-review-publication.md) records session/application checks tied to
the captured operation's actual publication, reusing existing review and access owners.
Read/consent checks remain execution-only. The next [A3a2 composition](../design/t5-review-publication.md)
must retain page, evidence permission and secret-disclosure checks before HTTP adoption.
No new timer, executor, registry or token store is introduced. Review-view status remains
a capture-time snapshot; ApprovalGate owns later current-state validation. T5 stays ~10%;
3/9 finite milestones are complete. Release 1.9.1 and running services are unchanged.


## 2026-09-24 checkpoint

Release 1.10.1 at `124afc3` is published on GitHub/npm; release CI passed 12/12.
Homebrew #70 merged `8a0c2fc`; PR and post-merge CI passed 4/4, and the actual
installed CLI/MCP/server acceptance passed. The live service was preserved on 1.10.0.
Develop `89c20e6` additionally contains extraction budgets (#281) and A3a2 review
disclosure (#282), each with 8/8 PR and post-merge CI. These are not in 1.10.1.

The next [A3b HTTP publication candidate](t5-http-publication.md) integrates existing
authorities into four application/status routes. A3c browser/review routes, full A4b
parity and journal/recovery remain pending. Estimates remain T1~80%, T4/T6~40%,
T5~10%, installed T8 unqualified; finite milestone count remains 3/9 (33%). T9 is
complete for the 1.10.1 release checkpoint and recurs for subsequent releases.


## Browser/review publication continuation — 2026-09-24

PR #283 merged as `58e3605`; its candidate passed 3,891 tests (24 existing skips),
independent review and eight PR plus eight post-merge checks without reruns. The
[A3c/A4b candidate](t5-browser-review-publication.md) extends the same publisher to
review and ordinary browser responses, retaining shared authority and permission owners.
Journal B1/B2 starts only after this candidate's review and delivery gates. Main, tag,
installed release and live headed sessions remain unchanged by this develop work.

HTTP/replay publication completed at #284 with an identical reviewed merge tree and
8/8 green PR/post-merge checks ([evidence](t5-browser-review-publication.md)). The next
[B1/B2 journal contract candidate](t5-journal-contract.md) adds validation and adapter
conformance only. No new release, live-service restart or durable capability is included.
