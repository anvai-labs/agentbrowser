# T6 E0c: private listing capture for review

Status: implemented candidate, based on develop `4bcc47b` (#263). See
[qualification evidence](../evidence/t6-listing-review.md).
This is the first read-only E0c integration step, not completion of E0c/E1.

## Actual consumer and owners

The authorized job workflow now successfully reads a public careers index and a
selected listing through headed AgentBrowser CLI. The listing's compensation wording
illustrates why automatic positive normalization is unsafe: a displayed range can
include variable compensation. The next consumer is a private, caller-selected listing
review, before normalized facts enter `evaluateEligibility`.

Add one application-owned `captureListingForReview` function in the existing
`examples/job-application` directory. Its private config file selects an installed CLI,
service, existing session/page and exact listing URL. Reuse `readPrivateRecipeBytes`
for bounded, regular, private-file reads; `callInstalledCli` for bounded subprocess
output/time, credential isolation and cancellation; and protocol `snapshotJsonData`
with existing verification limits for detached JSON validation. Do not copy these
helpers, extract a speculative utility package, add a job CLI, parser registry, browser
executor, service endpoint or default harness payload. The pure evaluator is unchanged.

## Contract

Config has exactly schemaVersion 1, cli (existing 1–4 argument executable vector),
serviceBaseUrl, sessionId, pageId and listingUrl. The executable must be absolute.
Service URL permits HTTP/HTTPS with no credentials/query/fragment; listing URL is a
canonical HTTPS URL with no credentials/fragment. IDs are bounded option-safe tokens.
Config and executable are trusted owner inputs, never derived from website text.
Credentials are supplied separately through the existing helper's explicit token
option; inherited application credentials and injection variables stay excluded.

Issue exactly one `extract --format text` through the selected CLI. No navigation,
login, snapshot, fill, upload, action or submission. Require exit zero, bounded own JSON,
nonempty text, exactly one evidence entry with the configured URL, safe nonnegative
revision and current eight-hex-digit hash. Optional evidence excerpt is bounded;
unknown output fields, warnings, model-assisted results and malformed/partial output
refuse. Changed upstream contracts require explicit review rather than silent acceptance.

Return a private detached record with `status: captured_unreviewed`,
`eligibility: not_evaluated`, text and capture URL/revision/hash/start/completion times.
Do not return `qualified: true`, eligibility records, normalized pay, applicant facts,
account identity or fabricated history. Times come from the local clock and refuse
regression during capture; neither timestamps nor hashes establish source authenticity.
Check cancellation before file read, before dispatch and before returning. Every failure
has one fixed diagnostic with no cause, source text, credentials or private path.
No stdout or artifact publication occurs inside the function; its owner handles the
private return value. The function requires the built workspace, like the evaluator.

## TDD and delivery

Use Node's existing runner and subprocess fixture style. Assert the exact fixed command,
credential isolation, no extra browser calls, detached unreviewed output and no effect
from instruction-like listing text. Refuse malformed/private-file inputs, foreign URL,
missing/conflicting evidence, warnings, unknown fields, empty/oversized text, nonzero
exit, timeout, cancellation and unsafe identifiers/URLs. Underlying file/process safety
continues to be tested by its existing owners; add consumer-boundary falsifiers only.
Add these tests to the existing eligibility command/CI job, not a new job. Re-drive the
function through the installed CLI and isolated current service on the observed public
listing. Retain captures privately and commit only synthetic data and aggregate evidence.

## Remaining gates

Public document capture is not authenticated employer/job/account evidence. A reviewer
must supply current private policy/profile facts, benefits interpretation and trustworthy
prior-attempt observations before eligibility can be evaluated. Missing records mean
that evaluation is unavailable; do not invent records to obtain a hold result. The later
E0c integration must test wrong job/account, stale profile/listing, unsupported resume
claims and altered attachment bytes before any external write. E1 live draft and T4
production witnesses/receipt qualification remain independent gates. Release unchanged.
