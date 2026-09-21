# T6/T9: future deterministic job-application checkpoint

Status: design checkpoint only. No version bump, release, live submission or general
portal-support claim follows from this document. Load this packet only for the future
job-application slice. T6 remains active and T9 remains the recurring release gate.

## Goal and bounded claim

Qualify one deterministic, reviewable workflow that discovers and evaluates full-time,
high-paying jobs with benefits, produces a source-grounded tailored resume, fills the
qualified portions of an application and submits at most once after approval. Search and
application interaction use an existing **headed AgentBrowser service through its CLI,
SDK or REST contract**. Packaged CLI qualification remains mandatory; MCP stays optional.
The workflow may visit Dice, LinkedIn, Indeed and employer ATS
pages through their user interfaces; it must not substitute a web-search tool, private
portal API, site-specific browser fork or second automation service.

The preference packet stays private. It records location and relocation rules, travel
limit, employment type, benefit requirements, target role families, and the compensation
threshold/currency/pay basis confirmed by the user. Never publish an applicant's current
pay, employer history, home location or exact preference values in this specification.

Load the latest confirmed private preferences; do not re-ask values already supplied.
Unknown mandatory criteria keep a candidate on hold. A posted range reaching the user's
target is evidence to investigate, not proof that an offer will meet it. Bonus and equity
cannot satisfy a base-salary threshold. Candidate and exact-payload review remains
mandatory until the criteria and payload are explicitly agreed.

See the optional [CLI cookie-file handoff](cli-cookie-file-handoff.md) design for importing
existing authenticated sessions without putting secrets in process arguments. Cookie
import alone does not establish successful website authentication.

This qualifies one workflow, not every portal, React Select version or ATS. Production
durability, crash recovery and installed third-party harnesses remain T5/T8 work.

## Existing owners and prohibited duplication

The service remains the sole session, authority, action and operation-status owner. The
installed CLI is the first-class client; it does not own retries or truth.

- `snapshot`/`observe` supplies bounded evidence and fresh refs; `autofill` owns serial
  form resolution, writes and verification.
- `plan`/`act` covers checkbox, date, upload and navigation under existing semantics.
- the operation ledger/status lookup reconciles writes; uncertainty never permits replay.
- existing approval policy binds submit to the exact reviewed side effect.

Do not add a workflow executor, generic DSL, site-specific service endpoint, server job
store, alternate receipt ledger or portal SDK. A small private caller-side checkpoint may
compose existing commands. It contains references, hashes, classifications and operation
IDs, never credentials or raw resume/profile values. It is not durable server recovery.

## Private inputs and public-safe state

The source resume lives in `../resume` and remains private. Never copy source/derived PII,
account data, answers or PDFs into this repository, fixtures, CI logs, PRs or public
evidence. A trusted local step may emit private artifacts outside the repository.

Keep three inputs separate:

1. **Preference profile:** versioned mandatory criteria and ranking preferences.
2. **Resume fact set:** source-grounded claims with private source anchors. It grants no
   browser or submission authority.
3. **Form mapping:** public, bounded structure describing applicability, field/block
   matches, required capability and a private value key. It contains no applicant value.

The private join materializes the existing `AutofillRequest`, using vault references
where available. A mapping never persists refs, credentials, cookies, values or scripts.

A restart checkpoint records only opaque candidate/source IDs, mapping/profile versions,
stage, payload/PDF digests, operation IDs and conservative state. On resume, reauthenticate
if needed and revalidate listing, applicability, authority and operation status from
fresh evidence. Never continue from a saved DOM ref or infer success from the checkpoint.

## Candidate record and deterministic decision

Normalize each listing into a bounded record before ranking or filling:

| Field | Rule |
| --- | --- |
| Source/identity | Portal, observed URL/time, source job ID, employer requisition ID and canonical job ID |
| Job | Exact employer/title, employment type and normalized comparison keys |
| Place/travel | Observed location/remote/relocation terms and travel maximum; omission is unknown |
| Pay | Range, currency, period and explicit base/bonus/equity/total classification |
| Benefits | Explicit observed benefits or unknown; missing text is not “no benefits” |
| Fit/evidence | Evidence-linked agreed role fit and bounded source references; raw HTML remains private |

