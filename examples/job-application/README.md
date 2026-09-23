# Application-owned job eligibility

E0a/E0b implements the [eligibility design](../../docs/spec/design/t6-job-eligibility.md)
as one pure function. It checks normalized records supplied by a trusted application
owner. It does not search, read private files, infer resume claims, rank jobs, control
a browser or authorize a submission. No service endpoint or MCP tool is added.

## Build and use

This example requires this checkout, installed workspace dependencies and the built
protocol package. It reuses `snapshotJsonData` and `VERIFICATION_SNAPSHOT_LIMITS` from
`../../packages/protocol/dist/index.js`. The protocol package is private; copying this
module alone is not a qualified standalone installation. Missing build artifacts fail
module loading rather than selecting a weaker fallback validator.

```sh
pnpm --filter @agentbrowser/protocol build
pnpm test:job-eligibility
```

The test command checks the JSDoc types and runs Node's existing test runner. The
existing CI Test job runs it after the workspace build; there is no new job or browser
matrix. The [synthetic test fixture](../../scripts/job-eligibility.test.mjs) shows a
complete normalized input. It contains no actual applicant preferences or profile data.

A trusted caller supplies records and an observed clock explicitly:

```js
import { evaluateEligibility } from './eligibility.mjs';

const result = evaluateEligibility(normalizedInput, {
  now: observedClockMs,
  previous: previousObservedClockMs, // null only when no previous clock is available
});
```

`eligible` is conditional screening against the supplied policy and evidence. It is
never permission to fill or submit, proof of an offer, or proof that sources are genuine.
The caller must revalidate authority, source identity, revisions, expiry and prior
attempts before preparation and again before a reviewed write. Unknown history after
a restart remains unknown; this example does not supply T5 recovery.

## Exact records, version 1

All records have exactly their declared own JSON fields. The function snapshots input
and clock together, using the shared 64 KiB / 4,096-node / depth-16 limits, before
semantic decisions. Arrays have at most 128 entries; IDs are bounded opaque strings.
There is no batch interface or mutable cache. Malformed input throws only
`TypeError('Invalid job eligibility input')`; no private value is interpolated.

The module's JSDoc types declare the complete shapes. These are their responsibilities:

| Record | Fields and meaning |
| --- | --- |
| Input | `schemaVersion: 1`, `policy`, `listing`, `profile`, `history`, `evidence` |
| Clock | Nonnegative safe-integer millisecond `now`; `previous` is the prior observed clock or null. Clock regression holds. |
| Policy | Either exactly `{state: 'unconfigured'}`, or configured `id`, `version`, `compensation`, `freshness`, `criteria`, `unconstrained`. An absent/malformed policy fails validation. |
| Policy compensation | Explicit currency, minor-unit decimal digits, `annual`, `base`, integer `floor`, and `guaranteed-minimum` range rule. No defaults or conversions. |
| Freshness | `maxAgeMs` and `clockToleranceMs`, or explicit null for an unconfigured expiry policy. Null holds; arithmetic overflow fails validation. |
| Listing | Opaque candidate `id`, `revision`, `identity`, `status`, `evidenceRefs`, `compensation`, `facts`. Status is open, closed or unknown. |
| Identity | `source`, `jobId`, `employerId`, nullable `requisitionId`, and confirmed/unknown/conflicting `resolution`. No fuzzy equality. |
| Observed compensation | Currency and decimal digits may be null; period/component have explicit unknown variants; nullable integer `min`/`max`, confirmed/unknown/conflicting `scope`, `evidenceRefs`. Ranges must be ordered. |
| Fact | Criterion `id`, typed `value` or null, confirmed/unknown/conflicting `scope`, `evidenceRefs`. Scope means applicability to this job's employment/location, not merely presence in page text. |
| Profile | Stable opaque `id` and current sourced-fact `revision`. The evaluator receives no resume text. |
| History | `revision`, current `profileId`, `complete`, `evidenceRefs`, and `attempts`. Completeness requires current authorized source qualification; an empty local list alone is insufficient. |
| Attempt | `operationId`, `identity`, accepted/pending/unknown/not_submitted `status`, `possibleDuplicate`, `evidenceRefs`. IDs do not authorize replay or erase earlier acceptance. |
| Evidence | Unique `id`, listing/profile/attempts `kind`, `subject`, `revision`, `observedAt`, `qualified`. Listing/attempt evidence subjects match candidate ID; profile subjects match profile ID. Revisions match their respective records. |

Every reference must name an existing evidence record; dangling references, duplicate
IDs, unknown fields, accessors, non-JSON values and oversized inputs fail validation.
Empty reference arrays express unavailable grounding and hold where evidence is needed.
`qualified: true` and history completeness are assertions from the trusted caller. The
evaluator checks consistency and freshness, not source authentication, account ownership,
or whether a cited resume actually supports the normalized fact. E0c owns those checks.

## Criteria and decisions

Each criterion has `id`, `kind`, `expected`. Every category must have one or more criteria
or be listed in `unconstrained`, exclusively. Omitting an entire category cannot silently
relax policy. Explicitly unconstrained categories are an owner choice, not a default.
The reserved `compensation` criterion is always evaluated under a configured policy.

