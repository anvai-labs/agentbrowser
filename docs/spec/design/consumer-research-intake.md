# Consumer research workload: grounded intake

Status: R1 local fixture qualification, R2 basic MCP adapter and R3 browser-error
classification merged in PR #286 (`1aa63f0`), with pre/post-merge CI green.
The [R4 browser ownership prerequisite](research-browser-ownership.md) is an
implementation candidate; public launch diagnostics and remaining work are proposed.
Source: [consumer field report, 2026-09-24](../../consumer-field-handoff-2026-09-24.md).
Code reviewed: develop `5eae01d` plus the storage-neutral journal in PR #285,
merged as `5ebf820`. The report does not identify the exact service/MCP build used; observations
must not be attributed to that code revision without runtime evidence.

Load this packet only for research-workload qualification or the tasks below. It
does not expand the default agent context or replace the existing T0–T9 plan.

## Findings reconciled with current ownership

| Report | Repository evidence | Intake decision |
| --- | --- | --- |
| F1: MCP cannot create additional pages | REST `POST /sessions/:sessionId/pages`, SDK `sessions.createPage`, CLI `page create` and the service page owner already exist. MCP invokes creation inside `browser_create` but exposes no independent page-create tool. | Confirmed adapter gap. Add explicit provisioning through the existing SDK; retain server-generated opaque IDs. |
| Large extracted output spills to files | MCP `textResult` serializes JSON into a text content block; the MCP package contains no persisted-output writer. Extraction owns the structured result and evidence. | Preserve the result/evidence contract. The reported spill path appears harness-owned and needs harness qualification before any path stability promise. |
| F2: navigation reports success at a browser error URL | The Playwright navigation path returns success after a resolved `goto`, unless its response carries the policy-denial marker. | Prioritize a deterministic navigation-result regression test. A browser error document must not be mistaken for successfully loaded target content. The report alone does not establish why `goto` resolved in this run. |
| F2: launch configuration is opaque | Engine launch selection and viewport policy already live in `engine-playwright`; service session views expose engine identity and warnings. | Add a bounded engine-neutral diagnostic projection rather than rediscovering launch decisions in each transport. |
| F2: attach to an operator profile | `PlaywrightChromiumEngine({ cdpEndpoint })` already connects over CDP, but then calls `browser.newContext()`. Its existing test proves separate context/page sets. | Existing remote connection is not authenticated profile attachment. Profile adoption needs a separate explicit ownership and policy design. |
| F3: session loss cannot be explained | Coordinator owns absolute expiry and last activity. Engine publishes page close/crash events; operation-triggered engine-crash recovery records a private crash audit. Neither supplies a unified public close cause. Public session views omit current expiry/idle deadlines. | Bridge those signals at existing owners and their authorized views; do not add a second lifecycle registry. |
| F4: JSON endpoints worked while browse-edgar failed | This is useful field evidence, not a general availability guarantee. | Document a recipe with evidence, bounded pacing and failure handling; verify official endpoint/access guidance before publication. |

## Preserve, qualify, and clarify

Keep extraction `data.text`, source URL/revision/hash, JSON endpoint handling and
`browser_create`'s initial `pageId` compatible. Page IDs are opaque: the observed
`pg_N_page-0` spelling is not an API for inventing IDs. Additional pages must share
the session's existing context, policy and applicable authority. A general page-count
budget is proposed work: the existing cap only limits adopted popups.

The current extraction contract measures UTF-8 bytes of the complete compact JSON
result, including evidence. The default operator ceiling is 1 MiB; the server
accepts `AGENTBROWSER_EXTRACT_MAX_BYTES`, and requests may set `maxBytes` within that
ceiling. MCP serializes a separate pretty-printed envelope. Raw HTML size, compact
result size, MCP wire size and harness spill size are different measurements.
Do not silently truncate results or remove the operator ceiling to accommodate the
field report. Do not substitute `browser_html` for complete extraction: it has its
own inline truncation contract and different redaction semantics.

The wall observations are consistent with the limitations in
[ADR-013](../../adr/013-headed-sessions-and-walled-logins.md), but do not prove CDP
fingerprinting, egress reputation, TLS fingerprinting or throttling as the specific
cause. A maintenance page can have other causes. CDP attachment follows the browser
host's network path; it does not guarantee residential egress or bypass a wall.

