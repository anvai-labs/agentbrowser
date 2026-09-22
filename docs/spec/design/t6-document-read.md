# T6 N0: document reads without interactive reference construction

Status: implemented candidate, based on develop `0afe7de` (#262). See
[qualification evidence](../evidence/t6-document-read.md).

## Observed blocker and scope

Read-only dogfooding opened a public careers index through a headed AgentBrowser
CLI session. Link extraction timed out on both the installed 1.9.0 service and an
isolated server built from merged develop (1.9.1). The installed CLI is 1.9.1.
The service's extraction and HTML-export paths call full interactive observation,
which builds and enriches references even though document-only extractors do not
consume them. This is avoidable work on link-heavy pages, not evidence that every
observational timeout has the same cause. No job was filled or submitted.

Add one optional `EnginePage.readDocument` primitive returning only URL, title and
HTML. Chromium uses its existing Playwright content/title/URL reads without aria
snapshot, element binding, ref-store mutation or action. Engines without the new
primitive retain their existing observe fallback. Failure of an implemented primitive
propagates; do not silently retry through observation. Do not use the vestigial
engine.extract method or create a second extractor implementation.

## Shared owner and semantics

One service source-reader helper owns page lookup/activity, primitive selection and
crash recovery for extraction and HTML export. Preserve the current secret-redaction,
artifact bounds, evidence projection and route admission. All document-only formats
(text, markdown, links, tables, jsonld, schema, records) consume the same pure extraction
package. `forms` still needs interactive elements and keeps full observation.

The optional engine primitive passes through the existing SessionAuthority page proxy
and existing admission output checks. No public endpoint/schema or extra capability.
No new package/dependency or CI job. Existing engines are compatible via fallback;
only Chromium's optimized path is qualified by this packet. Exported HTML remains raw
and not secret-redacted, with its existing explicit warning.

These reads are not an atomic document lease. URL/title/content can change between
reads; preserve explicit correlation-only semantics for extraction revision/hash.
No source authentication, complete listing/account history, eligibility or consent
qualification follows. Do not inflate this into a general performance or hard-deadline
claim. Whole interactive observation remains a separate, unoptimized path here.

## TDD and acceptance

Fail first when document-only extraction/export attempts interactive observation.
Qualify actual Chromium HTML/links/text capture with aria binding disabled, preserve
previous element references and behavior, and retain full observation for forms.
Compare pure extractor output and HTML bytes with the established source behavior.
Test optional-port fallback, implemented-port failure with no fallback, crash mapping,
redaction, and controlled permission/revocation. Reuse existing test engine fixtures
and authority owners. Re-drive the public headed read using CLI and record actual
results privately; synthetic local tests remain CI evidence. No applicant data in
committed tests/docs. E0c integration remains open until its own source gates pass.