Deduplicate first by source plus source job ID. Cross-source duplicates use employer
requisition ID when available; otherwise hold a normalized employer/title/location match
for review rather than silently merging. A previously submitted canonical job ID is never
eligible again.

The decision is exactly one of:

- `eligible`: every mandatory listing fact is observed, the compensation rule is
  configured and satisfied, and no disqualifier exists;
- `hold`: potentially suitable but a mandatory fact, threshold, source classification,
  identity, benefit, travel or location interpretation is unknown or ambiguous;
- `reject`: an observed fact violates a mandatory rule, such as non-full-time work,
  travel above the configured limit, explicitly absent required benefits, disallowed compensation after
  the threshold is set, or an exact duplicate already submitted.

Ranking happens only inside `eligible` or `hold`; it cannot turn `hold` into `eligible`.
Eligibility is suitability evidence, not submit approval. A separate reviewed-payload
gate binds the exact answers and PDF before any final effect. The compensation profile
must state how a range is compared with the threshold; never substitute its midpoint or
compare total compensation with a base-pay floor.
Record rule version/evidence for every decision. Refresh before preparation and submit;
closed, changed or identity-drifted listings return to `hold`.

## Mapping and widget prerequisites

Before reusable mapping work, close the next bounded widget gap on a synthetic and real
browser fixture:

1. bind an opened option list to its owning control or popup using observed scope;
2. require one exact option, rejecting duplicate exact matches and unsafe prefix choice;
3. poll readiness with the existing bounded read policy without replaying click/type;
4. preserve focus ownership, node/block identity and suffix stopping through every step.

PR #232 delivered Q0 commitment. The subsequent
[owned-popup/readiness slice](t6-owned-popup-readiness.md) implements the next bounded
qualification; it does not qualify arbitrary real ATS widgets. A mapping cannot
advertise a widget before its concrete strategy/evidence contract passes.

Add one bounded descriptor in the protocol owner after red tests. Reuse `AutofillMatch`,
strategy names and current limits. Pin origin, mapping version, stable blocks, required
labels and capabilities. Applicability runs on a fresh complete observation before any
write; missing, ambiguous, truncated, unsupported or drifted evidence blocks the stage.

Native text/select controls and newly qualified widgets go through one `autofill` call
per page stage. Uploads, checkboxes, date controls and multistep navigation use existing
actions or an explicit bounded plan. Unsupported/manual fields remain visibly
`manual_required`; they cannot be counted as filled, verified or skipped-to-green.

## Tailored resume and payload integrity

Tailor only from the private fact set; every material claim/answer retains a private
source anchor. Never invent dates, titles, employers, metrics, skills, education,
authorization or demographic answers. An unanswerable mandatory question means `hold`.

PDF generation stays private; AgentBrowser does not become a renderer. Verify the final
regular file's type, size, parseability, non-sensitive structure and SHA-256. Bind payload
digest, PDF digest and canonical job ID; recompute before upload. Public evidence contains
only opaque IDs/hashes/status. File-input success does not prove application acceptance.

## Headed workflow and human seams

One headed session is the visible workspace. The user performs credentials, CAPTCHA,
device trust and manual challenges. The current root-owned LinkedIn session is transient:
do not encode its port, cookies or identity in a mapping, test or release claim.

For each candidate:

1. Search through the headed portal UI with CLI navigation/actions and capture bounded
   listing evidence. Do not use external web/search tooling for job discovery.
2. Normalize, deduplicate and classify the listing. Stop on `hold` or `reject`.
3. Produce the private PDF/payload, then review job identity, employer/title/location,
   travel, sourced pay type, benefits, digests, unsupported fields and submit effect.
4. After required review, reobserve and pass mapping applicability. Run one bulk autofill
   call for each qualified page stage: zero per-field agent round trips for that stage.
5. Resolve manual fields explicitly. Recheck all required receipts and page/application
   evidence. A successful field report is never a submitted application.
