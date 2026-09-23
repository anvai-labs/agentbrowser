# E0c private listing-review consumer

Candidate based on develop `4bcc47b` (#263); see the
[design](../design/t6-listing-review.md). One application-owned function composes
`readPrivateRecipeBytes`, `callInstalledCli` and protocol `snapshotJsonData` with
existing verification limits. The CLI helper receives a JSDoc contract annotation;
its runtime implementation is unchanged. No new browser runner, service route,
validator traversal, dependency, CI job or default-mode context is introduced.

## Tests and review

The first test run failed because the new consumer module did not exist. The final
Node selection passes 100 tests: 60 existing eligibility cases plus 40 consumer cases.
The new function has a checked JSDoc boundary. The earlier recipe remains JavaScript
with its existing tests; this packet does not claim a full type audit of that module.

Consumer tests assert fixed command arguments and credential isolation, unreviewed
output, no effects from instruction-like text, malformed config/output refusal,
URL/evidence mismatch, output overflow, cancellation, local clock regression and
fixed private diagnostics. Invalid config tests verify the child was not launched.
Additional trailing-line-terminator tests confirmed correct existing JavaScript regex
behavior; a review concern there was retracted and no regex fix was needed.
The underlying helpers continue to own subprocess timeout/escalation, file permissions,
symlink handling and publication safety; these mechanisms are reused rather than copied.
The first full local commit hook stopped on an existing remap-healing race test's
30-second timeout during heavy host load. That fixture relied on 400 paragraphs and
a 250 ms sleep. The fixture now gates the existing healing observation explicitly,
closes the real page, then runs the original observation and retains the same typed
stale-target assertions. No product code or timeout is changed. This small test repair
removes timing assumptions rather than retrying the same flaky race.
Independent design and source reviews returned SHIP. Exact-head review and CI remain
required delivery gates.

## Actual read-only acceptance — 2026-09-22

The function read a private 0600 config selecting the installed AgentBrowser CLI 1.9.1
and an isolated current-develop server. A headed page was opened through AgentBrowser
to the public listing previously observed from its careers index. The function returned
18,635 text characters in 294 ms, status `captured_unreviewed`, eligibility
`not_evaluated`. This is one measured capture, not a performance guarantee or production
source/authentication qualification. No profile, cookies or applicant data was read by
the function, no application was filled/submitted, and the actual config/capture remain
outside the repository. The temporary session was closed; the background service was
not restarted. No private path, session ID or listing text is committed as a fixture.

## Remaining work

Reviewed normalization of current policy/profile/listing/history records, employer/job/
account qualification, resume/attachment grounding and pre-write revalidation remain
E0c work. Authenticated headed search and draft qualification remain E1. A source hash,
exact URL and timestamps cannot qualify those inputs. T4 production witnesses and
independent receipt verification are still separate gates. T4/T6 remain active with
conservative estimates unchanged; published release 1.9.1 is unchanged.
