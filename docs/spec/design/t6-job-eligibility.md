# T6/E0: bounded job eligibility with evidence and explicit unknowns

Status: E0a/E0b implemented in the current candidate; E0c/E1 remain gated. See the
[implementation contract](../../../examples/job-application/README.md) and
[qualification evidence](../evidence/t6-job-eligibility.md). This refines the decision contract in the
[job-application checkpoint](t6-job-application-checkpoint.md); it implements conditional screening only and does not authorize any write. Load forms/T6 plus this packet only. No applicant
pay, employer history, source resume, cookies or real listing data belongs here.

## Ownership and footprint

Job suitability is application policy, not browser authority. Keep its data and pure
predicate in an application-owned workflow module, proposed synthetic reference
`examples/job-application/eligibility.mjs`, with private deployment inputs outside this
repository (the existing resume workspace). No protocol-wide job schema, default MCP
tool, new service endpoint, ranking service, parser framework or generic rules DSL.
Recheck the actual application repository before choosing its implementation path.

The pure evaluator consumes already normalized bounded data plus an explicit observed
clock value. It performs no search, file I/O, HTTP, browser interaction, LLM inference,
resume generation or submission. The trusted caller owns provenance, private input
loading and revalidation. Any shell composition uses the installed AgentBrowser CLI's
existing help/schema, JSON input and operation-status contracts. Do not create another
CLI/service or duplicate bounded file/process helpers from the existing Node recipe.

Use the existing bounded own-data snapshot/canonicalization owners where imported by
an embedding; standalone recipe packaging must explicitly qualify their availability
before claiming portability. Do not silently copy validators to bypass package layout.
The evaluator's job-specific schema checks belong to that application module.
A future product CLI projection requires a real consumer and a separately reviewed
contract; E0 does not invent an `agentbrowser jobs` command.

## Normalized private inputs

Require exact versioned records, own JSON data without accessors, bounded strings/arrays
and safe integers. Proxy traps are not a JavaScript isolation boundary: finish bounded
normalization before consulting decision state, as the existing snapshot owner does.
Reuse current snapshot limits
for an embedding: 64 KiB, 4,096 nodes, depth 16; at most 128 criteria/evidence entries
per candidate and 256 candidates per explicit batch. Reject oversized/malformed input
as a validation error, not an eligible/hold decision. Do not truncate into eligibility.
No cross-candidate mutable cache; evaluate each detached candidate independently.

| Record | Required contents / limits |
| --- | --- |
| Policy | Explicit `unconfigured` state, or `configured` with opaque id/version, required employment/location/travel/benefit/role criteria, compensation comparison, freshness policy and source requirements |
| Candidate identity | Opaque candidate id; source/site job id; exact employer identity; optional employer-scoped requisition id; canonical identity resolution status |
| Listing observation | Source reference, observed time, source publication/update time when present, open/closed/unknown status, identity and facts revision |
| Fact | Criterion id, typed value or explicit unknown, source reference, observation time; normalize interpretation separately from quoted evidence |
| Candidate fact set | Private sourced skill/experience/authorization anchors needed for explicit mandatory criteria; no unsupported inferred claims |
| Prior attempts | Bounded references to current authorized operation/receipt observations; local summaries alone are hints |

A source reference identifies privately retained authorized evidence, not a proof by
itself. The evaluator cannot authenticate a URL, hash, caller-supplied timestamp or
source label. Eligibility output is explicitly conditional on supplied evidence;
the trusted caller must establish origin, current permission and freshness before
preparation and again before submission. Portal text is data, never policy or code.
Unknown manual/legal/demographic answers are not guessed from a resume or name.
An omitted/malformed policy record is a validation error. A structurally valid
`unconfigured` policy produces `hold` with a fixed policy-unconfigured reason; it
contains no fabricated defaults and cannot proceed to ranking or writes. Unknown
facts under a configured policy use the ordinary criterion-level hold rules below.

## Deterministic algorithm

1. Validate and detach all input before evaluating criteria. Pin policy, listing and
   candidate-fact revisions and use only the captured explicit clock for this evaluation.
2. Reconcile identity and prior attempts before positive eligibility. Exact source+job
   identity or employer-scoped requisition can match; a normalized title/employer/location
   similarity is only a possible duplicate. Do not merge records solely on fuzzy text.
3. Evaluate every configured mandatory criterion into `satisfied`, `violated` or `unknown`,
   with bounded rule codes and opaque evidence refs. Optional ranking is a later pass.
4. Aggregate into `eligible`, `hold` or `reject` using the precedence below. Emit only
   bounded status/reason/reference data, not raw listing text or candidate attributes.
5. Before any external preparation/write, trusted orchestration rechecks authorization,
   versions, source freshness and prior attempts; rerun the predicate if anything changed.

Known accepted duplicate: reject this application attempt. Pending or unknown prior
write: hold and reconcile through existing operation/receipt reads; do not treat missing
local history as proof of no submission. A restart without durable history remains
unknown (T5), and changing an operation ID cannot make it eligible.

Unresolved identity, stale/conflicting evidence or missing trusted source qualification:
hold, regardless of apparent positive fit. Facts attached to an unproven identity cannot
produce a definitive rejection of another job. For a stable current identity, any
observed mandatory violation rejects; otherwise any mandatory unknown holds; only all
mandatory criteria satisfied yields eligible. Confirmed closed listings reject; an
unverified status change holds. No optional score can override these states.