| Kind | Comparison / evidence |
| --- | --- |
| employment, location | Exact normalized nonempty strings; listing evidence |
| travel | Integer percentage no greater than `expected` (0–100); listing evidence |
| benefit | Boolean availability matching `expected`; listing evidence for applicable scope |
| role | Boolean result of an app-owned sourced role criterion; both listing and profile evidence |

Null/missing facts are unknown. Unknown scope is not absence. No model confidence,
normalization guess or optional score can satisfy a mandatory criterion. Unsupported
currency/period/component comparisons hold. A matching annual base lower bound must
meet the floor; a range straddling the floor holds even if its upper bound reaches it.
A missing lower bound holds. The observed currency units must exactly match the policy;
the caller owns correct monetary normalization and no ISO currency conversion is inferred.

Grounding failures (identity ambiguity, conflicting evidence, revision/source mismatch,
stale/future evidence, clock problems or missing freshness) hold before decisions about
fit. Evidence-invalid criteria report unknown, not a positive match or a proven violation.
Then a confirmed accepted duplicate rejects; incomplete history or pending/unknown writes
hold. Confirmed closed listings reject and unknown listing status holds. With stable
current evidence, any mandatory violation rejects, otherwise any unknown holds; only all
required criteria satisfied yields eligible.

Duplicate matching requires the same employer plus exact source/job or employer-scoped
requisition. Same source/job with conflicting employer or non-null requisition holds.
Possible duplicates and unresolved attempt identities hold. A later not-submitted record
cannot erase an earlier accepted record, and changing operation IDs cannot repair an
unknown prior write. History belonging to another profile holds.

Results contain only rule/schema versions, opaque record/revision references, explicit
clock/expiry, decision/reason codes and sorted criterion statuses/evidence references.
`validUntil` is the earliest expiry among referenced observations; it is not a lease or
permission. Results are detached and deterministic for the same supplied data and clock.
Even opaque references are private by default. No output or diagnostics are emitted by
the module itself.

## Shared owners and next integration

Only semantic record validation and job policy live here. Bounded JSON capture stays in
protocol. Later E0c file loading should reuse `readPrivateRecipeBytes` in
[`report-artifacts.mjs`](../node-test/report-artifacts.mjs); CLI process bounds and
credential isolation should reuse `callInstalledCli` in
[`application-outcome.mjs`](../node-test/application-outcome.mjs). E0 needs neither.
Production source permission, native/application witness qualification and complete
payload consent stay with the existing T2/T4/C3c owners. The
[P0 embedding seam](../../docs/spec/design/t4-production-evidence-composition.md) is
available on develop; live integration and actual portal qualification remain gated.

## Capture one listing for private review

`captureListingForReview` is the first read-only E0c consumer. It requires an existing
page already navigated by the owner and an absolute path to a private regular JSON
file (0600 on POSIX). Example config below is synthetic; use current session/page IDs
and an owner-selected canonical HTTPS listing URL. The CLI executable and service are
trusted operator configuration, never values taken from listing text.

```json
{
  "schemaVersion": 1,
  "cli": ["/absolute/path/to/agentbrowser"],
  "serviceBaseUrl": "http://127.0.0.1:5709",
  "sessionId": "ses_example",
  "pageId": "pg_example",
  "listingUrl": "https://jobs.example.com/roles/one"
}
```

```js
import { captureListingForReview } from './listing-review.mjs';

const captured = await captureListingForReview('/private/listing-config.json', {
  env: process.env,
  token: readOnlyServiceCredential, // omit only for an intentionally unauthenticated service
  signal: abortController.signal,
});
// Keep captured private. status is captured_unreviewed; eligibility is not_evaluated.
```

This issues only `extract --format text`; it never navigates, fills, uploads or submits.
The caller's token is isolated by the existing CLI helper; inherited application keys
and Node injection variables are excluded. Config and returned JSON use the existing
64 KiB snapshot limit; process stdout+stderr use the helper's 64 KiB combined limit
and 20-second timeout. Oversized pages refuse instead of being truncated into evidence.
Warnings, unexpected fields, nonzero CLI exits and mismatched source URLs also refuse.

The returned capture contains source URL/revision/hash, local start/completion times
and text. These are correlation data, not proof of account identity, source authenticity,
freshness policy, role suitability or base compensation. Every failure uses the fixed
`Listing review capture failed.` diagnostic without source text or private paths.
The function does not print or publish the return value. No extra installation or CLI
is provided: it consumes the same installed AgentBrowser CLI/service through the built
workspace. Existing `pnpm test:job-eligibility` includes its type check and Node tests.

Next, independently review and normalize private policy/profile/listing/history facts
before calling the pure evaluator. Missing required records mean evaluation is not
available; this function does not invent empty history, defaults or qualified sources.
See [design](../../docs/spec/design/t6-listing-review.md) and
[qualification](../../docs/spec/evidence/t6-listing-review.md).
