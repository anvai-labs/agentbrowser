# T6 N0 document-read qualification

Candidate based on develop `0afe7de` (#262); see the
[design](../design/t6-document-read.md). One optional engine document port feeds
existing pure extractors and HTML export through a shared service source helper.
Forms still observe interactive elements; engines without the port retain fallback.
Implemented-port failures propagate. Existing authority, redaction, crash diagnostics,
artifact limits and evidence projection remain owned by their current layers.
No public schema, dependency, package, CI job or default context payload is added.

## Failing-first and local checks

Before implementation, three of the initial four new API tests failed because
extraction/export still attempted interactive observation. The final API selection
passes 77 cases (14 new document-source cases plus existing service edge, evidence
and inline-artifact tests). It covers all seven document-only formats, legacy fallback,
forms, implemented-port failure, redaction, raw HTML byte preservation, admission,
revocation before artifact publication, and crash recovery. Crash diagnostics retain
the original operation name. Revocation tests observe the artifact store, not merely
entry into the service method whose guard prevents publication.

Two actual Chromium tests pass: native HTML serialization without aria binding,
retained actionable references, closed-page refusal, and a 1,200-link index without
inventing refs. These are deterministic fixture tests; no performance threshold or
network dependency is introduced into CI. Independent design and source reviews
found no blocking issue after correcting the artifact-publication assertion.
Normal hooks and exact-head review/CI remain the delivery gates.

## Authorized headed CLI re-drive, 2026-09-22

Installed CLI 1.9.1 was used against an isolated loopback server built from this
candidate. The existing background service was neither restarted nor replaced.
The public Anthropic careers index yielded 722 links in about 0.20 seconds measured
around the CLI process; before this repair extraction exceeded the 30-second CLI
request timeout on both the installed service and merged-develop test server.
These are single-run observations on a changing public site, not a benchmark.

Following an observed Forward Deployed Engineer link, text extraction returned
18,635 characters in about 0.05 seconds. HTML artifact export also succeeded.
The raw captures stay in the local temporary workspace; no private profile, account,
cookie, applicant value or submission was involved. Navigation and reads used
AgentBrowser CLI/REST and its headed browser, not a parallel scraping stack.

## Limits and next gate

This qualifies the Chromium document read and shared extraction/export paths only.
Interactive snapshot construction is unchanged. URL/title/HTML are best-effort reads;
the service revision and content hash do not establish atomicity, source authenticity,
job eligibility, complete history, benefits qualification or consent. E0c private
integration and E1 live draft qualification remain open. Production T4 source/UI/API
qualification and T5 recovery are also unchanged. Published 1.9.1 is unchanged.