Evidence references with partial operation IDs cannot independently identify an
operation. Preserve the field report as supplied; collect full IDs, build identities,
timestamps and sanitized results for reproducible follow-up. Its F1 reference to
session mortality should point to F3, and its F2 recipe reference to F4, not F5.

## Ordered implementation packets

| Priority / packet | Shared owner and scope | Failing-first acceptance |
| --- | --- | --- |
| P1 R1: large-document compatibility | Existing extraction, document-read and evidence owners; qualify the harness separately. Extraction currently does not use artifact storage. | Representative local large-filing fixture; byte-accurate limit tests; complete output plus evidence at an explicitly sufficient ceiling; default/over-limit refusal with no partial result; MCP envelope parses unchanged; independently verify installed-harness spill/read/grep behavior. |
| P1 R2: explicit MCP page provisioning | MCP tool delegates to SDK `sessions.createPage`; list through `sessions.listPages`. Reuse capability filtering and controlled-session operation identity. Define a general page budget at the existing service/session owner. | Same-context cookie sharing; isolated second session; proposed budget denial; malformed/non-HTTP URL refuses before allocation; navigation failure cleans up the allocated page; wrong tenant/stale grant denial; controlled exact retries allocate no duplicate and conflicting operation-ID reuse is refused; uncontrolled uncertainty never triggers automatic retry; invented page ID still returns not found. |
| P1 R3: navigation result correctness | Engine navigation result and shared error normalization; transport adapters project the same result. | Resolved navigation to an internal browser error document returns an engine failure. HTTP 4xx/5xx documents may still be loaded successfully; a bounded HTTP status fact needs a protocol addition if consumers must distinguish them. Preserve explicit policy denial and accepted redirects with final URL. Timeout remains an ambiguous operation outcome, with no automatic replay. |
| P1 R4: launch diagnostics | Engine captures decisions once; protocol/service expose a bounded authorized snapshot; SDK/CLI/MCP reuse it. | Explicit binary override, detected branded binary, bundled fallback, headless, remote CDP and unsupported engines; correct viewport/scrub facts; unknown values remain unknown; no raw credentials or profile paths in output. |
| P2 R5: lease and close-cause visibility | SessionCoordinator lifetime owner, engine lifecycle events, existing service event/status publication and authority. | Injected-clock TTL vs idle expiry; reads' activity semantics; page close vs renderer crash vs browser disconnect; last-page close; stale incarnation/tenant denial; late events cannot affect a replacement session; bounded retention. |
| P2 R6: operator-owned profile attachment design | Existing CDP engine connection plus explicit attachment ownership; extend shared session infrastructure only after the contract is reviewed. | Dedicated-profile opt-in; authenticated local operator endpoint selection; hosted-mode refusal; no arbitrary agent-provided CDP endpoint; attach/detach/crash ownership; unsupported policy refusal; no reuse of expired grants or automatic action replay. |
| P3 R7: filings recipe | Documentation consuming existing CLI/service/extraction contracts. | Reproducible commands and output sizing; official guidance checked; bounded pacing/backoff; explicit identification where supported; maintenance/rate-limit stop; no promise of endpoint availability or bot-wall avoidance. |

R1–R3 are bounded consumer-correctness work; they need not wait for a durable store.
R4/R5 provide operational visibility and can reuse existing publication guards.
R6 requires a design checkpoint; it must not be implemented by exposing the current
constructor option and claiming it reuses a profile. R7 can follow qualified behavior.
Batch related changes through normal review/CI rather than running a separate full
CI cycle for every documentation row.

For plan accounting, installed-harness spill and MCP catalog qualification belong
to [T8](../tasks/t8-harness-qualification.md); the exact-release compatibility check
belongs to [T9](../tasks/t9-release-hardening.md). Page and diagnostic adapters extend
the existing shared session surfaces. R5 intersects [T5](../tasks/t5-durable-recovery.md)
at lifecycle evidence, without claiming its durable recovery work is complete.

### R2 adapter contract

Use an explicit tool name consistent with the existing `browser_*` catalog. Do not
auto-create on an unknown page ID: a typo, stale reference or lost create
response must not allocate another tab. Creation uses the existing `session.manage`
capability; listing uses `page.observe`. Do not broaden an agent mode merely to make
a new tool visible. Existing delegated `browser_session` already lists pages; reuse
its SDK path rather than inventing another inventory store.

