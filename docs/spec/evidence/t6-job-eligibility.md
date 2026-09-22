# E0a/E0b conditional job eligibility

Implementation candidate based on develop `836cc65` (#259). The
[design](../design/t6-job-eligibility.md) is implemented by one
[application-owned module](../../../examples/job-application/eligibility.mjs), with
[exact input and packaging documentation](../../../examples/job-application/README.md).
No default mode payload, protocol schema, service endpoint, MCP tool, CLI, runtime
dependency, browser matrix or CI job is added. Release 1.9.1 is unchanged.

## Shared foundation and boundaries

The module calls the existing `snapshotJsonData` with `VERIFICATION_SNAPSHOT_LIMITS`
for the combined input/clock before semantic evaluation. Only closed job-record
validation and policy live in the example. It performs no file/process/network I/O,
reads no clock, and holds no cross-candidate state. The private protocol package is
loaded from the built workspace; standalone copying is explicitly unqualified.

The existing CI Test step runs `pnpm test:job-eligibility` after workspace build. That
command checks the module's JSDoc types and runs the Node regressions. Later private
file and CLI composition reuse the existing recipe byte-reader and process owner;
there is no replacement orchestrator or permission/consent mechanism here.

## Failing-first and adversarial evidence

The initial suite failed before the module existed. Independent review then exposed
an incomplete-policy positive path and misleading per-criterion matches when evidence
was unqualified. New failing regressions preceded each correction: every policy
category now requires explicit criteria or an explicit unconstrained declaration;
criterion statuses become unknown when required grounding is unavailable.

The 60 deterministic cases pass with the JSDoc check. They cover exact/below/straddling
base-pay thresholds, currency/precision/component mismatches, unknown benefits and
scope, mandatory categories, role source kinds, subjects/revisions, stale/future clocks,
expiry arithmetic overflow, accepted/pending/unknown attempts, profile-scoped history,
cross-employer requisitions, conflicting identities, input bounds/accessors, static
errors, deterministic ordering and detached outputs. Only synthetic data is used. All 82 context selections, 709 relative documentation
links and 11 context-loader tests pass.

## Remaining acceptance

Eligibility is conditional on caller-normalized, source-qualified records; the module
cannot authenticate `qualified: true`, prove a role claim from a resume, or establish
history completeness. E0c must ground these assertions through current authorized
sources and integrate the existing private file/CLI helpers, payload integrity and
complete-payload consent. E1 still needs installed headed portal qualification.
T4 production integration/binding UX and T6 live workflows remain active; no finite
milestone is newly complete (3/9, 33%). No live job search, upload or application was
performed during this packet.