6. Revalidate listing identity and the exact payload digest. Obtain the existing approval
   for the final submit effect and dispatch it once with a unique operation ID.
7. Require confirmation/receipt tied to the job. On loss or uncertainty, query operation
   status and current portal state; never click submit again because confirmation is absent.

Until the user agrees the final thresholds and exact payload policy, only a private local
payload draft may be prepared; live portal filling and steps 4–7 are prohibited. Closing
the browser or changing pages is not evidence of cancellation, failure or success.

## TDD and qualification matrix

Use deterministic local fixtures in existing test suites; live portal checks are manual
release evidence and never run in CI or contain credentials.

- **Decision:** full-time with sourced pay/benefits passes only after a configured
  threshold; missing pay or benefits holds; travel above the configured limit and part-time reject;
  base and total compensation are never compared as the same number; unknown currency
  or period holds.
- **Identity:** same source ID deduplicates; cross-portal requisition deduplicates;
  ambiguous title/location similarity holds; a changed or closed listing cannot submit.
- **Mapping:** applicability drift blocks before I/O; repeated labels require stable
  blocks; duplicate exact options, late options beyond budget, focus theft, stale nodes
  and incomplete commitment evidence stop the suffix without replay.
- **Privacy:** raw resume/profile values, answers, cookies and PDF text never enter logs,
  diagnostics, fixtures, reports or repository files. Redacted-value collisions cannot
  establish equality.
- **Resume:** an unsupported claim, altered final PDF, parse failure or digest change
  blocks upload/submission. The uploaded path and reviewed digest identify the same file.
- **Forms:** qualified controls verify in one bulk call per stage; upload/checkbox/date
  use existing actions; any unsupported mandatory control remains non-passing.
- **Submit:** missing approval dispatches nothing; duplicate operation ID dispatches once;
  lost response reconciles without replay; changed payload/job identity invalidates the
  approval; observed rejection cannot be reported as success.
- **Lifecycle:** takeover, session loss or stale login stops new work. Resumption uses
  fresh evidence and operation status; server restart remains unknown without T5.

Exercise the installed candidate CLI and service with a headed positive fixture plus
negative controls. Then drive each named portal far enough to prove authenticated search,
canonical job capture and the supported draft boundary. Record unsupported portal/ATS
steps honestly. Complete at least one real qualifying flow through final human review;
live submission requires the confirmed criteria and reviewed payload above.

## Future job-application release gates

The owner selected an earlier 1.9.1 checkpoint on 2026-09-20: integrated T3/foundation/Q0
work plus qualified CLI cookie-file handoff. The full workflow below remains future work;
deferral does not satisfy its gates. A later job-application release is gated by the
capabilities it changes, not completion of all T6, T5 or T8:

1. PR #232/Q0 is already merged at `d510a56`; its PR and post-merge runs each passed all
   eight required CI jobs. Preserve those exact identities in release evidence.
2. Finish the deferred Q0a trusted application-authorization callback hardening if it
   is included in the candidate; require fail-closed red tests, independent review and
   exact-head/post-merge CI.
3. Deliver and qualify popup ownership, exact-option ambiguity and bounded readiness,
   then the minimal mapping/private-profile join and workflow composition described here.
4. Pass focused red/green tests, existing autofill/plan/upload/approval/operation suites,
   API/CLI type and contract checks, actual headed positive/negative controls, installed
   candidate CLI/service acceptance and one reviewed real-job draft flow.
5. Build a clean versioned candidate only after scope is frozen. Run normal hooks, independent
   adversarial review, all eight PR checks and all eight develop post-merge checks.
6. Main is protected; develop is currently unprotected. Require an explicit operational
   review plus exact-head eight-check green evidence before every develop merge. Promote
   through the protected main PR and existing release/tag/artifact/tap ladder without
   bypassing checks. Version bump, tag and publication are separate authorized actions.

Release notes must name supported portals/ATS stages and limits actually observed. Do
not claim autonomous application, universal portal support, durable resume after service
restart, a complete T6 mapping system or installed MCP/harness qualification. Production
durability remains T5, and MCP remains optional.
