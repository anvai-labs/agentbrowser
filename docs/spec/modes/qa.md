# Mode: web development and regression QA

Status: bounded application-owned CLI regression, offline evaluation, native JUnit and
private report links are qualified on develop through T3. General provisioning and
public TestRun orchestration remain deferred. Core applies.

## Job and data

Turn an authorized explored workflow into a repeatable test with an explicit tested
seam, fixtures, assertions and failure evidence. Load only a TestCase definition,
current run cursor, relevant fixture identities, assertions and requested artifacts.
Do not load applicant profiles, scanner payloads or unrelated workflow histories.

## Shared execution

Reuse browser actions, native autofill, application adapters for fixtures/oracles,
shared authority, evidence and reporting. Integrate/export to existing Playwright test
machinery when suitable; do not create another assertion DSL or mode-specific runner.
The agent can author a test, but committed regression playback must not require LLM
decisions. UI tests execute the UI; API setup and outcome reads stay explicitly labeled.

## Required outcome

Record execution and verification separately, with page/application evidence and
cleanup status. A test passes only when every required assertion passes. Preserve
the expected behavior when the UI drifts; do not silently heal an assertion or update
a visual baseline. Use semantic/test identities and explicit business versions.

## Acceptance and footprint

An intentional fixture bug fails, its fix passes, and a falsely successful UI or agent
narrative cannot pass the independent oracle. Include stale refs, delayed server
rejection and required-assertion skips. Qualify at least one conventional report through
shared adapters and link it to private failure evidence; JUnit is the initial format.
Add HTML only when a concrete consumer justifies its privacy and rendering ownership.
Measure one selected test bundle and one qualified browser. Use explicit focused local
selection with fail-to-full when impact is uncertain; an automatic CI selector requires
separate T9 evidence. No scanner or other mode dependencies belong in the default QA
installation. Load only the current failure's evidence.

Primary implementation packet: T3; prerequisites T0/T2. Transport qualification T8.