Carry caller-selected operation identity through the existing mutation options and
MCP reconciliation helper where a controlled-session authority exists. Ordinary
sessions created by current `browser_create` have no such authority: an operation ID
alone does not enable server deduplication there. Do not promise idempotent creation
or retry an uncertain create automatically in that lane.

Even controlled operation status records status/dispatched facts, not the resulting
`pageId`. Inventory can show current pages, but cannot correlate a lost response to
one page amid concurrent creates. Result-to-page recovery requires a separately
reviewed attachment to the existing operation/result owner, not a second dedup map.
Keep basic provisioning and that stronger recovery claim distinct in acceptance and
tool help. Test the capability catalog, schema advertisement and runtime gate
together. Preserve the initial-page response and keep the CLI viable:
`agentbrowser page create --help` and `agentbrowser page list --help` describe the
existing direct service path.

### R4 diagnostic boundary

Expose allowlisted facts such as local/remote attachment, browser family, configured
vs detected vs bundled selection, effective viewport mode and whether the headed
init script was installed. An observed `navigator.webdriver` value is a timestamped,
page-specific observation, not an immutable launch fact or anti-detection guarantee.
Any such page read uses the existing read/publication boundary. Do not make an
external IP lookup by default. Full launch arguments, executable/profile paths and
CDP URLs can contain private data; they are not default public diagnostic fields.
Capture the actual selected engine and version per session; current session reads
can source the version from the primary engine even when an alternate was selected.
Follow [ADR-016](../../adr/016-branded-chrome-first-headed-launches.md).

### R5 and R6 lifecycle boundary

Expose authoritative deadlines and the sampling time rather than a permanently
decreasing counter cached by the client. Define whether status reads refresh idle
activity. Separate server lifetime, delegated grant expiry and browser attachment
lifetime. A generic target-closed exception does not prove operator intent: report
unknown or the observed signal when no stronger evidence exists.

Today a page-close event reaps that page; closing the last page leaves the logical
session live. A passive page-crash event is not the same as operation-triggered
`recoverFromCrash`, and there is no unified browser-disconnect cause. Pin these
behaviors while adding the new evidence projection; do not turn a page event into
session termination without an explicit reviewed lifecycle change.

If post-close lookup requires tombstones, design bounded, tenant-scoped retention
at the existing lifecycle owner. Do not publish the service's raw crash log. Reuse
the event/cursor boundary and output authorization; prevent stale close events from
closing a replacement incarnation.

Profile attachment cannot silently promise normal context isolation or complete
network mediation for pre-existing tabs, workers and requests. Define ownership of
pre-existing versus newly created pages, what may be instrumented, whether detach
leaves the browser alive, and what is refused when policy cannot be installed.
Follow [ADR-008](../../adr/008-process-container-isolation.md),
[ADR-005](../../adr/005-ephemeral-sessions-explicit-persistence.md) and
[shared infrastructure](../../shared-session-infrastructure.md).
Reconnection must revalidate attachment identity and obtain current authority; it
never restores an old grant or automatically repeats an ambiguous operation.

## Relationship to journal/recovery and delivery evidence

Browser/review HTTP publication and transport parity landed in PR #284. The
[T5 journal contract](t5-journal-contract.md) adds a storage-neutral facade and
adapter conformance in PR #285, merged at `5ebf820` with eight PR and eight post-merge
checks green; it does not yet enable durable runtime operation recovery.
Next T5 composition must retain actual storage settlement separately from bounded
caller waiting, delay business dispatch until its marker is acknowledged, and
retain ACK facts on the existing operation record. No second executor or dedup map.

R5 supplies evidence about session loss; T5 supplies operation history and recovery
rules. Neither may pretend to recreate a destroyed browser profile or authorize
replay. Keep both on their existing owners.

This intake changes neither milestone percentages nor release claims. Qualify R1
against the exact proposed release and installed harness before claiming the large
research workflow remains intact. Do not restart a logged-in service to perform that
test; use an isolated fixture service and separately authorized consumer session.

## First implementation checkpoint

The [research smoke evidence](../evidence/consumer-research-smoke.md) records the
candidate's local validation before commit. R2 adds only the missing adapter tools:
the general page budget and result-to-page correlation still require their own
shared-owner design and tests. R3 uses the existing `INTERNAL` error with a static
`browser_error_document` reason; it does not add HTTP status or redirect-chain fields.
R4 diagnostics, R5 lifecycle projection, R6 profile attachment and R7 recipe remain
next packets in that order. Installed-harness overflow qualification remains T8.