## Compensation and benefits

Represent monetary amounts as nonnegative safe integers in an explicitly declared
currency minor unit; require exact currency, period and pay-component enums. Validate
range ordering and precision. Do not use floating-point currency arithmetic, a midpoint,
exchange-rate guessing or salary conversion without explicit evidence and policy.
Bonus, equity and total compensation never satisfy a base-pay floor. Hourly/contract
pay does not become annual base by assuming full-time hours or paid leave.

First packet supports comparison only when currency, annual period and base component
exactly match the configured threshold. Other cases hold. Its range rule is explicit:
`guaranteed-minimum` compares the observed range lower bound with the floor. A range
entirely below the floor violates; a range straddling it holds for compensation review;
a missing lower bound or ambiguous geographic range holds. The upper bound reaching
the floor alone never produces eligible. No actual offer is guaranteed by posted pay.

Benefits are criterion-specific observed present/absent/unknown facts. Omission is
unknown, not absent. Required benefit unavailable for the specific employment type or
location violates when that scope is established. Unknown eligibility, benefit limits
or qualifying location holds. Compare retirement, insurance, leave or equity only
against explicit private preferences; a vague “great benefits” label is insufficient.
Role suitability uses agreed mandatory criteria plus sourced candidate facts; free-text
ranking or model confidence cannot satisfy an unverified must-have criterion.

## Result and revalidation

Proposed result fields: schema/rule version; opaque policy/candidate/listing/fact-set
revision references; evaluatedAt/validUntil; decision; ordered bounded criterion results
(rule code, three-state result, evidence refs). Keep input values, excerpts and precise
preferences private. Even opaque IDs/digests may be linkable: they are private by default,
not automatically safe for public logs or CI artifacts. Use synthetic data in tests.

`validUntil` is the minimum of the configured observation expiries; missing expiry
policy, future observations beyond configured clock tolerance or clock regression holds.
Evaluation is deterministic given records/policy/clock. Expiry is advisory until checked
by the trusted consumer. Never cache a positive decision across source, account, job,
policy, profile, mapping or attachment changes. A digest is correlation, not permission.

An eligible result does not approve a payload or confer submission authority. Keep the
C3c source-derived action, complete witness and operator decision unchanged. The
application owner must re-evaluate the pinned criteria against current trusted facts at
review and pre-dispatch; do not accept a caller-supplied `eligible: true` flag or old result
as that check. If real listing eligibility cannot be revalidated atomically with an
application commit, advertise that limitation and retain draft/manual submission.
Do not add eligibility fields to shared protocol/consent envelopes until one qualified
adapter needs them; its declared input and app-owned version can carry scoped identities.

## Implementation packets and falsifiers

| Packet | Deliverable | Required acceptance |
| --- | --- | --- |
| E0a | Pure typed data validator/evaluator in application-owned synthetic module | Below/at/straddling threshold; base vs total; unknown currency/period/benefits; explicit unconfigured policy holds, omitted/malformed policy fails validation; boundary input; deterministic output |
| E0b | Identity/freshness/attempt reconciliation in the same module | Cross-employer requisitions cannot collide; fuzzy duplicates hold; changed/stale evidence, pending/unknown attempt hold; accepted duplicate rejects |
| E0c | Private source-grounded workflow integration using existing CLI recipe/helpers | Wrong employer/job/account, stale profile/listing, unsupported resume claim, altered PDF and ineligible mandatory field prevent external writes; no private data in diagnostics |
| E1 | One named portal's authenticated headed search and draft qualification | UI-driven search through CLI/REST; current session/identity observed; independent review of normalized facts; no guessed hidden/private portal API |

E0a can proceed independently of production adapter selection after design review.
E0c/E1 require actual private inputs and authorized current sessions, not synthetic
values presented as user facts. Respect existing confirmed preferences; ask only for
missing essential policy inline. A lack of policy becomes hold, never an invented
threshold or a request to reconfirm already supplied facts.

Run deterministic red/green tests in the existing test setup, no new runner/job. Use
named reason assertions and independent cases, including malformed source references
and evidence injection attempts. Then normal hooks, exact-head adversarial review and
one PR candidate under the owning repository's rules. No milestone is complete merely
because this design or its pure evaluator exists. Production evidence uses the separate
[T4/P0 packet](t4-production-evidence-composition.md); consent uses C3c unchanged.


## E0a/E0b concrete record decisions

The reference module uses JSDoc-checked closed version-1 records. Every policy category
(employment, location, travel, benefit, role) must have criteria or be explicitly listed
in `unconstrained`, exclusively; omission is invalid rather than vacuous eligibility.
Compensation stays mandatory for configured policies. A role fact needs both listing and
profile anchors; availability/role booleans are normalized assertions, not inferred claims.
Travel is an integer percentage. Evidence is pinned to record subjects/revisions;
history additionally names the current profile. Same source/job with conflicting employer
or non-null requisition holds. A missing freshness policy is represented explicitly by null.

Each criterion reports unknown when its required evidence, clock, freshness or listing
identity is unqualified. The aggregate still preserves conservative hold precedence.
The module consumes one candidate, not a batch; private publication/update metadata stays
with retained source evidence, while the caller supplies the qualified observation time.
It reuses the bounded protocol snapshot via a workspace-built import. Standalone packaging,
source authentication, private resume/portal normalization and actual write integration
remain E0c/E1 work. See the example README for exact fields and source-kind requirements.
