# Changelog

All notable changes to **AgentBrowser** are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); releases are tagged `vX.Y.Z` and
built by `.github/workflows/release.yml` (binaries + server tarballs on GitHub Releases;
`@anvailabs/agentbrowser-mcp` on npm from 1.7.0 — [ADR-014](docs/adr/014-npm-distribution.md)).

## [Unreleased]

### Changed — export-surface hygiene (internal)

- 26 exports with zero references beyond their own module lost the `export` keyword (the
  symbols remain, module-private). Notable previously-importable names removed from the
  `@anvailabs/agentbrowser-mcp` barrel surface: `utf8Boundary`, `advertisedOutputSchema`,
  `BROWSER_DURABLE_TOOLS`, `OPERATION_ID_TOOLS`. Also `FINDING_SEVERITIES` from the
  `@agentbrowser/engagement` barrel. No in-repo consumers existed; programmatic
  importers of these internals should pin their current version.
- `api`'s `LOGIN_BROWSER_ROUTES` (dead since its introduction) deleted.

### Docs — the 1.27.1 release record

- `docs/spec/evidence/release-1.27.1.md`; baselines move to 1.27.1.

## [1.27.1] — 2026-10-20

Maintenance release: one shared host matcher for the whole product, closing a semantics drift
between the two host policies. **Upgrading from 1.27.0:**

| Who | What changes |
| --- | --- |
| Engagement scopes | a **bare registrable domain in `allowedHosts` now covers its subtree** (`corp.test` admits `www.corp.test`), aligned with the session host policy's #588 semantics. Previously exact-only. `.suffix` patterns are unchanged (subdomains only), as are IPs and unlisted names (exact only) |
| Session `allowedHosts`/`blockedHosts` | entries with a **trailing dot** (`app.example.com.`) are normalized to dot-free form before classification, so they match the same hostnames the shared matcher accepts (previously they never matched) |
| Cross-scope guarantees | the session host policy and the engagement scope now answer host questions through one function (`hostMatchesPattern` in `@agentbrowser/core`) and cannot drift apart again |

**Behavior disclosures:** the engagement-scope change is a **widening** (more hosts in scope for
bare registrable entries); the session trailing-dot change is also a widening (previously such
entries never matched anything). Both replace undocumented non-matching behavior; existing tests
pinning the old exact-only semantics were updated with the change.

### Fixed - host-matcher drift between session policy and engagement scope (T10)

- `scope-policy.ts` delegated to the shared matcher (`hostMatchesPattern` in
  `@agentbrowser/core`); `network-policy.ts` keeps its set-based fast path with the same
  classification, now normalizing trailing dots. The scope/session alignment is pinned by the
  cross-matcher alignment tests (bare-subtree through the real `SessionHostPolicy` plus the
  scope matcher, and trailing-dot entries).

## [1.27.0] — 2026-10-19

Entries are newest first. T10 follow-through: the engagement findings surface completes (library,
CLI, MCP), the MCP tool names become self-describing, and every tool declares its trust hints.
**Upgrading from 1.26.x:**

| Who | What changes |
| --- | --- |
| MCP clients | `create`/`close`/`session` are **deprecated aliases** of the new `session_create`/`session_close`/`session_status` (identical schema, handler and annotations) — migrate this release; the aliases drop in the next major. Every tool now declares `readOnlyHint`/`idempotentHint` |
| MCP clients in audit/appsec/bounty modes | new `finding_check` and `finding_sarif` tools (offline; the ledger and findings files live on the server host) via the new `engagement.findings` capability. qa/forms/operations catalogs unchanged |
| CLI | `finding check` / `finding sarif` via the new light `@agentbrowser/engagement` package (no DOM or image dependencies; audit re-exports it unchanged) |
| TypeScript consumers | `PLAN_ERROR_CODES` and `ErrorCode` re-exported by the SDK; the engagement package exports `checkEngagementFindings`/`buildEngagementSarif` |
| Dependency updates | node docker image 24.22, pnpm/action-setup 6.1.0, minor/patch group (fastify 5.12.7, vitest 5.0.5, playwright 1.64.1). The tldts 7 bump was **blocked** by the T8 footprint gate (MCP bridge idle RSS 81.7 MB vs 75) and stays at 6.1.76 |

### Added — findings bound to an engagement (T10 M3)

- `checkEngagementFindings(ledgerText, findings)` in the new light `@agentbrowser/engagement`
  package checks findings against an exported, chain-verified ledger: the URL must be in the
  recorded scope; a confirmed finding needs independent-reproduction evidence and must cite
  unblocked ledger requests to its own origin+path. `buildEngagementSarif(check)` returns a SARIF
  2.1.0 draft for manual submission, citing the engagement, program and ledger entries.
- The CLI exposes them: `finding check --ledger L --findings F` and
  `finding sarif ... [--out R.sarif]`. The audit package stays out of the CLI, MCP and API
  closures (T7 gate) - the CLI depends on `engagement`, a different package.
- MCP: `finding_check` and `finding_sarif` in the audit/appsec/bounty modes via the new
  `engagement.findings` capability. Refusal results validate against the advertised
  `anyOf [success, refusal]` schema (ajv-pinned in tests).

### Changed - MCP surface refresh (1.27.0)

- `session_create`/`session_close`/`session_status` replace `create`/`close`/`session`
  (deprecated aliases ship this release and drop in the next major). Annotations on all 21+2
  tools; coverage test pins the class map. Snapshot description trimmed to its decision core.

### Docs - automating a flow (T10 M4)

- The CLI guide's saved-plan section gains the `plan-run` CI-action usage and the durable-run
  composition (`--session` + `--execution-requirement durable`).

## [1.26.0] — 2026-10-18

Entries are newest first. T10 milestone M4: automation runs — a saved plan file runs end to end
from the CLI and CI, and durable runs execute inside a controlled session. Also carries the owner's
#588 (bare allow/block domains cover their subtree). **Upgrading from 1.25.x:**

| Who | What changes |
| --- | --- |
| CLI | new \`run PLAN.json --url START --tenant T\`: creates a session, opens the start page, runs the saved plan and closes the session. Exit 0 only when every step completed. \`--scope-file\`, \`--keep-session\` |
| CI | new \`.github/actions/plan-run\` composite action: pinned checksum-verified CLI, API key through a private 0600 file (never argv), JUnit and exit code from \`run\` |
| Durable runs | \`run --session SES --execution-requirement durable --operation-id ID\` executes inside an existing controlled session (page opens and closes there; the session stays) and refuses to create an ephemeral session for a durable plan. A durable plan that fails before a verdict prints its sessionId/pageId/operationId for reconciliation |
| TypeScript consumers | \`PLAN_ERROR_CODES\` exported from protocol and re-exported by the SDK; \`ErrorCode\` re-exported by the SDK |
| JUnit consumers | \`run --junit\` and the \`plan-run\` action write error **codes** only; error messages (which can echo page text) never enter the artifact. The oversized-input CLI error now reads "Input exceeds N bytes." (was "JSON input exceeds N bytes.") |
| Sessions and scopes | session \`allowedHosts\`/\`blockedHosts\` bare domains now cover their subtree (#588, owner); T6 widget strategies qualified for async-loaded and recycled options |

### Added — run a saved plan end to end (T10 M4)

- `.github/actions/plan-run`: a composite action that runs a saved plan against an
  already-running service with a pinned, checksum-verified release CLI (reusing the
  `test-evaluate` installer). The API key passes through a private 0600 file, never argv; exit
  code and JUnit come from `run` itself.

- `agentbrowser run PLAN.json --url START --tenant T [--scope-file S] [--junit FILE] [--keep-session]`
  creates a session, opens the start page, runs the saved plan through the existing `plan`
  endpoint and closes the session (on every path). Exit 0 only when every step completed.
- `--junit` writes one testcase per step: passed, failed (error code only; error messages can echo
  page content and never enter the artifact) or skipped. Mode 0600, created exclusively.
- The release smoke (`scope-consumer-smoke.mjs`) runs a scoped saved plan that submits a form,
  checks the JUnit, a failing plan's exit 1, and that no session is left open.
- `run --session SES --execution-requirement durable --operation-id ID` executes the plan inside
  an existing (e.g. controlled) session and journals it as one browser operation: the page is
  opened and closed there, the session stays, and `run` refuses to create an ephemeral session
  for a durable plan.

### Tests — async, recycled-option and partial-effect widget coverage (T6)

- `autofill-react-select-async-real.test.ts` (real react-select, Chromium): asynchronously loaded
  options commit exactly ("Chicago", listed after "Chicago Heights") when the readiness budget
  covers the load; options that never load fail safely (`uncertain`, nothing committed); options
  keyed by index (React reuses their DOM nodes) commit the exact option; a later field's failure
  leaves earlier fields committed and reported, with nothing undone or submitted. `bulk-autofill.md` documents the readiness budget for slow option sources.

### Docs — the 1.25.0 release record

- `docs/spec/evidence/release-1.25.0.md`; baselines move to 1.25.0.

## [1.25.0] — 2026-10-18

Entries are newest first. T10 milestone M3: program scope and findings bound to the engagement.
**Upgrading from 1.24.x:**

| Who | What changes |
| --- | --- |
| Engagement scopes | new optional narrowing fields: `excludeHosts`, `excludePaths`, `allowedSchemes`, `allowedPorts`, `rateLimit {requests, perSeconds}`, and `program` metadata. Exclusions match a canonical path, and `excludeHosts` and `excludePaths[].hostSuffix` follow the same host pattern as `pathRules[].hostSuffix` (since 1.24.0) |
| Sessions with a `rateLimit` | requests over the limit wait for a slot for up to 15 s (queue included); past that they are denied `SCOPE_RATE_LIMITED` instead of being sent after the caller gave up |
| TypeScript consumers | `SCOPE_RATE_LIMITED` is a new member of the scope sub-code and navigation-failure unions: exhaustive `switch`es need a case |
| CLI | new `scope import FILE --from h1\|bugcrowd\|text`, which converts a published program scope offline. It refuses what it cannot express; an inexpressible exclusion fails the import. The oversized-input error for every file or JSON input (`--scope-file`, autofill payloads, cookie files) now reads "Input exceeds N bytes." (was "JSON input exceeds N bytes."); scripts matching the old text must adapt |
| Library consumers | `importProgramScope` in `@agentbrowser/core`; `checkEngagementFindings` and `buildEngagementSarif` in `@agentbrowser/audit` (also `@agentbrowser/audit/engagement-findings`). There is no CLI or MCP command for findings yet: the audit package stays out of those closures (T7) |
| MCP clients | the `create` tool's scope schema adds the new fields, `ledger`, and the strict host and prefix patterns; the `scope` tool's output reports the new fields and `rateLimit.paced` (catalog digest changed) |
| Scopes without the new fields | unchanged |

### Added — findings bound to an engagement (T10 M3)

- `checkEngagementFindings(ledgerText, findings)` in `@agentbrowser/audit` checks findings against
  an exported, chain-verified ledger: the URL must be in the recorded scope; a confirmed finding
  needs independent-reproduction evidence and must cite unblocked ledger requests to its own
  origin+path. `buildEngagementSarif(check)` returns a SARIF 2.1.0 draft for manual submission,
  citing the engagement, program and ledger entries.
- The check and the SARIF builder move to a new light `@agentbrowser/engagement` package
  (dependencies: core and policy only; `VisualAuditError` and the SARIF primitives moved with it,
  re-exported from `@agentbrowser/audit` unchanged), and the CLI exposes them: `finding check
  --ledger L --findings F` and `finding sarif … [--out R.sarif]`. The audit package stays out of
  the CLI, MCP and API closures (T7 gate) — the CLI depends on `engagement`, a different package.

### Added — import a program scope (T10 M3)

- `agentbrowser scope import FILE --from h1|bugcrowd|text [--program-id … --authorized-by …
  --authorized-at …] [--out scope.json]` converts a published HackerOne, Bugcrowd or text program
  scope into an engagement scope, offline. `*.host` maps to subdomains only (the apex only when
  listed); URLs become host-bound path rules; out-of-scope entries become exclusions.
- A trailing `/*` maps to its prefix. Ambiguous wildcards, public- and private-suffix wildcards,
  other path wildcards, CIDR ranges, per-host ports, unbracketed IPv6, non-web assets and Unicode
  hosts are refused with a reason. Schemes are scope-wide: a single shared scheme is kept, mixed or
  unstated schemes become `["http", "https"]`, and `allowedPorts` is each kept scheme's default port. An inexpressible exclusion fails the whole import
  (exit 1, nothing written), since the scope would be wider than the program. Program authorization
  is recorded only as given. The converter (`importProgramScope`) lives in `@agentbrowser/core`;
  imported scopes are pinned to pass session create.

### Added — program-scope restrictions (T10 M3)

| Field | Narrows by | Denial |
| --- | --- | --- |
| `excludeHosts` | exact / `.suffix` hosts removed from an allowed set | `SCOPE_HOST_DENIED` |
| `excludePaths` | segment-bounded path prefixes, optionally host-bound | `SCOPE_PATH_DENIED` |
| `allowedSchemes`, `allowedPorts` | origin (a URL without a port uses the scheme default) | `SCOPE_HOST_DENIED` |
| `rateLimit` | `{requests, perSeconds}`: paces in-scope requests (waits for a slot) for up to 15 s, queue included | `SCOPE_RATE_LIMITED` past the cap |
| `program` | metadata only: `{id, version?, authorizedBy, authorizedAt}` | — |

- No new sub-codes. Each field can only narrow, and fails closed when a request carries no URL.
- Exclusions match a canonical path (percent-decoded, case-folded, `//` and `\` collapsed,
  `;params` and NUL tails cut, trailing dots and spaces stripped, dot segments resolved — with and
  without decoding an encoded `/` first), so re-spelled paths cannot slip past them. Exclusion
  hosts are normalized like every configured host, and `excludeHosts` entries must be ASCII
  hostnames, `.suffix`es or bracketed IPv6 literals (no scheme, port or Unicode). `program.authorizedAt` must be an ISO 8601
  date or date-time.
- `rateLimit` pacing is serialized (concurrent requests cannot burst past it), counts every
  redirect hop, re-checks the window after waking and expiry and the ledger after a wait, and is
  reported with a `paced` count. A request that would wait past 15 s is denied
  `SCOPE_RATE_LIMITED` rather than sent after its caller gave up; stopping the scope wakes waiters.
  `SCOPE_RATE_LIMITED` is a new member of the scope sub-code unions (TypeScript exhaustive
  `switch`es need a case).
- All six fields are reported by the scope status (REST, SDK, CLI `session scope`, MCP `scope`)
  and in the ledger's `engagement.opened` snapshot.
- Accepted on `POST /v1/sessions`, MCP `create`, and CLI `--scope-file`.
- Gates: policy unit tests and a real-Chromium test where an excluded path and a disallowed port
  never reach the fixture.

### Docs — the 1.24.0 release record

- `docs/spec/evidence/release-1.24.0.md`; baselines move to 1.24.0; the `[1.24.0]` page-creation
  upgrade row is narrowed to what changed (navigations that complete as blocked or timed out).

## [1.24.0] — 2026-10-17

Entries are newest first. T10 milestone M2 completes: scope denials are reported everywhere, and a
session request can no longer carry a restriction the server ignores. **Upgrading from 1.23.x:**

| Who | What changes |
| --- | --- |
| REST clients sending policy fields at the top level of `POST /v1/sessions` (`allowedHosts`, `blockedHosts`, `approval`, `allowDownloads`, `maxDownloadBytes`, `allowServiceWorkers`) | **breaking:** refused `400`. This undocumented shape was honored without validation; send these under `policy`. The SDK, CLI and MCP already do |
| Any session-create request | an unknown key in the request, `policy`, `policy.approval` or `policy.scope` (and its path rules and identity bindings) is refused `400`, never ignored |
| Engagement scopes | configured hosts are lowercased and stripped of trailing dots (a `hostSuffix` with uppercase letters used to bind nothing and leave the host's paths unrestricted); a path-rule `prefix` must start with `/`; a `hostSuffix` must be an ASCII hostname, `.suffix` or bracketed IPv6 literal; a path rule binding no allowed host is refused (`scope.unbound`) |
| In-process embedders | `AgentBrowserService.createSession` validates the scope and approval policy (`scope.invalid`, `approval.invalid`) |
| Page creation with a `url` (REST, SDK, MCP `page_create`, CLI `page create`) | **behaviour change:** a navigation that completes as blocked (for example on a redirect hop) or timed out now fails the create (`403` policy denial, `504` timeout, `500` otherwise) and removes the new page (human takeover keeps it), instead of returning a ready page. Navigations refused before the wire already failed in 1.23 |
| CLI `download` / `download collect --out` | saves first, then prints one compact receipt (artifact, path, byte count); with `--json`, errors go to stderr as JSON. Scripts parsing the old two-document output must adapt |
| Actions, plans, autofill | scope denials keep their sub-code; completed actions can carry `navigationObservation`; plans and autofill stop on an observed denial (see the entries below) |
| MCP clients | `page_create` and `autofill` descriptions, the `act`/`plan`/`autofill` output schemas (`navigationObservation`) and the `scope` tool's output schema changed (catalog digest changed); `create`'s input schema is unchanged |
| Requests already using `policy` with known fields | unchanged |

### Security — scope rules bind exactly the hosts they name (T10)

- A `pathRules` entry whose `hostSuffix` had uppercase letters or a trailing dot bound no host,
  so its path restriction silently disappeared and every path on that host was in scope. Every
  configured host (`allowedHosts`, `pathRules[].hostSuffix`, `identityBindings[].allowedHosts`)
  is now lowercased and stripped of trailing dots; the scope status reports the normalized form.
- A path-rule `prefix` must start with `/`, and a `hostSuffix` must be an ASCII hostname or
  `.suffix` (punycode for IDNs) or a bracketed IPv6 literal: no scheme, port or Unicode. A path
  rule whose host binds none of the `allowedHosts` is refused too (`400`, `scope.unbound`): it
  would leave that host's paths unrestricted. The MCP catalog digest changed (the `scope` tool's
  output schema).

### Docs — the site matches 1.23.0 and the T10 plan

- Home: the 1.21–1.23 engagement features, a "testing beyond what is authorized" row, T0–T10
  status (T10 in progress), defaults stamped 1.23 (unchanged values).
- Release milestones: a release history 1.14.0–1.23.0 (date, main commit, headline, record) and
  the 1.24.0–1.26.0 plan, above the earlier checkpoints.
- Spec overview: baseline 1.23.0 (was 1.10.0). Operations: engagements get their own heading.

### Changed — engagement scopes refuse fields they cannot enforce (T10)

- `policy.scope`, its `pathRules` entries and its `identityBindings` entries now reject unknown
  fields with `400` instead of ignoring them. A scope may only narrow; an ignored restriction
  (for example an exclusion a newer client sends to an older server) would silently widen it.
  Servers before this release still ignore unknown scope fields: verify what is in effect with
  `GET /v1/sessions/{id}/scope` (CLI `scope status`).
- The same rule now covers the whole session-create request: unknown keys in the request,
  `policy` and `policy.approval` are refused (`400`). This includes policy fields sent at the
  top level (`blockedHosts`, `approval`, `allowDownloads`, …), which were honored there without
  validation; send them under `policy`.
- In-process embedders (`AgentBrowserService.createSession`) validate the scope and the approval
  policy too (`INVALID_REQUEST`, `scope.invalid` / `approval.invalid`): a value built at runtime
  never crosses the REST validator.

### Fixed — page creation failures and compact download receipts

- Page creation with a URL now fails when initial navigation returns blocked or timed out.
  Policy denials return HTTP 403, timeouts 504, and other navigation failures 500, with only a
  bounded reason and recognized scope code. Cleanup removes only the newly created page;
  human takeover retains its ownership. No automatic retry is introduced.
- CLI `download` and `download collect` with `--out` emit one compact receipt after the private
  file save completes. Artifact retrieval or save failures emit no success record. Empty files
  are valid, and the saved byte count reflects the written content. Download errors use bounded
  messages and validated details, including JSON on stderr under `--json`.

### Fixed — autofill stops on observed navigation denials

- Autofill preserves bounded `navigationObservation` evidence and the action ID on the affected
  field receipt, then stops remaining widget actions and fields with `AUTOFILL_NAVIGATION_BLOCKED`.
  Skip and retry policies cannot resume writes. Completed actions do not establish exact field
  verification: interrupted exact or multi-action fields remain `uncertain`; a completed native
  `verify: none` action remains `unverified`, while the overall report fails. Post-effect action
  errors retain their original bounded error code alongside any navigation evidence.
- Previously verified fields still receive a final read-only check, and confirmed chip effects
  remain in partial receipts. Durable operations preserve unknown outcomes for uncertain fields.
  CLI and both MCP protocols retain the evidence; CLI text explains the stop without field values.
  Evidence is limited to the action dispatch window and does not establish navigation causation.

### Fixed — popup closure during adoption

- Pages that close during registration are refused without leaving page inventory, download
  state or engine listeners. Cleanup is initialized before synchronous removal can run.
- Popups that close before adoption finishes are not announced as available pages. Browser-owned
  closure uses the same named-handler cleanup as explicit closure and preserves caller handlers.

### Added — observed navigation denials on completed actions

- Playwright actions can return a bounded `navigationObservation` containing `status: blocked`,
  `reason: egress_policy`, a recognized scope code, and `observedDuring: action`. This reports
  a main-document request observed during dispatch; it does not prove the action caused it.
  No URLs, bodies, headers, or driver messages are included. Stale requests, other frames/pages,
  ambiguous chains, overlapping actions, and concurrent direct navigation are excluded.
- Completed actions keep `status: success` and their action ID. Follow-up waits/observations are
  skipped when this evidence is present. Required fill verification still takes precedence:
  missing verification evidence retains its nonretryable post-effect unknown outcome.
- Plans and action batches retain the completed step, count it in `completed`, and stop before
  the next step with `PLAN_NAVIGATION_BLOCKED`; they do not replay the action. Outcome runs
  cannot report a pass for that stopped plan. REST, SDK, CLI and MCP preserve the evidence.
- Observation adds no settlement wait. A denial arriving after dispatch is not reported on that
  action or a later one; absence is not a navigation-success claim. Explicit navigation and wait
  actions retain their existing behavior.

### Fixed — scope denial reporting for page creation and downloads

- Creating a page with an initially allowed URL that redirects outside its scope now returns
  `POLICY_DENIED` with a validated scope sub-code and removes the new page. Sibling pages remain
  available. Generic blocked and timeout outcomes now use the same failure cleanup path.
- CLI `page create --json` emits bounded JSON navigation errors on stderr and exits 1. MCP
  `page_create` uses the same bounded navigation-error projection on both supported protocols;
  neither projection includes raw driver prose, URLs, or arbitrary error details.
- Direct download errors retain recognized scope sub-codes through connection and transfer
  sanitization, including redirect denials. Existing stages and generic messages remain.
- CLI download errors use the bounded formatting described above.

## [1.23.0] — 2026-10-17

Entries are newest first. T10 milestone M2 completes: the engagement ledger. **Upgrading from 1.22.x:**

| Who | What changes |
| --- | --- |
| Operators | opt in with `AGENTBROWSER_ENGAGEMENT_DIR` (an existing, canonical, owner-only `0700` directory; refused on Windows) and optionally `AGENTBROWSER_ENGAGEMENT_MAX_BYTES` (integer 1 MiB–1 GiB, default 64 MiB; needs the directory); an invalid value of either aborts startup. Unset: no ledger, nothing written |
| Session create with `policy.scope.ledger: true` (new field) | refused `400` when no directory is configured, with `allowDownloads`, or on an engine without request recording; `500 INTERNAL` (`scope.ledger.unavailable`, session closed) when the ledger file cannot be created, e.g. the directory was removed or re-permissioned after startup; otherwise the session view carries `engagementId` |
| Ledgered sessions | fail closed: a full or unwritable ledger stops all traffic with `SCOPE_LEDGER_UNAVAILABLE`; `GET /v1/sessions/{id}/scope` gains an optional `stopped` reason |
| TypeScript consumers | `SCOPE_LEDGER_UNAVAILABLE` is a new member of the scope sub-code and navigation-failure unions: exhaustive `switch`es need a case |
| REST / SDK / CLI clients | new `GET /v1/engagements/{id}` (tenant-scoped; keyless `401`), SDK `engagements.export`, CLI `engagement export` and offline `engagement verify` |
| Engine embedders and capability readers | `EngineSessionOptions.requestRecorder` and the `requestRecording` capability are new optional fields; the Playwright engine reports `requestRecording: true` |
| Sessions without a ledger | unchanged |

### Fixed — an engine crash keeps the ledger's close-time records (T10 M2)

- On an engine crash the session now stops the scope, terminates the engine session, and only
  then closes the ledger, so the engine's close-time records (POST/PUT/PATCH outcomes never
  observed) are written. The closing record carries `crashed: true` and `scope.stopped:
  "engine crashed"`. Previously the ledger closed first and those records were lost uncounted.
- The crash-path close is tracked like any ledger close: `closeSession` and service shutdown that
  start during crash recovery wait for it. (A crash detected while an explicit close is already
  in progress can still close the ledger before that engine close's sweep.)

### Tests — the release smoke covers the engagement ledger (T10 M2)

- `scripts/scope-consumer-smoke.mjs` runs a ledgered session (in-scope navigation and a POST
  redirected out of scope), exports it over REST, verifies it with the released CLI
  (`engagement verify`), and checks that an edited copy is refused.

### Added — export and verify engagement ledgers (T10 M2)

| Need | Surface |
| --- | --- |
| export a ledger (NDJSON, verbatim; open or closed; across restarts) | `GET /v1/engagements/{id}`, SDK `engagements.export`, CLI `engagement export [--out]` |
| verify a ledger offline | CLI `engagement verify FILE` (exit 1 when the chain is broken) |

- Tenant-scoped: the file path is derived from the caller's tenant, so another tenant's id is
  `404`. Keyless deployments get `401` (no credential names a tenant). `--out` creates the file exclusively, mode
  0600, and verifies it.
- The chain format and verifier now live in `@agentbrowser/core`, shared by the server-side writer
  and the CLI.

### Added — the engagement ledger (T10 M2)

- `policy.scope.ledger: true` records a scoped session's traffic decisions in an append-only,
  hash-chained JSONL file under the operator's `AGENTBROWSER_ENGAGEMENT_DIR`
  (`AGENTBROWSER_ENGAGEMENT_MAX_BYTES`, default 64 MiB). Metadata only: no bodies, no query
  strings, no identity marker values. Records: `engagement.opened`, `request`,
  `preflight.denied`, `engagement.closed`. The hash chain detects edits, removals and reorderings
  that do not rewrite it from that point; it is not keyed or anchored, so whoever can write the
  file can rewrite it (see the operator guide's limits).
- Fed by an engine request recorder that sees every outcome before page attribution (popups not
  yet adopted, workers); the redirect guard records each response of a POST/PUT/PATCH chain.
  A POST/PUT/PATCH whose end was never observed (aborted in a worker, or in flight at close) is
  recorded at close as `no outcome observed`; a GET in flight at the instant the context closes
  can go unrecorded (stated limit).
  Refused when it cannot record a lane:
  `allowDownloads` (`scope.ledger.downloads`) and engines without request recording
  (`scope.ledger.engine`).
- Fails closed: when the ledger is nearly full or cannot be written, the scope denies all further
  traffic with the new sub-code `SCOPE_LEDGER_UNAVAILABLE`; nothing is dropped silently.
- Refused with `400 scope.ledger.unconfigured` when the operator configured no directory; an
  invalid directory aborts startup. The session view gains `engagementId`.

## [1.22.0] — 2026-10-17

Upgrading from 1.21.x changes CLI capture defaults; use explicit inline options where needed.

### Changed — compact capture output and private artifact caching

- CLI screenshot, PDF, `page html`, and `artifact get` now save private files by default and
  return one compact receipt. **Upgrade:** pass `--inline` explicitly for content; HTML also
  accepts an explicit `--max-bytes`. Explicit `--out` files are created exclusively and are
  never overwritten. Signed artifact URLs are omitted from capture, trace and download receipts.
- The cache defaults to `~/.abrowser/artifacts`; `AGENTBROWSER_ARTIFACT_DIR` selects an explicit
  alternative, including a repo-local `.abrowser/artifacts`. Prune on save bounds recognized
  captures to 24 hours, 100 files and 128 MiB; `cache prune [--all]` supports manual cleanup.
  Private ownership records preserve user files and replacements, including matching names;
  parallel pruning tolerates already-removed entries. Limits are best-effort across processes;
  stale records and ownership-unknown partial files may need manual cleanup.
- MCP screenshot/PDF/HTML default to compact artifact references. A configured local artifact
  directory enables file receipts. The new `artifact` tool retrieves existing session artifacts
  with explicit bounded ranges (8 KiB default, 64 KiB maximum); image/PDF inline evidence uses
  media/resource blocks without duplicating base64 in metadata. Default QA catalogs now expose
  21 unbound tools and 18 delegated tools.
- REST/SDK capture transport is unchanged and may still transfer base64 to adapters. Canonical
  session/page IDs and credential strength are unchanged; no public ID acts as a bearer secret.

### Fixed — consumer recovery and partial-result evidence

- Autofill carries bounded stage diagnostics, cooperative timeout accounting and honest partial
  or uncertain outcomes. Completed writes are not replayed after ambiguous interruption.
- Observation and document reads use deadlines, clean up late handles and invalidate stale refs;
  fresh reads can recover after human verification without reloading or closing the browser.
  Duplicate-role binding is grouped, native checkbox state is verified, and visible text can
  be projected with `observe --text`.
- Popup receipts use canonical public page IDs and distinguish registered from unavailable
  outcomes. Navigation events report sanitized commit facts without claiming application success.
- CLI `--api-key-file` reads an owner-only existing credential on POSIX, with bounded validation
  and redacted errors; Windows fails closed for that option. Credentials are never shortened.
- Regression coverage includes large capture receipts, modern MCP media output, cache ownership
  and concurrent pruning, browser read recovery, large synthetic forms and authorization boundaries.
  [Consumer handoff](docs/consumer-field-handoff-2026-10-16.txt) records remaining limits: hard write
  cancellation, live-site qualification, shorter ID aliases and streaming transport remain open.

### Added — the MCP `scope` tool (T10 M2)

- `scope {sessionId}` returns the engagement scope in effect, budget used/remaining, expiry and
  denials by sub-code; `scope {sessionId, url, method?}` runs the dry-run check (no budget, no
  denial counted, identity bindings not evaluated). Structured output
  `urn:agentbrowser:scope-tool:v1`.
- In every browser profile (the final QA catalog has 21 unbound tools and 18 delegated tools); not in the application profile. The
  release smoke's pinned tool lists include it; the catalog is regenerated.

### Changed — wire-level scope denials carry the sub-code (T10 M2)

| Where a scope denies | Now carries `scope: SCOPE_…` |
| --- | --- |
| a redirect hop of a navigation (GET walker) | the navigate `blocked` result (REST, SDK, CLI, MCP), and the `request.failed` event |
| a redirect hop after POST/PUT/PATCH (the guard) | the `request.failed` event |
| the initial request (subresources, act-driven navigation) | the `request.failed` event |
| `page_create` with an out-of-scope url (its preflight) | REST/SDK `details.scope`; the MCP structured error at `error.details.scope`, the same place as `navigate`'s |

- Only a code from the protocol's `SCOPE_DENIAL_CODES` is carried; the navigate result schema
  (`NavigationStatus.scope`) is a closed union of those codes. OpenAPI and the MCP catalog are
  regenerated.
- An `act` that navigates out of scope still returns `success`; the denial shows in its events.
- Still without the sub-code (M2 follow-up): `page_create` with an in-scope url that redirects
  out (the create succeeds; only the event has it), downloads (`stage`/`transferFailed` only),
  and CLI `page create --json` (plain-text error).

### Added — scope status and a dry-run check (T10 M2)

| Need | REST | SDK | CLI |
| --- | --- | --- | --- |
| the scope in effect, budget used/remaining, expiry, denials by sub-code | `GET /v1/sessions/{id}/scope` | `sessions.scopeStatus` | `session scope` |
| would the scope rules allow this request now? | `GET /v1/sessions/{id}/scope/check?url&method` | `sessions.checkScope` | `session scope-check` |

- The dry run spends no budget and records no denial. It judges the host, path, method (default
  `GET`), expiry and budget rules; it does not evaluate identity bindings (it takes no headers),
  and the base policy and DNS still apply at the wire. `404 NOT_FOUND` when the session has no
  scope.
- Identity bindings report `{header, allowedHosts}` only: a marker value is never returned. The
  protocol's `EngagementScopeStatus` schema is closed, and a test validates the policy's real
  status against it.
- `EngagementScopePolicy` gains `status()` and `check()`; denials are counted by sub-code on the
  wire and in the navigation preflight. The MCP `scope` tool projects the same status and check.

### Changed — CLI and MCP navigate refusals carry the scope sub-code (T10 M2)

- A `navigate` (command or tool) refused by the scope preflight now reports which rule fired
  on every surface: `details.scope` (`SCOPE_HOST_DENIED`, `SCOPE_PATH_DENIED`, `SCOPE_METHOD_DENIED`,
  `SCOPE_IDENTITY_DENIED`, `SCOPE_EXPIRED`, `SCOPE_BUDGET_EXHAUSTED`) and the message
  `Navigation failed: egress_policy (SCOPE_…)`. REST and the SDK already did; the CLI and MCP
  projection (`navigationFailureDetail()`) dropped it.
- The projection stays bounded: only a code from the protocol's `SCOPE_DENIAL_CODES` list is
  carried, read once; anything else is dropped as before. The policy's `SCOPE_SUBCODES` is
  pinned to that list.
- Remaining M2 gaps are listed in the wire-level scope-denial section above.

### Docs — the 1.21.0 release record

- `docs/spec/evidence/release-1.21.0.md`: post-run verification of every channel and the scope
  smoke run on the extracted release candidate. The task README, T9 packet and T10 evidence name
  1.21.0 as the published baseline.

## [1.21.0] — 2026-10-16

Entries are newest first. T10 milestone M1: an engagement scope without holes. **Upgrading from 1.20.x:**

| Who | What changes |
| --- | --- |
| Scoped sessions, Chromium | redirects after POST/PUT/PATCH are checked hop by hop; each request pauses twice more (about 1.5× page-load time measured on a 51-request page); a popup whose first request is a POST (`target=_blank` form) is refused (`REDIRECT_UNCHECKABLE`) |
| Scoped sessions, Firefox/WebKit | POST/PUT/PATCH are refused (`REDIRECT_UNCHECKABLE`): their redirects cannot be checked there |
| Session create with a scope | `cdpAttach`, `allowServiceWorkers: true` and a `scope` outside `policy` are refused (`400 INVALID_REQUEST`) |
| MCP clients | the `create` tool's `scope` description names the service-worker refusal (catalog digest changed) |
| Engine embedders | `RequestPolicy.requireRedirectGuard` is a new optional port field, set by `EngagementScopePolicy`; an engine that cannot check redirects after POST/PUT/PATCH must refuse those requests rather than ignore it. In scoped Playwright sessions `newPage` returns once the page's guard is armed |
| Unscoped sessions | unchanged |

### Tests — engagement-scope release smoke (T10 M1)

- `scripts/scope-consumer-smoke.mjs` runs against local fixtures, from a checkout or an extracted
  release candidate (`--server-root …`):

  | Check | Surfaces |
  | --- | --- |
  | the out-of-scope host is reachable (control) | Node fetch |
  | service workers, `cdpAttach` and a top-level scope are refused with a scope | REST (rule ids); CLI and MCP (service workers) |
  | an out-of-scope navigation is a policy denial and never reaches the wire | REST, SDK, CLI, MCP |
  | a form POST redirected out of scope never arrives and is recorded as a blocked `request.failed` | browser session via the SDK; events via REST |

- Recorded gap, scheduled in M2: CLI and MCP navigate refusals report `egress_policy`, not the
  `SCOPE_*` sub-code REST and the SDK carry (`navigationFailureDetail()` keeps only the reason).

### Security — a scope refuses the lanes it cannot check (T10 M1)

| Create request | Before | After |
| --- | --- | --- |
| `cdpAttach` + `scope` | passed the options floor; the attach lane ignores the scope | refused, `400 INVALID_REQUEST` (`floor.cdp.options`) |
| `allowServiceWorkers: true` + `scope` | session created; service-worker fetches bypass the scope | refused, `400 INVALID_REQUEST` (`scope.lane.serviceWorkers`) |
| `scope` alone | unchanged | unchanged (service workers blocked by default) |

### Security — redirects after POST/PUT/PATCH are checked in scoped sessions (T10 M1)

- **The hole:** body-bearing requests pass to the browser natively (byte-exact uploads), and
  Playwright never routes their redirected follow-up. In a session with an engagement scope, a
  307 from an in-scope form POST re-sent the body to an out-of-scope host; a 302/303 sent a GET
  there.
- **The fix:** on Chromium, a guard checks every redirect hop of those requests (fresh verdict,
  hop cap, loop detection) and fails a denied hop before the browser follows it. Chains are
  tracked by Chromium's network id, so a rewritten URL (fragment, re-encoding) or two chains
  meeting at one URL cannot slip a hop. A body-bearing request its own target's guard did not
  see is refused (`request.failed`, `detail: REDIRECT_UNCHECKABLE`), including a popup's first
  request (a `target=_blank` form POST) and new ones while a target already tracks 4096
  in-flight chains; a live chain is never evicted.
  Policies opt in with `requireRedirectGuard`; `EngagementScopePolicy` sets it and the metadata
  floor carries it.

| Session | Before | After |
| --- | --- | --- |
| Scoped, Chromium | redirect hops after POST/PUT/PATCH unchecked | every hop checked; each request pauses twice more (about 1.5× load time on a 51-request page) |
| Scoped, Firefox/WebKit | same hole | **POST/PUT/PATCH refused** (`REDIRECT_UNCHECKABLE`) |
| Unscoped | native passthrough | unchanged |

### Docs — T10 engagements plan and record hygiene

- New task packet T10 (`docs/spec/tasks/t10-engagements.md`): engagements (scope without holes,
  status and a metadata-only ledger, program scope and findings) and saved plan runs, each
  milestone released (1.21.0–1.24.0). Registered in the task index and manifest.
- Review findings R01, R02 and R12 annotated closed; stale lines fixed (T9 "develop unprotected",
  the delivery audit row, the TD-BROWSER-12 status).

### Docs — the 1.20.0 release record

- `docs/spec/evidence/release-1.20.0.md` records the first release under the R14 gates and the
  post-run verification of every channel (attestations on all 16 assets, immutability, owner
  npm approval, Homebrew, the winget branch). The task README, T9 packet and R14 entry name
  1.20.0 as the published baseline and immutable releases as on.

## [1.20.0] — 2026-10-16

Entries are newest first. **Upgrading from 1.19.x:**

| Who | What changes |
| --- | --- |
| Agents | Pages with `<details>` now return `html-summary` rows on every `observe`. Element counts change. Rows from `include:["fileInputs"]` / `include:["formControls"]` get new ref numbers (they follow the new rows). Under a tight `maxElements`, the new interactive rows can displace rows 1.19.0 returned. Re-observe; never reuse refs across versions. |
| Operators with a policy file | Its `approvalRules` now take effect: rules classifying a control as high risk now require approval. Startup now **refuses** a rule id that is invalid, reserved or duplicated, and a rule `decision` that no policy reads. |
| Release consumers | Releases are drafted, then published. Every asset carries a signed build-provenance attestation (`gh attestation verify`). Releases are immutable from 1.20.0. npm publication pauses for the owner's approval. |

### Fixed — a disclosure whose state cannot be read refuses fast

- The act-time `open` re-check is bounded to one second. An engine that cannot resolve the
  parent (Obscura) refuses with `STALE_TARGET` instead of waiting 30 seconds for the action
  timeout. The cap coverage entry no longer claims the frame snapshot is complete.

### Fixed — disclosure scan follow-ups

- When a CDP accessibility call fails, the disclosure scan now falls back to the validated page
  scan instead of minting nothing. This happens on CDP engines without those domains (Obscura)
  and on a Chromium page whose DOM changed mid-scan.
- Coverage entries about the main frame are labelled `main`, not by URL. The cap entry says the
  frame snapshot itself is complete.

### Fixed — native disclosures are targetable controls

- `observe` now reports each `<details>` element's first `<summary>` as role `html-summary`
  (HTML-AAM's computed role; never forced to `button`). It carries its accessible name and an
  `expanded` state from `details.open`, and binds a ref that `click` or `press Enter` / `Space`
  toggles.
  - Before, Playwright's snapshot dropped the summary, so only `{role:"group", value:"…"}`
    remained.
  - Not a regression: Playwright 1.62.1 and 1.64.0 behave the same.
- On Chromium, name, role and state come from the browser's own accessibility tree, so they
  match what Chromium exposes and page scripts cannot change them. Other engines and frames use a
  DOM scan validated in Node.
- A disclosure toggled by page script since the observation is refused (`STALE_TARGET`).
- The scan never fails `observe`; more than 200 per frame is reported. The CLI shows
  `[expanded]` / `[collapsed]`.
- Protocol: page elements gain an optional `expanded` boolean (also in `sinceRevision` diffs).
- New docs page "Observation gotchas" catalogues where `observe` differs from the browser's
  accessibility tree, starting with this case.

### Fixed — a policy file's approval rules classify actions

- With `AGENTBROWSER_POLICY_FILE`, the document's `approvalRules` were never applied: they fed
  only the document version, and the environment approval policy is refused alongside a file.
  So no rule could mark a control as a transaction and require approval. The file's rules now
  classify every action before Cedar decides (pinned by `policy-file-approval-rules.test.ts`).
- Compatibility: a policy file now refuses startup when an approval rule's id is invalid,
  reserved or duplicated (it was never checked before), or when a rule carries a `decision` that
  no policy reads through `context.matchedRule` (it was silently ignored).

### Docs — a secure starter policy and how to configure policy

- `examples/policy/secure-starter.json`: an opinionated, deny-leaning Cedar policy to copy.
  - Loopback and private networks denied; public web via the floor.
  - Reads, local writes and unclassified actions allowed; actions your `approvalRules`
    classify as high risk need owner approval.
  - Cookie export, cookie handoff, service workers, downloads and CDP attach denied; headed
    sessions and cookie seeding allowed.
- `docs/policy.md` opens with "Start here": a decision-flow diagram (egress and actions), a
  table of each decision and why, how to classify risky controls, per-tenant loosening
  recipes, and how to verify.
- A test loads the starter through the real loader, pins its decisions and rule ids, and
  proves the documented recipes.
- Release recovery (operations guide): when only the final publish fails, publish the draft by
  hand and do not rerun; generate the winget manifests with `scripts/winget-manifests.mjs`. The
  `release.yml` comment says immutability applies once the repository setting is on.

### Changed — release hardening R14 closed

- `v*` tags: only repository admins can create, move or delete them (ruleset).
- npm publish: pauses for the owner's approval; deploys only from a `v*` tag.
- Every release asset gets a signed build-provenance attestation
  (`gh attestation verify <file> -R anvai-labs/agentbrowser`).
- Releases are drafted, filled, then published; repository immutable releases are on from
  1.20.0.
- With the main-ancestry tag guard this closes R14; the operations guide's release section has
  the table of gates.

### Docs — the 1.19.0 release record

- `docs/spec/evidence/release-1.19.0.md` records the release and the post-run verification of
  every channel (assets against `sha256sums.txt`, versions inside the artifacts, npm, the docs
  site, the Homebrew tap); winget was not submitted (no credential configured). The task
  README and T9 packet now name 1.19.0 as the published baseline; the operations diagram gains
  reconcile → `failed`, and the execution spec labels its normative rules as such.

## [1.19.0] — 2026-10-16

Entries are newest first, and an entry supersedes the entries below it: the durable journal
landed in slices, so an older (lower) entry's "not yet" or "proposed" (C4b's refusals, J3/J4
"proposed", B-dur-1/2a "not yet used") is resolved by a newer (higher) entry in this same
release — 1.19.0 ships the wired journal, lookup and recovery (J3, J4) and browser durability.

### Docs — the site matches the release

- Every page under `docs/` is now in the site navigation (37 were unreachable, including the T5
  recovery and browser-durability designs, the journal runtime evidence, ADR-026 and the
  1.15.0–1.18.0 release records). Internal handoff notes, the ADR template and the agent skill
  file are excluded instead, and the strict build now **fails** when a page is missing from
  the nav, so the site cannot drift again.
- Operations gains a visual "Durable operations and recovery" overview: a record-lifecycle
  diagram and tables for application versus browser durability and for who can read or recover.
- Stale claims fixed: the CLI guide's "durable recovery: planned", the delegated-sessions,
  bulk-autofill and comparison pages' "records disappear on restart" / "journal under
  construction", the home page's status line, the quality spec's "future journal contract", and
  the execution spec's event sync (now a table: what is built, no recovery across a restart by
  decision D4, and the not-yet-built target cursor contract).

### Fixed — journal review follow-ups (T5)

- `journalReconcileTimeoutMs` outside 1..2147483647 (or not an integer) is refused at service
  construction; before, `setTimeout` fired at once and every reconcile counted as unresolved.
- Adapter `reconcile` functions are captured only after the application authority has validated
  the adapters, so a null entry gets the authority's typed `INVALID_REQUEST` refusal instead of a
  `TypeError` (duplicates were already refused by the authority).
- The lookup route's documented `operationId` pattern now matches the route's check exactly.
- A journal test child no longer pipes output nobody reads (it could block on a full buffer), and
  its leftover debug logger is gone.

### Changed — task status table refreshed

- The task README's status rows for T0, T1, T3, T5, T6, T8 and T9 now match develop; the
  continuation note says everything since the #483 back-sync is unreleased; the stale 1.15.2-era
  "Next items" sections are replaced by one current list of owner- and infrastructure-gated
  items; the T6 packet no longer lists delivered W2, W3a and W3b work as open.

### Changed — T5 records reflect browser durability

- `docs/spec/review.md` R08, the task README's T5 row, the T5 packet and the recovery design now
  record the browser portion as narrowed to classification (never replay; receipt contents are
  never journaled, so R08's autofill-receipt part stays open by design). T5's remaining items
  are per-host deployment by the operator and the optional, unscheduled constrained-mount depth.
- Process-loss rows now cover every durable browser owner (act, plan and autofill) at each
  boundary, and pin the operator's recovery on the record each kill left: close for an
  undispatched one, settle for an in-doubt one, reconcile refused.

### Fixed — a plan no longer re-runs a step whose follow-up read failed

- A plan step whose effect ran but whose follow-up read failed (for example a click that closed
  its page, then `observe: 'after'`) could be retried by the stale-target self-heal when the
  error message matched, running the effect a second time. Such a failure is never healed now.

### Added — durable browser parity and crash rows (T5 B-dur-2c)

- SDK (`executeAction`, `plan`, `autofill` mutation options), CLI (`--execution-requirement` on
  `act`, `plan` and `autofill`) and MCP (`executionRequirement` on the `act`, `plan` and
  `autofill` tools) carry the durable browser requirement; omitted, every request is unchanged.
- Process-loss rows for a durable browser act on a real store: killed before the marker, after
  it, and after the click, the record holds the expected state, the click ran at most once, and
  nothing is replayed on reopen.

### Added — durable act, plan and autofill (T5 B-dur-2b)

- `act`, `plan` and `autofill` accept `executionRequirement` over REST (OpenAPI documented).
  `durable` journals the call as one browser operation for classification only, never replay:
  controlled sessions with an open journal only (`CONTROL_REQUIRED` otherwise). The target and
  approval are re-checked after the journal marker and before the first effect; the approval is
  consumed only after that, and a refused operation never self-heals. Failures known to occur
  before any effect keep their response (`failed`); anything else (a lost step result, an
  unverified fill, an uncertain field) is recorded `settled_unknown`, and its report is still
  returned. `ephemeral` is identical to omitting the field; other routes refuse the field.
  SDK, CLI and MCP parity: B-dur-2c.

### Added — the browser journal in the control layer (T5 B-dur-2a)

- The session authority can journal a durable browser operation as one record under the
  reserved `browser` identity (its own fingerprint domain): the marker at the first page
  dispatch, then the owner's recheck once, then the effects. A failed recheck crosses no effect
  (`failed`, dispatched); a known failure keeps its report; an operation with nothing to dispatch
  keeps its result. Not yet used by the service (B-dur-2b).

### Added — browser-durability revalidation primitives (T5 B-dur-1)

- The application adapter id `browser` is reserved for browser-operation journal records.
- The act approval check is split into a decision and a deferred consumption, with a
  non-consuming currency check for leases, plain tokens and reviewed approvals
  (`ApprovalGate.validateReviewedApproval`); plain acts behave exactly as before.
- `ActionExecutor.revalidateTarget` and an autofill `onRecheck` port expose the target and
  scoped-stage checks to run after a storage wait. Durable browser operations (B-dur-2) will use
  them; nothing is journaled yet.

### Docs — browser-operation durability, the settled choices (T5 B-dur, accepted)

- A design addendum settles the implementation choices D6 left open, accepted by the owner:
  browser operations are journaled only on request (`executionRequirement: 'durable'`, controlled
  sessions only), as one record per operation with the marker at the first page action, after an
  asynchronous owner-level recheck whose remaining window is disclosed (the approval token is
  consumed only after the marker), sharing the namespace's capacity, under a reserved `browser`
  application identity (no store-format change). Known step or field failures stay `failed` with
  their report returned, never `JOURNAL_UNAVAILABLE`.

### Added — continue and reconcile for journaled operations (T5 J3c part 2)

- A new operation may carry `supersedes: {namespace, operationId}` naming the closed operation it
  continues, on execute and review requests and via `application execute --supersedes <id>
  --supersedes-namespace <ns>`. It is provenance only: consent covers it (a reviewed write
  executed with a different link is refused), the operation identity does not include it, and it
  is not journaled or receipted — a non-reviewed write's link leaves no durable trace. The server
  does not verify the named operation.
- `POST /v1/journal/operations/{operationId}/reconcile` (operator key only) asks the bound
  adapter's new opt-in `reconcile(identity)` what happened to each in-doubt record: `committed` or
  `rejected` commit the matching terminal; `unknown`, a malformed answer, or a call slower than
  10 s changes nothing. An adapter without `reconcile` is refused with 409 `CONTROL_REQUIRED`
  before anything is written — settle instead. Nothing is ever replayed.

### Added — journal history namespaces after rotation (T5 J3d)

- `AGENTBROWSER_JOURNAL_HISTORY_FILE` lists namespaces you rotated away from, each with its
  original descriptor inputs and key file. They open on the same store, stay searchable by
  lookup and recoverable by the operator (close, settle, reconcile commit in the namespace that
  owns the record) until `retainUntil`, and never accept new writes.
- `GET /v1/journal` lists them (`history`, with `refused` and the store's reason for a wrong
  entry, which never stops the current namespace). Lookups report any namespace they could not
  read in `unreadNamespaces`, and are never `absent` while one is unread.
- The server warns at startup within 7 days of a history namespace's `retainUntil`.
- A namespace past its `ACCEPT_UNTIL` is opened recover-only: no durable writes, but its records
  stay readable and recoverable until retention ends. History entries are opened only once their
  horizon has passed (an early or typo'd entry is reported and never creates a namespace).
- `agentbrowser journal status` lists history namespaces; `journal operations` names each
  record's namespace and any namespace it could not read.

### Tests — recovery gates for application writes (T5 J4)

- A service restarted on the same real store refuses a pre-restart event cursor as
  session-not-found: events and cursors are not recovered, never silently reset, never replayed
  from the journal.
- The non-business write classification is recorded as the delivered rule, and R08's
  application-write portion and R10's durable-receipt portion are marked delivered (the
  browser/autofill portion stays open for B-dur).

### Added — operator-only journal recovery writes: close and settle (T5 J3c part 1)

- `POST /v1/journal/operations/{operationId}/close` closes every never-dispatched record of the
  operation as a failed pre-dispatch terminal carrying a supersession marker. Dispatched work
  refuses: it is settled or reconciled, never closed.
- `POST /v1/journal/operations/{operationId}/settle` settles every in-doubt record as terminal
  `outcome_unknown`, claiming nothing about the effect. Irreversible.
- Both are OPERATOR KEY ONLY per the accepted design (D1 as amended): a tenant API key may read
  history and is refused here with 403 — pinned at the service and HTTP layers. Tenant-scoped;
  another tenant's operation is not found, never writable. Rate-limited per tenant.

### Added — staged form mappings (T6 W3a)

- A form mapping document may carry 1-12 stages, each exactly the single-stage shape with its own
  distinct scope URL. `form prepare <mapping> <values> [stageId]` materializes the chosen stage;
  values must match the union of every stage's keys; `form stages <mapping>` lists the stages
  offline. Single-stage documents are unchanged. Which stage applies to the page in front of the
  caller stays caller-observed — the scoped preflight refuses a stage whose fields are not all
  present — never inferred from business state.

### Added — read-only journal lookup and status (T5 J3b)

- `GET /v1/journal/operations/{operationId}` returns every historical record of one durable
  operation in the configured namespace, projected to a classification (`undispatched`,
  `in_doubt`, `failed_before_dispatch`, `completed`, `failed`, `settled_unknown`), an
  `actionable` flag, application identity and the departed session's opaque identity. Per the
  accepted design (D1 as amended), it accepts the operator key or a tenant API key, read-only and
  tenant-scoped; delegated grants are refused and keyless deployments get no surface. Absence is
  scoped absence, never proof of non-execution.
- `GET /v1/journal` reports the journal's configuration, namespace, health, horizons and an
  advisory `recoveryQualified` (Node 24 on Linux/macOS only; no exactly-once promise).
- Both routes are rate limited per tenant, in the regenerated OpenAPI, and exposed by the SDK
  (`journalStatus`, `journalOperations`) and the CLI (`agentbrowser journal status`,
  `agentbrowser journal operations <id>`).

### Tests — the durable-restart claims qualified (T4 A2)

- Two service instances (fresh authorities and storage children) run one after the other on the
  same real journal store; the first stops gracefully. A completed
  durable write survives the graceful restart and stays readable through the new process's own
  journal handle; nothing replays; and re-submitting the same operation ID commits a NEW record
  with a new service generation — the advertised weaker outcome, with idempotency remaining the
  adapter's responsibility.

### Added — journal `findByOperation` (T5 J3a)

- The operation journal port can now find every record of one tenant's operation ID in a
  namespace. The query is read-only, fenced, at most 16 records, in order, and reports
  truncation.
- It is implemented by the memory and SQLite adapters (a bounded scan, no schema change),
  validated by the facade (an adapter cannot leak another tenant's records), and covered by the
  shared conformance suite.
- It is the read path for the accepted J3 historical lookup.

### Added — measured CI runner minutes (T9)

- `scripts/runner-minutes.mjs` reports per-workflow medians from the GitHub API: wall time, job
  minutes, and billed-style minutes split by hosted and self-hosted runners. It is read-only.
- The 2026-10-15 baseline is recorded in `docs/spec/evidence/t9-runner-minutes.md`: about 26
  hosted minutes per CI round on a pull request (CI, Windows and docs), plus about 2 macOS minutes on journal-path
  pull requests. The repository is public, so these are capacity, not cost.

### Tests — widget strategies qualified on Firefox and WebKit (T6 W3b)

- The real react-select qualification (add-only and exact chip sets, with the app's state as the
  oracle) now runs on Chromium, Firefox and WebKit through the Playwright engine. All pass, with
  no engine-specific code.

### Docs — T5 recovery design accepted (J-design sign-off)

- The owner accepted `docs/spec/design/t5-recovery-design.md` on 2026-10-15. D1 is amended:
  historical lookup accepts the operator key **or** a tenant API key (read-only, tenant-scoped),
  so it also works in multi-tenant keyed deployments.
- Writes stay operator-only: close and continue (D2), and reconcile and settle (D3).
- D2–D7 are accepted as recommended. Implementation follows: J3a → J3b → J3c → J3d → J4 →
  browser-operation classification.

### Added — exact chip sets with removal for `chip-multiselect` (T6 W2)

- An autofill field can set `options: { values: [...], mode: 'exact' }`, with
  `strategy: 'chip-multiselect'`. The control's committed membership must end exactly that set.
- **How it writes.** Extra chips are removed one at a time, through the remove control the engine
  ties to that combobox and chip label, and each removal is confirmed. Missing values are added
  through the existing typeahead.
- **Receipts.** A receipt reports `effects: { removed, added }`, including on failure. Nothing is
  rolled back by guesswork.
- **Refusals.** Refused before any dispatch on a control that is not a proven multi-value widget,
  or whose membership is incomplete, duplicated, or has an extra chip without exactly one owned
  remove control. Values must be non-blank and trimmed.
- Qualified against the real react-select 5.10.2.

### Tests — process loss through the service with the durable journal (T5 J-e)

- The compiled service, with the real SQLite journal, is SIGKILLed before the intent, after the
  intent, after the marker, after the effect and after the terminal of a durable write.
- Each case leaves the expected record (none / undispatched / in doubt / in doubt / completed),
  proven by a store read inside the process before the kill. The independent effect counter never
  exceeds 1.
- The next process reopens the same namespace, with the full service, and replays nothing.
- Key loss and in-place key rotation are refused at startup as a configuration mismatch, without
  exposing key material.

### Added — a CI entrypoint for `test evaluate` (T3)

- `.github/actions/test-evaluate` is a composite GitHub Action that other repositories can pin.
  - It installs a release CLI and verifies it against the release's `sha256sums.txt`, so a
    corrupted or mismatched download is never run. The check does not prove the release itself is
    authentic.
  - It evaluates a directory of caller-observed test-case bundles offline and writes JUnit,
    carrying identities and verdicts only.
  - It fails the job unless every bundle passed.
- Qualified with a stub CLI and against the compiled CLI in CI. It executes nothing itself:
  test execution stays with the caller's job.

### Added — a repeatable real-ZAP recorded run (T7 depth)

- `scripts/zap-depth-run.mjs` runs the ZAP adapter against a real OWASP ZAP daemon and its own
  deliberately vulnerable fixture. It archives the result, sanitized raw alerts and the fixture
  source, and fails unless the seeded reflected XSS is found and every finding stays
  `suspected`.
- The dispatch-only `zap-depth.yml` workflow runs it in CI with the digest-pinned ZAP image.
- First run (2026-10-15, ZAP 2.17.0): the seeded XSS plus four header and DOM findings, archived
  under `docs/spec/evidence/t7-zap-depth/`.

### Docs — proposed: T5 recovery design (J3, J4, browser-operation durability)

- `docs/spec/design/t5-recovery-design.md` (Proposed, awaiting the owner's sign-off) refines J3
  and J4 on top of the wired journal. It has seven decision points:
  - D1: operator-only historical lookup;
  - D2: close or continue only never-dispatched records, closed as marked pre-dispatch failures;
  - D3: an unknown outcome is resolved only by an opt-in, typed adapter `reconcile` bound to the
    original operation, never by replay; the operator may also settle it as unknown;
  - D4: events and cursors are not recovered;
  - D5: recovery status for operators on the qualified matrix;
  - D6: browser operations journaled for classification only, which narrows R08;
  - D7: opt-in history namespaces after rotation, with full-descriptor entries and a stated
    retention deadline.
- It states what records do not hold (no times), what a new recovery write path needs, and that
  the lookup is a bounded scan with no new DDL. Nothing is implemented.

### Added — durable application writes behind an opt-in journal (T5 C4b, J-d)

- **Configuration.** Trusted variables open the qualified SQLite journal at startup:
  `AGENTBROWSER_JOURNAL_DIR`, `_ANCHOR_DIR`, `_KEY_FILE` (a `0600` file holding `keyId:hex`),
  `_RESTORE_GENERATION` and `_ACCEPT_UNTIL`, plus optional `_NAMESPACE`, `_MAX_RECORDS` and
  `_INITIALIZE`. A partial or refused configuration aborts startup; unconfigured, nothing changes.
  The namespace is stable across restarts, so records survive; its horizon and bounds are
  immutable, and you rotate by naming a new namespace.
- **Behaviour.** Application writes that request `executionRequirement: "durable"` are journaled:
  the intent is committed before the effect, then a dispatch marker and a terminal record. The
  fingerprint domain is labeled `application-operation:v2-durable`, so it never collides with an
  ephemeral identity. Ephemeral writes never touch the journal.
- **Availability.** Discovery advertises `durable`, and execute and reviews accept it, only while
  the journal is open and before the accept horizon. Otherwise `CONTROL_REQUIRED`, with no
  fallback. The application authority now also refuses `durable` itself whenever the write cannot
  be journaled; previously only the service-level refusal stood in the way.
- **Reviewed writes.** Durable operator-reviewed writes are approvable end to end.
- **Shutdown.** With a journal attached, a graceful shutdown drains in-flight durable work,
  bounded at 30 s, before the journal closes. Nothing else waits. Once the accept horizon has passed, the server starts without the journal and
  warns, rather than refusing to start. The journal needs Node 22.13 or later.
- **Deprecation.** `durableJournalAvailable` is deprecated and has no effect.
- **Not yet.** Reading records back across a restart (J3) and recovery semantics (J4) remain
  proposed.

### Changed — observation is faster on element-heavy pages (F2)

- The Playwright engine now binds observed elements to their nodes with bounded concurrency (8),
  instead of one at a time, and resolves each node in one round trip. Each element's steps and its
  document-order ordinal are unchanged, and every binding settles before cleanup.
- On the 120-element benchmark an observation drops from ~1.2 s to ~0.5 s in **Chromium** (about
  2.3×, from an interleaved A/B in one session), with identical password redaction. The review
  measured about 1.8× in Firefox and 1.1× in WebKit.
- An element's aria capture is bounded to a 500 ms slice. A node renamed between being resolved
  and being captured therefore degrades to document evidence and reports a page change; it no
  longer waits out the whole ~5 s snapshot envelope.
- Recorded in `docs/spec/evidence/observation-120-baseline.md`.

### Docs — proposed: policy reload without restart (ADR-026)

- ADR-026 (Proposed) and TD-BROWSER-15 phase 8 (Proposed) design an opt-in reload of the Cedar
  policy file through one endpoint guarded by a server-scope admin key held in a file (no signal:
  `SIGHUP` stays shutdown). The new document is validated before the swap and never fails open.
  New sessions get the new policy; live sessions are decided by their pinned policy AND every
  policy loaded since, with limits taking the minimum, so per-call tightenings reach running
  agents and loosenings never do. Creation-time grants are reported, not revoked. Nothing is
  implemented.

### Added — a committed provider-CLI qualification driver (T8 Q1)

- `scripts/t8-harness-qualification.mjs` re-qualifies the MCP bridge through the installed Codex
  and Claude Code CLIs against a scratch service and a loopback fixture.
- Each provider is locked to the bridge: Codex's shell, exec and browser features are disabled,
  Claude runs `--restricted --tools ""`, and any other tool fails the run. Credentials never
  appear in a provider's argv.
- Each verdict comes from an independent oracle: the fixture's request log or the service's
  operation records, plus the event stream checked for the password value.
- Both providers pass every exercisable dimension (2026-10-15). Provider-path cancellation is
  recorded as not exercisable.
- Recorded observation: screenshot bytes reach the model inline, as base64 text.
- The T1 catalog footprint was re-measured after the output schemas.

### Added — the durable requirement is part of the operation identity (T5 C4b, part 2)

- A `durable` application write now has its own operation identity: its fingerprint uses the
  `application-operation:v2-durable` domain and names the requirement, so consent and replay can
  never cross requirements. Ephemeral fingerprints are unchanged byte for byte (pinned to golden
  hashes captured before this change). The operator review intent names a durable requirement;
  an ephemeral intent, explicit or omitted, is unchanged.
- `application reviews` accept `request.executionRequirement` (an explicit `ephemeral` is the
  default); the CLI's `application execute` takes `--execution-requirement ephemeral|durable`.
- Durable execution, and a durable review (which could never be executed), stay refused
  (`403 CONTROL_REQUIRED`, nothing reserved) until a durable journal is wired to the runtime
  (J-d), even with `durableJournalAvailable` set: that option currently has no effect.
- Known for J-d: the journal intent still labels every live fingerprint
  `application-operation:v1`; it must carry the durable domain once durable writes run.

### Added — the journal gates run on macOS (T5 J-f)

- `.github/workflows/journal-darwin.yml` runs the journal manager/child/adapter qualification and
  the packaging gate (package the server for the runner's target, then prove the extracted
  candidate resolves the storage child) on `macos-15`, nightly on the default branch (`main`) and
  on pull requests that touch journal code or its dependencies (including `.tool-versions`, which
  pins Node and its SQLite). It is deliberately not a required check: it is path-filtered on pull requests,
  and a path-filtered required check would strand unrelated ones (the T9 packet's invariant now
  says so).

### Added — autofill qualified against the real react-select (T6 W1)

- The `react-select` and `chip-multiselect` strategies are now tested against react-select 5.10.2
  on React 19.3.0 in real Chromium, not only markup that imitates it. The app reports its own
  committed state, which must show the exact option (`Chicago`, not `Chicago Heights`) and no form
  submission. The qualification uses react-select's `classNamePrefix: 'select'`: the strategies
  read the committed selection from `select__*` class names (see `docs/bulk-autofill.md`), and on
  react-select's default generated class names they fail closed rather than verify. The libraries
  are pinned test-only devDependencies of `@agentbrowser/api`; the shipped tarball and production
  dependencies are unchanged.

### Changed — `option.value` cannot contain a line break

- An autofill `option.value` with `\n` or `\r` is refused (`INVALID_REQUEST`) before dispatch, for
  every strategy: the custom strategies type the option text, and a typed line break is an Enter
  keypress that could commit an unintended option or submit the form (native selects never type,
  and no real option label contains one). It is refused rather than escaped; other control
  characters are typed literally and stay allowed.

### Added — a committed observation-overhead benchmark (F1)

- `node packages/benchmarks/dist/run.js observe [n]` observes a 120-element fixture (40 text, 40
  password, 40 buttons) through the service on real Chromium and prints latency (mean/p50/p95/max);
  it fails unless all 40 password fields are observed redacted and no password value appears.
  A baseline snapshot is recorded in `docs/spec/evidence/observation-120-baseline.md`; runs drift
  ~18% between sessions on the same host, so comparisons (F2) must interleave both builds in one
  session.

### Added — journal time never moves backwards within a process (T5 J-c)

- The SQLite journal child takes its time from `createJournalClock()`. Checks (fencing, admission
  and retention horizons) use `max(startWall + monotonicElapsed, wallNow, previousReading)`, so a
  backward wall-clock step mid-process can no longer extend a horizon; they can only become
  stricter. Everything that persists or deletes (the high-water, namespace retirement, the reopen
  rollback check) still uses the plain wall reading, so no persisted value derives from the
  monotonic source and restart behaviour is unchanged.

### Added — output schemas for the last six MCP tools (T0 M2, part 2)

- `policy`, `cookies`, `cookie_handoff`, `snapshot`, `html` and `session` advertise output
  schemas (`PolicyToolResultSchema`, `CookieListResultSchema`, `CookieHandoffToolResultSchema`,
  `PageSnapshotSchema`, `PageHtmlResultSchema`, `SessionInspectionResultSchema`), and so does
  the delegated `operation` tool (`OperationRecordResultSchema`): every MCP tool in every catalog
  now does. `policy` and `cookie_handoff` keep an object root with their two result shapes as
  alternatives. The nested session, control and operation views are relaxed for clients
  (`relaxForClients`: open objects, closed enums widened to strings, required fields kept), so an
  older MCP binary keeps accepting a newer server's results; the protocol schemas stay strict. Qualified end to end, including a real cookie handoff (approval relay, operator
  decision over HTTP, completion) and a handed-off session's view; a test fails if any tool lacks
  a schema.

### Fixed — `html` honours its byte cap; `cookie_handoff` reports an unsupported server as an error

- `html`'s `maxBytes` now bounds the returned UTF-8: it is taken in whole bytes, and a cut inside
  a multibyte character backs off to the character boundary instead of emitting U+FFFD, which
  overshot the cap by up to 2 bytes.
- `cookie_handoff` against a client without the handoff surface returned an error envelope as a
  successful result; it now fails as an error.

### Fixed — the T8 footprint gate measures the CLI's peak exactly

- `scripts/footprint-gates.test.mjs` sampled RSS by forking `ps` every 10 ms; the CLI's
  `--version` can exit before the first sample lands ("no RSS sample collected", seen on #474,
  #475 and #484), and polling can also understate a peak reached just before exit. The CLI
  one-shot is now measured exactly — `ru_maxrss` of the reaped child (wait4 rusage, via a
  python3 helper) — and must exit 0. The MCP bridge's idle-after-handshake peak is still polled,
  now reading `VmRSS` from /proc on Linux instead of forking `ps`. A stand-in allocating 40 MB and
  exiting at once reads 51.4–51.6 MB on every run.
- The bridge harness read stdout with one listener per request, all appending to one buffer, so a
  response spanning two pipe chunks (a `tools/list` over 64 KiB) never parsed and timed out. It now
  uses one shared line reader with a pending-request map.

### Docs — release records and task-status reconciliation

- Delivery records for 1.16.0, 1.16.1, 1.17.0, 1.17.1 and 1.18.0 (`docs/spec/evidence/`).
- The task table and manifest match the 2026-10-15 reconciliation: T1 is active, T7 complete, the
  Victor gate is aiserver1's gateway (not TLS), and C4b is partial. Stale "candidate" status lines
  on three delivered evidence records are corrected, C3b cites #254, the T9 checkpoint names the
  current protections, and the release guide no longer claims the upload permits clobbering.

### Fixed — the execution requirement as shipped (T5 C4b, part 1)

- An explicit `executionRequirement: 'ephemeral'` on `application execute` was refused as an
  invalid request; the authority's request normalizer now accepts it as the default made
  explicit and drops it behind its existing caller-data checks, so explicit and omitted requests
  share one operation identity (the second is a replay, not a conflict). `durable` is refused
  before any identity is reserved, and stays refused even with a durable store configured until
  it is part of the operation identity; discovery advertises only `ephemeral` until then.
- REST discovery (`GET …/application`) now publishes `writeExecution` (it was added only to the
  service's return value, which REST does not send), and "nothing bound" stays `null` instead of
  becoming `{writeExecution}`. `ApplicationDiscoverySchema` and OpenAPI document the field.

### Added — declared adapter output (T4)

- `defineApplicationOperation` accepts an optional `parseOutput(value)`. A value that does not
  match is never reported as success, and neither the adapter output nor the parser's message
  is echoed; a matching value is replaced by the parsed one.
  - A mismatched **read** is refused like any invalid read result (`400 INVALID_REQUEST`,
    `Invalid application output`).
  - A mismatched **write** has already run: it is an internal adapter fault (`500 INTERNAL`), its
    operation stays dispatched with `outcome_unknown`, and the same operation ID never executes
    again.
  - Rejected results skip the parser; operations without `parseOutput` are unchanged.

### Added — MCP request cancellation (T0/T8)

- The MCP server honours `notifications/cancelled`: the in-flight `tools/call` it names is
  aborted down to its HTTP request, and no response is sent for it (MCP 2025-06-18). A cancel for
  a finished or unknown request is ignored and re-runs nothing; `initialize` is never cancelled;
  concurrent calls are independent. A cancelled `create` still frees the session it created: its
  cleanup runs outside the cancelled call's scope.
- SDK: `ClientOptions.requestSignal` (a hook read per request) lets a caller cancel. A cancelled
  request fails with `CANCELLED` — not retryable, `operationId` attached, "outcome may be
  unknown" — so a cancelled write is reconciled, never treated as success or replayed blindly.

### Added — output schemas for six more MCP tools (T0 M2, part 1)

- `create`, `page_create`, `pages`, `close`, `pdf` and `events_replay` advertise an
  `outputSchema` on the `2025-06-18` protocol, so structured-capable clients receive
  `structuredContent` for them. New protocol schemas: `PageResponseSchema`,
  `SessionCreatedResultSchema`, `PageListResultSchema`, `SessionClosedResultSchema` and
  `SessionEventsPageResultSchema`; `pdf` shares `screenshot`'s `ArtifactRefSchema`. The schemas
  stay open to additive fields. A full-stack test validates every tool's real result against its
  schema.

### Fixed — structured tool errors no longer break MCP clients that validate output

- MCP clients (the official TypeScript SDK among them) validate `structuredContent` against a
  tool's `outputSchema` even on `isError` results. Ours advertised the success shape only, so a
  structured error (`{error: {code, message, operationId?}}`, shipped in 1.17) from `act`,
  `navigate`, `extract`, `observe`, `autofill`, `plan`, `screenshot` and the tools above became a
  client-side `-32602` and the agent never saw the error. Every advertised `outputSchema` is now
  `{type: "object", anyOf: [<result schema>, <error envelope>]}`, keeping the result schema's
  `$id` at the root. Protocol schemas, OpenAPI and discovery are unchanged. A client-view test
  reads `tools/list` and validates every `structuredContent`, errors included, with a draft-07
  validator.

### Fixed — the documented session response no longer requires `engine.capabilities`

- OpenAPI's `EngineInfo` (in every session response) marked `capabilities` required, but no
  session response has ever carried it. It is now optional; capabilities come from
  `GET /v1/engine`.

### Changed — least-privilege workflows and SHA-pinned actions (T9 S1c)

- Every workflow now defaults to `contents: read`; `ci.yml` previously inherited the repository
  default. In `release.yml` only the `release` job (GitHub Release and asset upload) can write
  contents; `npm-publish` keeps only its OIDC `id-token`.
- All 67 action references in the four workflows are pinned to the full commit SHA of their
  release, with a `# vX.Y.Z` comment for Dependabot. `scripts/release-workflow.test.mjs` checks
  every workflow file: it refuses an unpinned reference, any top-level permissions other than
  `contents: read`, and any job-level grant beyond an exact allowlist (`release`, `npm-publish`
  and the docs `deploy` job).
- The T9 packet records why skipped or canceled jobs cannot turn the required checks or the
  release graph green.

### Changed — plans are capped at 100 steps (T0)

- A plan now accepts at most **`MAX_PLAN_STEPS` = 100** steps (new protocol export, separate from the
  20-step `act` batch cap). The cap is enforced in `AgentBrowserService.executePlan` itself, so no
  caller bypasses it, and on every surface before dispatch: REST `/plan` answers
  `400 INVALID_REQUEST` naming the limit; `/outcomes` (an outcome run's `actions` carry the same
  `maxItems`) answers `400 INVALID_REQUEST` with its usual generic message; the MCP `plan` tool advertises `maxItems` and refuses locally; the CLI `plan` command refuses
  locally; the SDK receives the server's refusal. Nothing executes for an over-limit plan. Split
  longer work into several plans. Plan *reports* are unaffected.

### Added — confirmed vs suspected findings, and a role-access fixture (T7)

- **Scanner alerts are labelled.** Every `ScannerFinding` now carries `status: 'suspected'`;
  ZAP's own confidence is kept as `scannerConfidence` (information only — ZAP's "Confirmed" maps
  to `confirmed-by-scanner-user`, still suspected here).
- **`confirmFinding(finding, evidence)`** is the only way to reach `confirmed`, including for the
  role-access probe below. It requires a reproduction record (the `independent-reproduction`
  method label, a full ISO-8601 date-time with offset, a bounded observation) and a cleanup
  record; a required but unperformed cleanup refuses with `CLEANUP_INCOMPLETE`, and a scanner
  confidence label is refused as evidence. The record is an **attestation** the caller vouches
  for: the function checks its shape, not that the reproduction happened.
- **Role/business-logic fixture.** `checkRoleAccess` reads each fixture resource as every
  non-owner identity, read-only (GET, redirects never followed, bodies read up to 1 MiB, 15 s
  timeout) and host-scope-checked for every resource before any request; path, method, time and
  budget limits stay with the caller. A non-owner that receives the owner's private marker is a
  `broken-access-control` finding confirmed through `confirmFinding`, the detecting read being
  the reproduction; a success status without the marker is not a finding. The marker never
  appears in a finding: a fixture whose URL contains it is refused, as are unknown (including
  prototype-key) owners and empty markers. A failing owner control invalidates the fixture rather
  than passing. The tests drive a vulnerable/fixed invoice pair plus a fixed app that answers 200.
- **SARIF.** Results carry `kind: review` (suspected) or `kind: fail` (confirmed) and a
  `properties.status`. Per SARIF 2.1.0 §3.27.10 a suspected result has `level: none`, with the
  scanner's risk in `properties.risk` and the rule's `defaultConfiguration`; confirmed results keep
  the risk level and add their evidence description. Role-access findings get their own run.

## [1.18.0] — 2026-10-15

### Fixed — the login browser's no-disabling-flags test now actually checks (TD-BROWSER-16 phase 4)

- The test "the live argv carries NONE of the disabling flags" passed vacuously: Chromium rewrites
  its `/proc/<pid>/cmdline` into one space-joined string, and the test split it on NUL only, so no
  flag could ever match. Re-adding `--disable-component-update` to the launch passed it. It also
  located "the newest Chromium" on the machine, which under parallel suites could be another
  test's Playwright browser (the CI failure seen on #475). The test now tokenizes on NUL and
  spaces, finds the login browser by its exact `--user-data-dir`, and asserts that profile is in
  the argv it inspects. The re-added flag now fails it. The login browser itself was correct:
  verified to carry none of the three flags.

### Added — release tags must be cut from main (T9 S1a, R14)

- The release workflow's `tag-guard` job now fetches `main` and runs
  `scripts/check-tag-ancestry.mjs`: a tag whose commit is not reachable from `main` fails before
  anything builds or publishes, and every other release job depends on `tag-guard` (a test walks
  the whole `needs` graph). An unknown commit, a missing `main` ref or a missing `git` fails
  closed. Checked against real history: all 47 existing `v*` tags pass; a develop-only commit is
  refused.
- **Limit, stated plainly:** GitHub runs the `release.yml` *of the tagged commit*. A tag on an
  older commit (whose workflow predates this gate), or on a branch that removed the step, skips the
  check. The gate catches honest mistakes; the **guarantee** needs repository settings the owner
  applies — a tag ruleset restricting who may create `v*` tags, and protection on the `npm`
  environment (see the PR for the exact commands). Admins keep the ruleset bypass, so an admin
  tagging an older commit by mistake still skips the gate; the environment reviewer is the last
  manual check there.

### Added — the handoff surfaces (TD-BROWSER-16 phase 7; the program complete)

- **Protocol**: the `session.credential` capability joins the closed vocabulary and flows into
  every browser profile (profiles derive by filtering it); the application mode stays fenced out.
  Profile revision stays 1 — capabilities only grew.
- **MCP**: a `cookie_handoff` tool (optional `approvalToken`) gated on `session.credential`,
  dropped for bound sessions (a bound session is never a handoff target). Its handler catches
  `APPROVAL_REQUIRED` itself and returns a structured relay result — token id, domains, counts —
  so the agent can forward it to the operator without the error-details allowlist changing.
  Catalog regenerated; release-smoke pins the tool in the unbound list only.
- **SDK**: `client.sessions.cookieHandoff(sessionId, { domains, approvalToken? })` returning
  `{ sessionId, credentialSource, domains, counts, lease? }`; the APPROVAL_REQUIRED details ride
  `AgentBrowserError.details` unchanged.
- **CLI**: `session cookie-handoff <id> --domain <d>… [--approval-token]` (prints the approval to
  relay — token, domains, counts, never values); `operator login-browser open|close|reset`; and
  `operator approve <session> <token> [--lease hosts=…,minutes=…,actions=…]` which parses the
  lease and posts the decision (only a cookie.handoff approval may carry one, server-enforced).
  The operator key resolves from `--operator-key-file` or a no-echo prompt — never env.
- **Policy**: `GET /v1/policy` gains a `cookie.handoff` entry answering the DEFAULT decision
  (the sentinel-domain ask); the per-domain answer is a conditional question — `POST
  /v1/policy/check` with `action: cookie.handoff` and the domain as `target` (never resolved;
  bare suffixes refuse exactly as the handoff floor does).
- **Review round 1 (all fixed, test-pinned):** the `policy check` route's front door rejected
  `cookie.handoff` — the engine branch existed but was unreachable from REST/CLI/MCP; the action
  now passes the door (route test added), and the handoff POST joined `SELF_ADMITTING_ROUTE_SEGMENTS`
  so the SDK mints no phantom operation id into the approval relay. The four login routes' OpenAPI
  400/409 entries now attribute their codes correctly (closed-browser is a 409; binary pins are
  open-only). The CLI `--lease` parse is total — stray tokens (an unquoted host list) and repeated
  keys refuse loudly instead of silently under-granting; the CLI relay emits enumerated fields
  like the MCP relay; and the schema-sync gate pins `cookie_handoff`'s hand-written schema.
- **Docs**: the new guide **Use your login safely** (threat boundary first: the agent must not
  share the operator's OS user; the profile is file-permissions-only and must stay out of synced
  paths; session cookies drop at close — then the loop, leases, guarantees and residuals, one-time
  copy); a threat-model row plus the accepted ADR-025 residuals; the three login-browser
  variables documented in operations.md as trusted operator configuration. The four operator
  login routes' OpenAPI now documents their typed 400/409 refusals (a phase-4 carried item).

### Added — the cookie handoff (TD-BROWSER-16 phase 6, ADR-025 §3)

- **`POST /v1/sessions/{sessionId}/cookies/handoff`** `{ domains, approvalToken? }`, under one
  per-session lock, in the TD's exact order — floors → per-domain policy → approval → freshness
  re-read → **mark** → lease → secrets → RTC-removal init script → write → audit:
  - **Floors**, each with its own `floor.handoff.*` rule id: login browser enabled AND open;
    isolated non-delegated locally-launched session; egress policy enforced; service workers off;
    no committed navigation other than `about:blank`; no existing cookies for the requested
    domains; every allowlist entry (`allowedHosts`, `scope.allowedHosts`) and every
    `scope.pathRules[].hostSuffix` an exact host within the requested domains; each requested
    domain a usable host (`.com` refuses).
  - **Policy**: one `cookie.handoff` decision per domain through the authorizer seam (the Cedar
    schema and the env-generated document gained the action; a policy file can deny per domain —
    any deny fails the whole handoff).
  - **Approval**: pre-approval read returns `APPROVAL_REQUIRED` with `{ kind, sessionId, domains,
    counts }` (per-domain counts included); the token is single-use, human-operator-decided on the
    existing non-act route, and bound to `(kind, sessionId, sorted domains, policy version)` — the
    version rides the token and its fingerprint, so a policy change invalidates an outstanding
    approval. Count changes between mint and retry are fine (the binding is not the counts); a
    domain going **some-to-none** refuses with `floor.handoff.freshness` and never writes. The
    decision may carry a **lease** (validated and applied after marking). The pre-approval mint
    counts against the approval gate's capacity (`QUOTA_EXCEEDED` when full).
  - **Completion**: marks `credentialSource: "operator"` BEFORE the write (a racing cookie export
    is refused, never served unmarked cookies), applies the decided lease, registers every cookie
    value as a session secret (phase 2's scopes; `clearSessionSecrets` at session close is now
    wired), injects the all-frames init script removing `RTCPeerConnection`/`webkitRTCPeerConnection`
    (verified against a real browser in main document, synchronous about:blank iframe, and
    window.open popup), writes through the engine's new live `addCookies` (the `__Host-` conversion
    is shared with create-time seeding), and audits session/domains/counts/token/lease/rule ids —
    never values or cookie names.
- **Engine contract**: `EngineSession.addCookies?` / `addInitScript?` (optional; callers refuse
  typed when absent — never silently skip). Playwright implements both on the live context;
  FakeEngine records writes and scripts (its `cookies()` now exposes seeds and handoff writes),
  and the contract suite asserts the optional methods.
- **Afterwards**: cookie export, HTML export and download collection refuse with
  `HANDOFF_COOKIES_NOT_EXPORTABLE` in a marked session; while the login browser is enabled the
  shared Chromium launches with `--force-webrtc-ip-handling-policy=disable_non_proxied_udp`
  (engine option wired from `AGENTBROWSER_LOGIN_BROWSER`, asserted in the real-browser suite).
- `openapi.json` regenerated; the write-path checklist declares the handoff route.
- **Review round 1 (all fixed, each pinned by a new test):** the cookie-domain matching was
  INVERTED vs ADR-025 §3 (`covers(cookieHost, domain)` instead of `covers(domain, cookieHost)`) —
  a deep-host request pulled the parent's site-wide cookie without operator evidence, and an apex
  request refused the subtree's host-only cookies; the arguments are swapped and the applies
  relation now also drives the per-domain evidence and the freshness guard. Post-mark aborts
  (a lease the allowlist refuses; an engine without the live cookie API) bricked the destination
  session — engine capability, lease validation, the ADR §3 transfer bounds (≤1000 cookies,
  ≤1 MiB — previously unenforced), the init script and the secret registration all now run BEFORE
  the mark. Operator input is canonicalized (case, whitespace, trailing dot). The RTC-removal
  script moved to a shared ENGINE-PACKAGE constant (@agentbrowser/engine — core is not a dependency of
  engine-playwright) so the injector and the real-browser behavioral tests
  assert the same text. ADR §4's "baseline grants it to no one" corrected to the shipped default
  (capability grant covers it; the approval step is the unconditional part). floor.handoff.websocket
  is a real guard on a recorded fact. A racing mid-write export test, a foreign-policy-version
  token test, and both pre-mark abort tests pin the new behavior.

### Fixed — event replay paging, artifact eviction, tenant ownership

- **Event replay paging matches the type exactly.** With `since`/`limit`, `?type=` used to select
  only the ledger, so `type=console.log` also returned `console.error`, dialog and lifecycle rows
  (and `type=request.failed` returned every `request.*` row). Paged rows now match the type
  exactly; `nextCursor` advances past skipped rows of other types.
- **Paged replay reports eviction gaps.** Paged responses add `oldestSeq` (lowest retained ledger
  sequence) and `gap` (`true` when the caller passed `since` and entries after it were evicted
  before the read) instead of silently re-reading from the oldest kept entry. The envelope is one
  protocol schema (`SessionEventsPageSchema`, ADR-015) used by the service, OpenAPI and the SDK;
  MCP `events_replay` and the CLI (`gap: true …` line) carry it. Additive.
- **`since=-1` is accepted.** An empty page hands back `nextCursor: -1`, which the route used to
  reject with 400, breaking `since=nextCursor` polling loops until the first event arrived. `-1`
  now means "from the start" on the route, OpenAPI, MCP and the CLI.
- **Artifact store: aggregate byte cap and fair-share eviction.** New `maxTotalBytes` (default
  256 MiB; `AGENTBROWSER_ARTIFACT_MAX_TOTAL_BYTES`, invalid values abort startup). When full, the
  oldest artifact of the tenant holding the most (artifacts under count pressure, bytes under byte
  pressure; ties evict the writer's own) is evicted, so no tenant can be pushed below an equal
  share by another's writes, whatever their sizes or order. Previously worst-case retention was
  100 × 10 MiB with global FIFO eviction, so any tenant could flush another's evidence.
- **Tenant ownership fails closed on ownerless sessions.** An authenticated tenant is refused
  (403) on a session without a tenant; previously such a session was reachable by any keyed
  tenant. Not reachable through `POST /v1/sessions` (keys stamp the tenant) — defense in depth.
- Docs: the `artifact-auth` comment and the `AGENTBROWSER_ARTIFACT_KEY` row now say what exists:
  a token check over `artifactId|exp` that no route currently mints tokens for, so artifact
  access is by session ownership.

### Fixed — operation journal retention (not yet wired into the service)

- **Settled, expired namespaces release capacity when it is needed.** Expired namespaces used to
  count toward `maxNamespaces` forever, so a store that had ever held that many refused new ones
  permanently. Now, when a new namespace would be refused at the ceiling, every namespace that is
  released, past `retainUntil` (larger of the clock and its persisted high-water) and settled
  (all records terminal) is retired: records deleted, reservation zeroed, high-water raised. The
  row stays as a tombstone that never reopens — `expired` forward, `configuration` after a clock
  rollback or for any other descriptor — so purged operation IDs are never admitted again
  ([t5-journal-contract](docs/spec/design/t5-journal-contract.md)). Namespaces with an in-doubt
  record or an active fence are never retired. No startup purge, no DDL change (`formatVersion` 1).

### Added — reviewed actions and the lease (TD-BROWSER-16 phase 5, ADR-025 §5)

- **Marked sessions** (`credentialSource: "operator"`): the marking is **server-side only** — a
  `ServiceSessionRequest` field plus an internal mark method (phase 6's handoff calls it); the
  wire create route refuses `credentialSource` **by name** (the request validator passes unknown
  keys through, so a name check is required — review F1 caught the first cut forwarding an
  agent-supplied marker), and the session view reports it read-only. In a marked session:
  - **high-risk effects** (`transaction`, `external-message`, `account-security`, `destructive`)
    always need an `act.reviewed` decision — a per-rule `decision: "allow"` is overridden; a policy
    `deny` still denies, **above the lease** (pinned by test after review F3); **unknown effects**
    need review too, unless the session's live lease covers the page's host; `read`/`write-local`
    classification is honoured unchanged.
  - Reviewed act approvals now carry `kind: "act.reviewed"` on the token and in the operator view
    (the fingerprint covers the kind, so a token can never be replayed as another kind).
    `getApprovalKind`/`findNonActToken` exclude `'act.reviewed'` as act-family — defense in depth:
    `getToken` returns confirmation records only, so they cannot see an act.reviewed token today,
    and counterfactually the non-act decide path would throw `INVALID_TOKEN` (its burn requires a
    confirmation record) rather than mis-decide.
- **The lease**: `POST /v1/sessions/{sessionId}/lease` — **human-operator key only** (an API-key
  operator is refused; lease-shaped input on agent routes is inert). `{ hosts ≤ 16,
  expiresInMs ≤ 4 h, maxActions ≤ 500 }`; every host must be a usable host lying within the
  session's own allowlist (request + engagement scope) — a session without one has nothing for a
  lease to lie within and the grant is refused. Within the lease, unknown-effect actions on its
  hosts run one count per action; high-risk never; expiry and count exhaust to review (fail
  closed). `lease.granted`/`lease.exhausted` audit events; the session view shows `actionLease`
  (with the remaining count) and `actionLeaseRemainingMs` — distinct from the pre-existing idle
  `lease` field.
- **Write paths outside `act`**: `autofill` in a marked session is refused without a covering
  lease (each field write then spends one leased unknown action through the normal act path);
  `application.execute` is refused outright. A checklist test enumerates every mutating route from
  the live router and fails any undeclared page-writing route, so a future write path must declare
  its marked-session behaviour before it ships.
- **Fixed (latent, exposed by the kind stamping)**: `ApprovalGate.allocate` spread the binding
  AFTER the storage `kind`, so any kind-stamped reviewed approval threw `Invalid token kind` —
  nothing stamped a kind on the reviewed path before, so it never fired. The binding now spreads
  first; reviewed records keep storage kind `reviewed` while their token carries the approval kind.
  (A second suspected latent bug — `getApprovalKind` mis-routing `'act.reviewed'` — was claimed in
  the first cut of this entry and retracted after review: the path was unreachable, not latent;
  see the marking bullet above for the corrected statement.)

### Added — the login browser (TD-BROWSER-16 phase 4, ADR-025 §1)

- **`LoginBrowser` (`engine-playwright`)**: a pipe-connected **persistent** Chromium context over a
  dedicated profile directory. Playwright drives `--remote-debugging-pipe`, so **no TCP port is
  ever opened** — asserted by test against the process's own listening sockets. The login walls
  a human needs (Safe Browsing phishing detection, component and background updates) are
  RE-ENABLED by REMOVING Playwright's disabling flags through `ignoreDefaultArgs`.
- **Profile security:** POSIX `0700`, created and verified at every launch (a wider mode refuses
  with `LOGIN_PROFILE_MODE`); Windows grants the owner's SID `(OI)(CI)F` via `icacls` with
  inheritance stripping intended (the runner's observed result is the ADR-tolerated owner +
  SYSTEM + Administrators posture), and startup parses the `icacls` ACE lines — with the
  pipe-glued filename header stripped — refusing any identity beyond the owner, where "the
  owner" and the exempted SYSTEM/Administrators match every icacls spelling (SID,
  `MACHINE\user`, translated well-known names). The Windows CI job runs this suite, where
  the win32 branches execute. (icacls, not PowerShell's Get-Acl, after the runner could not load
  PowerShell 5.1's Security module — caught by review executing the gate; the name-vs-SID
  comparison likewise.)
  The profile sits under `AGENTBROWSER_LOGIN_PROFILE_DIR` or, by default, the OS private
  per-user state root (`XDG_STATE_HOME`/`~/.local/state`, `LOCALAPPDATA` on Windows); whether
  that root is synced or backed up is the operator's environment, not a property claimed here.
- **Binary pinning:** the resolved executable, its file identity (size + mtime), and Chromium's own
  version are recorded in the profile on first launch. A different path refuses
  `LOGIN_BINARY_CHANGED`; the same path with a changed file identity (an in-place update) refuses
  `LOGIN_BINARY_DOWNGRADED`; either way reset adopts. The compared field is file identity, not the
  version string — `chrome.exe --version` prints nothing on Windows (GUI-subsystem exe,
  runner-proven), which made a version-probe check silently fail open there; `fs.stat` has no such
  platform gap. The recorded `chromiumVersion` stays as documentation, never compared.
  Launch-time refusals leave the profile unlocked — the lock is acquired after every pre-launch
  check, so a transient refusal never wedges the profile.
- **Lifecycle:** `open`/`close`/`reset`/`readCookies` serialized on a profile lock — a live second
  owner (or a hand-started Chrome, via its ProcessSingleton failure) refuses with
  `LOGIN_PROFILE_IN_USE`, a stale lock (dead owner) is adopted, the operator closing the last
  window reconciles the state, and reads refuse with `LOGIN_BROWSER_CLOSED`. Partitioned cookies
  (`partitionKey` OR `partitionKeyOpaque`) and expired ones are skipped and counted; the expired
  filter is asserted with a clock frozen ahead (Chromium culls expired cookies at write) and the
  opaque one with a stubbed cookie set.
- **Typed refusals at the client:** the seven `LOGIN_*` codes joined the protocol error enum
  (409/403/400, never 500) — every engine refusal maps to its code at the routes, and a
  non-typed launch failure (a hand-started Chrome) maps to `LOGIN_PROFILE_IN_USE`.
- **Headless CI:** `AGENTBROWSER_LOGIN_HEADLESS=1` lets the whole suite run without a display;
  CI runs the engine suites with it.
- **`LoginBrowserService` + `AGENTBROWSER_LOGIN_BROWSER=1`**: enabled only with operator keys
  present (boot refuses otherwise); `POST /v1/operator/login/{open,close,reset,read}` are
  human-operator-only operator routes — agent credentials and API-key operators are refused; a
  multi-tenant deployment refuses to open (single-tenant by design); server shutdown closes an
  open browser. The login browser is not a session: no id, no refs, no pages on any agent surface.


### Added — the cookie-domain matcher (TD-BROWSER-16 phase 3, ADR-025 §3)

- **`packages/core/src/domain-matcher.ts`**, on pinned `tldts` with **the private section in
  force** (`allowPrivateDomains`): `github.io` and `vercel.app` are suffixes — refused — while
  `x.github.io` is registrable. `covers(matcher, host)` is the cookie-scope relation minus public
  suffixes (exact match, or a registrable parent covers subdomains; a suffix entry never covers;
  a child never covers its parent). `usableHost`/`cookieDomain` refuse IPs, suffixes, `localhost`
  and unlisted TLDs (keys-only), and allow a registrable parent when the operator asks.
  `registrableParents` lists the registrable parents (subdomains are not registrable).
- **The dedup fix:** the CLI's cookie identity is now `cookieKey` — host-only and `.domain`
  cookies with the same name and path are distinct, because the leading dot is scope, not
  formatting (the duplicate error now names scope; otherwise unchanged). The cookie bounds moved
  into `core` (`MAX_COOKIE_COUNT`, `assertCookieRequestSize`), imported by the CLI.
- **Hardened after review:** `covers` refuses suffix/IP/`localhost` matchers outright (never even
  self); a dotted entry matches subdomains only; a usable parent — registrable, or a host under
  one — covers its subtree; ports and trailing dots are refused (they would fork the identity).
  Known gap recorded for phase 6: no IDNA canonicalization.


### Added — per-session secret registration (TD-BROWSER-16 phase 2, ADR-025)

- **`SecretManager` gains session scopes**: a value registered in a session's scope redacts only
  that session's observations, logs, traces and errors — never another session's, never the global
  surface; the scoped redaction sees the global values too, longest-first.
- **The entropy floor**: values under 8 characters, or with fewer than 3 distinct characters, are
  ignored — redacting "1", "en" or "true" would corrupt unrelated output while protecting nothing.
- **Registration invalidates that scope's memoized cache**; clearing a session drops its values,
  patterns and caches. **Bounded per TD-BROWSER-9 (A9), in both directions:**
  `sessionScopesMaxSessions` (default 512, `0` disables) keeps redaction memos for at most that
  many scopes, least-recently-**used** (memo eviction costs speed, never protection), and makes
  registration **fail closed** (`SCOPE_LIMIT`) once that many live scopes exist — a live session
  is never silently un-protected. `redactionCacheMaxEntries` governs every memo as it does the
  global one; unknown session ids allocate nothing. `redactUntrustedScoped` is the untrusted-key
  variant for phase 6's wiring. Core-only: no surface calls these yet. 11 tests.


### Added — the operator credential (TD-BROWSER-16 phase 1, ADR-025)

- **`AGENTBROWSER_OPERATOR_KEYS_FILE`** holds `key:tenant` lines authenticating a **human
  operator** (`human-operator` joins the principal actors). API keys must be configured and map to
  exactly ONE tenant, which every operator entry must match; a key appearing in both credential
  sets aborts startup (one credential, one identity); keys are SHA-256-hashed and never logged.
- **Operator keys are valid only on operator-flagged routes** — today, the approval view and
  decide routes — and refused with `403 FORBIDDEN` everywhere else: a leaked operator key cannot
  create sessions, act, or read anything else.
- **`ApprovalKind`, `NonActApprovalView` and `NonActApprovalDecision` live in the protocol**
  (ADR-015), re-exported from core; the approval routes' published OpenAPI 200s are oneOf the
  operator view and the non-act shapes. `ApprovalRequest` gains `kind` (`act` unchanged and
  byte-stable; `act.reviewed`; the non-act `cookie.handoff` carrying `{domains, counts}` evidence
  that phase 6 instantiates): non-act tokens carry their kind and evidence, with **domains**
  inside the fingerprint — a token cannot be replayed against different domains; **counts are
  informational** per ADR-025 (committed gate tests pin all of this).
- **The separate resolve-and-decide path**: the approval view/decide routes branch on kind —
  non-act tokens are decided by a **human operator only** (an API-key operator, which an agent may
  hold, is refused for them), and the view returns the bound evidence verbatim. Single-use.
- **CLI**: `agentbrowser approvals view <sessionId> <tokenId>` reads the operator key from
  `--operator-key-file` or a no-echo prompt — **never an environment variable** (tested: env
  operator keys are ignored).


### Fixed — approval decisions are tenant-bound (TD-15 phase-7 review)

With API keys configured, approval questions (`act`/`act.unattended`) now decide as the session's
authenticated tenant, through a tenant-bound authorizer — matching egress, capabilities and the
policy query routes, which already did. Before, every approval question decided as the implicit
`Tenant::"local"`: a per-tenant act rule (deny transactions for tenant `ci`) never matched
enforcement, and `POST /v1/policy/check` could disagree with the enforcement decision for the
same action. Found by the phase-7 documentation review asserting the documented behavior.

### Added — policy documentation (TD-BROWSER-15 phase 7)

- **`docs/policy.md`**: the operator's guide — the policy file and its startup refusals,
  `policy export` migration, the Cedar schema reference (the exception actions, set-valued
  address classes, per-source private asks, the per-tenant keys-only pattern, `@rule`/
  `@internal`, with `@reason` reserved), `policy check` semantics (enumeration, never DNS), shadow mode, and the floor's
  fixed rules including the statement that browser traffic is not DNS-pinned.
- **`docs/operations.md`**: the ADR-024 §4 classification of every variable (policy-bearing /
  floor input / bootstrap / trusted), the policy-file and shadow variables, and
  `AGENTBROWSER_CHROMIUM_ARGS` marked security-relevant.
- **`docs/threat-model.md`**: the policy file is trusted operator configuration; only
  authenticated tenants are policy principals; `check` is not a DNS oracle; `@internal` exists
  for confidentiality.

TD-BROWSER-15 is complete.

### Added — policy query surface (TD-BROWSER-15 phase 5)

- **`GET /v1/policy`** — the loaded policy: version (the document SHA-256, or `legacy`), limits,
  and one `PolicyDecision` per capability for a default session of the caller's tenant (the
  response says so). Without a policy file the answers come from the legacy environment
  decisions and are marked unconditional.
- **`POST /v1/policy/check`** — ask what the policy would decide for one action and target.
  Answers come by enumeration, never by DNS resolution: an IP literal is classified by the real
  classifier and answered exactly as enforcement would answer it; a hostname passes the
  name-level rules (metadata names are floor-denied, loopback names answered by name) and then
  gets one answer per class set — the non-public sets say `depends on the resolved address`
  instead of guessing. A caller-supplied tenantId never overrides the authenticated tenant.
- **Rate limiting:** a bounded per-tenant token bucket (30/minute, lazy refill, LRU eviction at
  4096 tenants) gates both routes with `RATE_LIMITED`.
- **`@internal`** policies decide but report as `operator.policy`, with no reason.
- **Surfaces:** SDK `client.policy()` / `client.policyCheck()`; CLI `agentbrowser policy` and
  `agentbrowser policy-check`; a read-only `policy` MCP tool. OpenAPI regenerated.
- ADR-024's status moves to **Accepted**.
- **Hardened after review:** check's literal asks mirror enforcement exactly (phase and the full
  class set — committed regression tests against policies conditioning on them); invalid
  IP-literal shapes and prefix-length targets answer `floor.invalid-ip` as enforcement refuses
  them; `RATE_LIMITED` joined the protocol error enum so the 429 matches the published envelope;
  keyed per-tenant answers and `@internal` redaction are tested through the real routes. Without
  API keys the query surface shares one 30/minute bucket (keyed deployments are per tenant).

### Added — the policy file, opt-in, shadow mode (TD-BROWSER-15 phase 4a)

- **`AGENTBROWSER_POLICY_FILE`** loads a policy document and turns it into the server's every
  operator decision. Every startup refusal from the TD: files combined with policy-bearing
  variables or embedder options (all conflicts named), unparsable documents, tenant literals
  other than `local` while no API keys exist (found in Cedar's parsed policies, conditions
  included), a key tenant named `local`, and anything strict validation refuses. `limits`
  (`extractMaxBytes`, `maxResponseBytes`) replace the embedder options; unknown limit keys
  refuse.
- **Per-session, per-tenant decisions:** each session's network policy is the floor blocks plus
  the tenant-bound authorizer's exceptions, memoized in a bounded LRU and cleared at close. No
  keys: the implicit `Tenant::"local"` decides whatever tenantId a caller claims. Sessions stamp
  the policy version; `/health` exposes the authorizer's health as a boolean only.
- **`AGENTBROWSER_POLICY_SHADOW=1`** evaluates, alongside the legacy decisions, the document this
  environment would generate: legacy decides, divergences warn with both rule ids, and a trap in
  the shadow never touches the legacy decisions.
- The deprecated policy variables warn at startup when used without a file; the
  loopback/private-permitting and no-public-egress startup warnings are in.
- **Phase 4b — the performance gate** (`packages/benchmarks`): a worst-case 300-subresource page
  (every request private, 30 hosts × 10) measured through the service's own chain. First run:
  uncached p50 193 µs per decision (6.9% of the 1.0 s reference load), memoized 2.9 µs (0.96%),
  shadow 153 µs (5.0%); shared CI runners measure 2–3× that. The gate is 25%, applied to the
  production modes (memoized, shadow); uncached is the reported floor. Its job is catching
  order-of-magnitude regressions, not constant factors.

### Added — CedarAuthorizer, policy export, bundled engine (TD-BROWSER-15 phase 3b)

- **`CedarAuthorizer`** decides through the real Cedar engine, gated by the phase-2 differential
  oracle: it passes every generated configuration the oracle throws at it, `allowed` and
  `ruleMatched` both. Loads are strict (zero validation errors, `@rule` annotations
  cross-checked, reserved id namespaces refused), every decision runs against pre-parsed
  artifacts with request validation, and any trap — a rejected request, a refused source, an
  evaluation error — denies with `engine.error` and stays failed closed until restart. Strict
  validation statically rejects policies that would error, so a bad document never runs at all.
- **`agentbrowser-server policy export`** writes the policy document for today's environment
  configuration (loopback, CIDRs, approval policy), parsed exactly as the service parses it —
  operators migrate by generating, not hand-writing. Invalid configuration fails with the
  startup messages.
- **Hardened after review** (every claim held: the oracle at fresh seeds and 1000 runs, the
  packaging gates, a real pruned deploy): `policy export` refuses approval values the server
  refuses at startup instead of emitting a document for an unbootable configuration; every
  deciding forbid id is reported (a filter could erase one from hand-written documents); and
  `rulesMatched` lists each deciding id once.
- **The engine ships bounded:** `@cedar-policy/cedar-wasm` 4.13 becomes a runtime dependency,
  pruned to its Node build (~4.35 MB) in the server tarball, the Docker image and the Windows
  bundle; the pruner enforces a version + SHA-256 pin (`scripts/cedar-wasm.json`), the
  shipped-path gate accepts exactly that one pinned wasm and nothing else, the install-size
  gates gain the measured delta, and the Windows bundle smoke loads a document and decides one
  request through the bundled node.

### Added — Cedar schema, policy document, generator (TD-BROWSER-15 phase 3a)

- **The Cedar contract lives in the protocol** (`CEDAR_SCHEMA`, `agentbrowser-cedar/v1`): the
  `Authorizer` actions as Cedar actions, one optional normalized `ip` on `request.private`, and
  the act matchers (`effect`, `matchedRule`, `hostname`, `action`, `role`, `name`).
- **A policy document type** (`agentbrowser-policy/v1`): the policy set plus the configuration it
  was derived from, with structural parsing that rejects duplicate keys. This is what
  `policy export` will write and phase 4 will load.
- **A generator** turns today's environment configuration into a Cedar policy set that decides
  exactly as `LegacyAuthorizer` does, deterministically in text:
  - mapped-space operator CIDRs expand to their IPv4 equivalents, and a prefix up to 96 grants
    either all of IPv4 or nothing — Node `BlockList`'s cross-family behaviour, which a property
    test referees directly against `BlockList` (3000 single-rule runs, 1500 unions, the verified
    matrix);
  - every deny branch is an explicit `forbid` carrying its `env.*` id as a `@rule` annotation,
    so a denial still reports which rule decided it; a `required` outcome is a permit/forbid pair;
  - the generated set validates against the schema in strict mode with zero errors, and a fixed
    decision matrix matches `LegacyAuthorizer` under the real wasm build.
- `cedar-wasm` 4.13 is a dev-only dependency of `policy-engine`; it never enters the prod
  deploy trees the tarball, image and Windows bundle are built from.
- **Hardened after review** (every equivalence claim held under 100k+ referee checks): the
  generator validates its rules with the validator `ActionRiskPolicy` uses — now one shared
  exported validator in core — so an id the system would reject at startup can never reach the
  Cedar text, and `unknownRisk` is validated the same way; and
  `normalizeSourceForCedar` refuses family-mismatched (address, type) pairs, which `BlockList`
  answers false for.
- `PolicyDecision` gains `rulesMatched` (every deciding id; `ruleMatched` stays the first).
### Fixed — engagement scope

- **The redirect-hop set is bounded (#447).** `EngagementScopePolicy` remembered every distinct
  redirect-hop URL for a session's lifetime so a re-validated chain would spend each hop once.
  It now keeps the newest 4096 (`CHAIN_SPENT_BOUND`); a hop evicted from memory is charged again
  if re-submitted — over-charging only, so a budget can end sooner, never later, and a session
  reaching the bound takes 41+ redirect-saturated navigations at the transport's 100-hop cap (~410 at the 10-hop default). Hops are no longer tracked at all
  when no request budget is set.
he engagement scope's redirect-hop set (#447))

### Added — differential oracle (TD-BROWSER-15 phase 2)

- **A property-based harness checks any `Authorizer` against today's decisions.** It covers egress
  (contexts from the real `NetworkPolicy` path), approvals (from `ActionRiskPolicy.classify()`) and
  every capability, over generated configurations: loopback, CIDRs, `unknownRisk` and approval
  rules.
  - It holds for `LegacyAuthorizer` and runs a deterministic table of every approval combination.
  - It probes the first, last and one-past addresses of every CIDR, and contexts with several
    private sources.
  - 27 plausible-but-wrong subjects from review must each be caught on every seed, and a correct
    subject that resolves rules by id must pass.
  - Phase 3 runs it against Cedar.
  - It is test-only, with `fast-check` as a dev dependency, and it is not in the build.

### Changed — policy engine seam (TD-BROWSER-15 phase 1)

- **The floor refusals live in one module** (`packages/api/src/floor.ts`). That covers CDP-attach
  admission, attach options, delegated sessions, operator-only routes and the metadata wrap. Codes,
  messages and `floor.*` rule ids are unchanged.
- **Capability grants go through the `Authorizer`.**
  - When a session will get operator CDP attachment, downloads, service workers, cookie seeding or
    a headed browser, the service asks its authorizer. An always-headed engine (Safari) counts as
    headed unless headless is demanded. Cookie export asks for `cookie.export`.
  - Existing refusals keep their precedence: shutdown, an unknown engine and an unknown session
    still come first.
  - The default `LegacyAuthorizer` grants all of them (`env.capability.default`), so behaviour is
    unchanged.
  - A denial would be `POLICY_DENIED` with `details.rule` and `details.policyDecision`.
  - The service accepts an injectable `authorizer` (`ServiceDependencies.authorizer`), which is
    where phase 4 plugs in Cedar.
- **The loopback and private-network exceptions go through the `Authorizer` too.**
  - `NetworkPolicy` asks an `EgressExceptions` hook at its four existing decision points (hostname
    and resolved address, loopback and private). The default hook is today's rules.
  - The server answers it through `LegacyAuthorizer`'s `request.loopback` and `request.private`,
    built from `AGENTBROWSER_ALLOW_LOOPBACK` and `AGENTBROWSER_ALLOWED_CIDRS`.
  - Behaviour is unchanged: a differential test compares both hooks across mapped, NAT64, 6to4,
    SIIT and link-local addresses, hostnames and CIDR sets.
  - Snapshots keep their own copy of the default rules, so they stay immutable.
  - The hook fails closed: anything but `true` (a Promise, a string) counts as "not allowed".
  - Once a hook owns the exceptions, `updateConfig` refuses changes to `blockLoopback`,
    `blockPrivateIPs` and `allowedPrivateCIDRs`, so the reported flags and the enforced decisions
    cannot drift apart. No production code calls `updateConfig`.
- **Approval decisions go through an `Authorizer`.** A new internal package,
  `@agentbrowser/policy-engine`, carries the `Authorizer` interface and `LegacyAuthorizer`, today's
  rules unchanged. Each decision answers ADR-024 §5's two questions, `act` and `act.unattended`,
  and names its rule (`env.approval.<rule id>`, `env.approval.unknown-risk`,
  `env.approval.high-risk`, `env.approval.default`). Behaviour is unchanged, as the oracle tests
  show.
- **Approval rules accept an optional `id`** (`AGENTBROWSER_APPROVAL_POLICY` and
  `ServerOptions.approvalPolicy`): lowercase letters, digits, `.`, `_` and `-`, up to 64
  characters, unique, and not `none` or `rule-<n>`. A rule without one is identified as
  `rule-<index>`. **Tightening:** an `id` key was previously ignored; an invalid one now stops
  startup, with an error naming the rule and the reason.

### Changed — egress safety floor (TD-BROWSER-15 phase 0)

- **More cloud metadata endpoints are refused.** In addition to `169.254.169.254` and the GCP
  metadata names, these are now blocked:
  - the whole IPv4 link-local range `169.254.0.0/16`, which includes ECS task metadata and EKS Pod
    Identity;
  - `100.100.100.200` (Alibaba Cloud) and `168.63.129.16` (Azure wire server);
  - `fd00:ec2::/64` (AWS over IPv6) and `fe80::/10` (IPv6 link-local);
  - `fd20:ce::254` (GCP, IPv6-only instances) and `fd00:c1::a9fe:a9fe` (OCI over IPv6).

  Like all metadata, they are refused even under an `AGENTBROWSER_ALLOWED_CIDRS` exception.
  **Tightening:** link-local devices previously reached through a CIDR exception are now refused.
- **IPv4 embedded in IPv6 is decoded.** These forms now carry the classes of the IPv4 they embed;
  before, they classified as public:
  - NAT64 `64:ff9b::/96`;
  - the local-use `64:ff9b:1::/48`, under every RFC 6052 layout. It is also private as a whole,
    since it is never globally routable. Decoding every layout reads almost any address in this
    prefix as loopback (`0.0.0.0`), so local-use NAT64 is **effectively refused**, which fails
    closed. Use the well-known `64:ff9b::/96` prefix with agentbrowser;
  - 6to4 `2002::/16`;
  - SIIT `::ffff:0:0:0/96`;
  - IPv4-compatible `::/96`.

  So `64:ff9b::7f00:1` is loopback and `64:ff9b::a9fe:a9fe` is metadata. Decoding only adds
  classes, and `::1` stays loopback. Teredo and ISATAP are not decoded.
- **`AGENTBROWSER_ALLOWED_CIDRS` matches the IPv4 inside these forms.** An IPv4 exception such as
  `192.168.1.0/24` also admits that address behind NAT64, 6to4 or SIIT, as it already did for
  IPv4-mapped. An IPv6 wrapper exception such as `64:ff9b::/96` never grants the private IPv4
  inside it.
- **The metadata floor holds over any injected policy.** Every session's request policy is now
  wrapped in `MetadataFloorPolicy`, so cloud metadata endpoints stay refused (`rule:
  "floor.metadata"`) even when an embedder passes `ServerOptions.networkPolicy` with metadata
  blocking off (`new NetworkPolicy({})`). The refusal covers request hosts, DNS answers, redirect
  hops and navigation preflight. Optional gates pass through only where the underlying policy has
  them, so a weaker policy is never made to look strict to the download path.
- **Metadata names are normalised.** Case and trailing dots are ignored
  (`metadata.google.internal.`). This matters on the CDP-attach lane, which has no DNS answer to
  check.
- **Tightening: `metadata`, `instance-data` and `instance-data.ec2.internal` are now refused.**
  These are the GCP and AWS search-domain names. An intranet host literally named one of them is
  refused even under an `AGENTBROWSER_ALLOWED_CIDRS` exception.
- **Floor refusals name their rule.** Each refusal that no policy can grant now carries
  `details.rule`:
  - CDP attachment: `floor.cdp.hosted`, `floor.cdp.multi_tenant`, `floor.cdp.local_only`,
    `floor.cdp.egress`, `floor.cdp.disabled`, `floor.cdp.auth_required`, `floor.cdp.options`,
    `floor.cdp.profile_options` and `floor.cdp.cookie_export`;
  - `floor.delegated.operator` on controlled-session creation without operator credentials, and on
    the operator-only control, approval and review checks. A caller without credentials on a
    keyless local service sees this rule. Delegated agent credentials are always refused earlier on
    these routes by their mode profile's capability gate, which is an operator choice and so carries
    no floor rule.

  Existing `details.reason` codes are unchanged.

### Fixed

- **`AGENTBROWSER_LOG_LEVEL` accepts `warn` and `error`**, the structured logger's other two
  levels, as well as `debug` and `info`. Matching is case-insensitive. Before, any value other
  than `debug` silently meant `info`; an unknown value now prints a warning and uses `info`.
- **The TypeScript SDK's managed subprocess sets the variable the service reads.** It used to set
  `AGENTBROWSER_LOG=error`, which nothing read. It now sets `AGENTBROWSER_LOG_LEVEL` explicitly:
  the caller's own non-blank value when set, otherwise `error`. Custom `SubprocessLauncher`s receive
  it too. At `error`, failed operations (including policy denials) are no longer logged; the
  `errors_total` metric still counts them.

### Docs — design records

- **ADR-024 (Proposed): server policy engine.** An opt-in, versioned policy document evaluated by
  embedded Cedar replaces policy that is spread across environment variables today. Policy becomes
  per authenticated tenant, and agents can query it (`GET /v1/policy`, `POST /v1/policy/check`, an
  MCP `policy` tool). A fixed safety floor stays outside policy: metadata endpoints (a wider set),
  loopback and private addresses blocked by default, and the CDP-attach refusals. Engine errors
  fail closed. Implementation plan: TD-BROWSER-15. Also adds ADR-022, which was missing, to the
  docs index.
- **ADR-025 (Proposed): operator login browser and cookie handoff.** AgentBrowser launches an
  operator-only, headed login browser on a persistent profile over a private pipe, with no
  debugging port that a local process could read. The operator signs in there once, then approves
  one-time copies of selected domains' cookies into contained sessions, using a separate operator
  credential the agent never holds. In those sessions, high-risk and unknown-effect actions need the
  operator's review, or an operator-granted lease. Implementation plan: TD-BROWSER-16.

## [1.17.1] — 2026-10-13

### Changed — dependencies (#426)

- **Playwright 1.62.1 → 1.64.0.** Engines pick up a newer Chromium build, which is downloaded
  again on first use: the Homebrew bootstrap, the Windows launcher and `playwright install`. The
  Docker base image moves with it, to `mcr.microsoft.com/playwright:v1.64.0-noble`.
- **CLI: `commander` 12 → 15.** The CLI now **rejects surplus positional arguments** that it used to
  ignore silently, e.g. `agentbrowser observe <s> <p> extra` fails with "too many arguments".
  Building the workspace from source now needs Node 22.12 or newer (root `engines`). Compiled CLI
  binaries are unaffected, and the server tarball still runs on Node 22 or newer.
- `@fastify/cors` 10 → 11 (major; the API sets `methods` explicitly, so its CORS behaviour is
  unchanged), `@fastify/websocket` 11.3.4, `ws` 8.22.0, `axe-core` 4.14.0, `jsdom` 30.1.2. Biome 2
  replaces Biome 1.9 for lint (#424), with every 1.9 rule still enforced.
- Dependabot holds back updates that need deliberate migration. It ignores puppeteer (the Firefox
  egress qualification is pinned to an exact driver) and the Playwright Docker image (it moves only
  with npm `playwright`) entirely, and ignores **major** versions of `@types/node`, `typescript`,
  `pixelmatch` (its colour metric changes baseline semantics) and the Docker `node` image.

### Docs — design records

- ADR-022 and TD-BROWSER-14 (#430) propose compact session and page identifiers and explicit,
  generated CLI contexts for 1.18.0. These are design records only; nothing changes in this release.

### Docs — Windows install, ADR-023, environment-variable reference

- **Windows install docs.** README, the docs home page and the operations guide gain a Windows
  section: winget or the zip, first-start Chromium, `--install-browser`, `AGENTBROWSER_HOME`,
  `AGENTBROWSER_SKIP_BROWSER_INSTALL`, no Windows-service registration, and unsigned executables.
  The operations guide also gains Windows troubleshooting: proxies, partial upgrades,
  `winget upgrade` with files in use, long paths, antivirus, and owner-only credential files
  under Constrained Language Mode.
- **ADR-023** records why the Windows server ships as a bundled-Node zip, not a single-file
  executable.
- **Environment-variable reference.** The configuration table now covers every operator-facing
  `AGENTBROWSER_*` variable, including several that appeared only in code and others documented
  only in package READMEs or prose. Test-harness and internal variables are listed as such.
  `AGENTBROWSER_LOG`, which the SDK sets, is noted as unread by the service.
- **Correction:** the stale "Windows server exe is Bun-compiled" paragraph is replaced.

### Changed — extracted-package acceptance runs on Windows

- **Graceful stop works on Windows.** `scripts/package-acceptance.mjs` stops managed children
  with SIGTERM on POSIX, as service managers do. On Windows, SIGTERM is `TerminateProcess`, so
  the harness instead uses the server's stdin lifeline (`AGENTBROWSER_SHUTDOWN_ON_STDIN_EOF`) or
  closes the injected child's IPC channel.
- **A child counts as finished** once it has exited and both its output streams have closed,
  which still captures late output. Node never emits `close` after the parent disconnects IPC,
  so waiting for `close` would hang on Windows.
- **Running the server.** The server under test is the POSIX launcher in the tree, or on Windows
  the server entry on Node. A new `--server-command` option runs a given executable instead,
  such as the Windows bundle's launcher. With `AGENTBROWSER_SHUTDOWN_ON_STDIN_EOF=1`, the
  launcher now also stops gracefully on EOF on its own stdin.
- **Windows environment fixes.** The harness prepends to the platform's real `Path` key, using
  `;` as the separator. It used to write a second `PATH` key that hid System32, so `openssl` and
  `qpdf` were never found. A command that can't be spawned now fails at once with its spawn
  error, instead of waiting out the shutdown deadline.

### Security — owner-only credential files on Windows

- **The problem:** the CLI's cookie export (`cookies export --output`) and private observation
  capture (`observe --output`) created files with mode `0600`. Windows ignores POSIX modes, so the
  files inherited their folder's ACL. In a shared folder such as `C:\Users\Public`, that grants
  Modify to every interactive user, so exported session cookies were readable by other local
  users.
- **The fix:** on Windows the file is now created **atomically with its security descriptor**.
  - A fixed Windows PowerShell script calls .NET `FileStream(CreateNew, FileShare.None,
    FileSecurity)`. The DACL is protected and holds exactly one ACE: the current user,
    FullControl. At no moment does the file exist with any other ACL.
  - The secret goes over stdin, never in argv or the environment.
  - An existing name, a link included, is refused.
  - POSIX keeps `O_EXCL | O_NOFOLLOW`, mode `0600`, and a failed `close` now counts as a failed
    write.
- **Why atomic creation:** an earlier approach set the ACL after creating the file. Review showed
  that leaves a race: another user can swap the file for a decoy, or keep an early read handle.
  Re-running that attack against the new code, the rename fails (the file is held with
  `FileShare.None`), and every file carries the owner-only DACL from birth.
- **Acceptance:** the extracted-package acceptance requires the SDDL DACL to be exactly
  `D:P(A;;FA;;;<current user SID>)`.

### Fixed — Windows service: shipped as the bundled-Node zip

- **The single-file `agentbrowser-server-windows-x64.exe` is retired.** v1.17.0's copy failed on
  every machine but CI with `Cannot find module 'D:\a\agentbrowser\…'`, because Bun froze
  playwright-core's `__dirname` lookups to the build checkout, and Playwright cannot be
  single-file bundled.
- **The release's new `windows-bundle` job** builds `agentbrowser-windows-x64.zip` on a hosted
  Windows runner and clean-room smoke-tests it before anything publishes. It contains:
  - the launcher;
  - the same CLI and MCP executables as the standalone assets;
  - Node 24.21.0;
  - the lockfile-pinned server tree.

  npm publishing and the GitHub release both wait for that job.
- **winget** installs the zip as one package. Its nested `agentbrowser-server.exe`,
  `agentbrowser-cli.exe` and `agentbrowser-mcp.exe` keep their command aliases. The package
  description now says what is installed: a bundled Node.js runtime, with Chromium downloaded on
  first start. It no longer claims "no Node.js runtime is required".
- `scripts/release-workflow.test.mjs` guards that structure, so the single-file server exe
  can't come back.

### Added — Windows bundle assembly and clean-room smoke

- `scripts/assemble-windows-bundle.mjs` builds `agentbrowser-windows-x64.zip`, a flat zip
  containing:
  - the launcher `agentbrowser-server.exe`, `agentbrowser-cli.exe` and `agentbrowser-mcp.exe`;
  - `node\` (official Node 24.21.0);
  - the `server\` tree.

  It refuses a server tree of another version, any link, any shipped file embedding a
  build-machine path, and any path over the MAX_PATH budget.
- `scripts/windows-node.json` pins the bundled Node to nodejs.org's SHA-256 values for both the
  archive and `node.exe`, matching `.tool-versions`. `scripts/fetch-windows-node.mjs` downloads
  only from `https://nodejs.org`, verifies both hashes, and installs only `node.exe` and
  `LICENSE`.
- `scripts/check-shipped-paths.mjs` fails on runner paths and the checkout path in shipped files.
  It matches raw and JS-escaped (`D:\\a\\`) forms, in UTF-8 and UTF-16LE. v1.17.0's server exe
  held the escaped form, and the scan fails on it.
- `scripts/windows-bundle-smoke.mjs` extracts the bundle into a clean room outside any checkout
  and drives the shipped executables:
  - `--help`/`--version`;
  - the first-start Chromium bootstrap;
  - a real session through the CLI;
  - the MCP end-to-end test through the MCP executable;
  - killing the launcher outright, which must leave no server or Chromium process;
  - a no-op reinstall;
  - invocation through a symlink, as winget's Links directory does.

  Windows CI assembles and smokes the bundle on every PR. The previously non-blocking MCP
  end-to-end step now runs, blocking, inside the smoke.

### Added — Windows server launcher

- New `packages/api/src/launcher/`, compiled by `packages/api/scripts/compile-launcher.mjs` into the
  `agentbrowser-server.exe` of the Windows bundle. The bundle places it next to a bundled
  `node\` runtime and the `server\` tree. The launcher imports only `node:` builtins and never
  derives a location from `__dirname` or `import.meta`; a test enforces both. v1.17.0's single-file
  server exe failed on every machine but CI because Bun froze Playwright's `__dirname` lookups to the
  build checkout.
- **Install root:** `AGENTBROWSER_HOME` when set, and then only it (an incomplete one fails
  loudly); else the real executable's directory, following winget's Links symlink; else the
  invoked path. An incomplete bundle is refused, and so is a server tree whose `VERSION.json`
  doesn't match the launcher.
- **Chromium:** downloaded on first start into `%LOCALAPPDATA%\agentbrowser\browsers`, unless
  `PLAYWRIGHT_BROWSERS_PATH` is set. Missing builds are detected the way Playwright detects them
  (`browsers.json` revision plus the `INSTALLATION_COMPLETE` marker). `--install-browser`
  pre-provisions; `AGENTBROWSER_SKIP_BROWSER_INSTALL=1` opts out; a failed download fails closed with
  next steps.
- **Supervision:** the launcher runs the server with the stdin lifeline. If the launcher is killed
  outright, the server and its Chromium still shut down (verified on Windows 11 with a live session).
  The first stop signal closes the lifeline; a second kills the server.

### Fixed — server artifacts ship only built output

- The server's workspace packages (`api`, `core`, `engine`, `engine-playwright`, `engine-safari`,
  `extraction`, `policy`, `protocol`) now declare `"files": ["dist"]`, as `control` already did.
  `pnpm deploy` had been copying whole package directories into the server tarballs: `src/`,
  `tsconfig*`, `vitest.config.ts`, and on a machine that had run tests, `coverage/` reports
  embedding the build checkout's absolute paths. The Docker image already deleted `src/` and
  coverage itself, but still carried the TypeScript and Vitest configs.
- The Dockerfile no longer deletes every directory named `src` under the deploy. That pruning is
  redundant now, and it also stripped third-party runtime code: `real-require`, which pino uses to
  load log transports, has its entry point at `src/index.js`.
- A new test walks the API's workspace dependency closure (dependencies, optional and peer) and
  requires an exact `files` allowlist.

### Added — Windows server tree (packaging)

- `scripts/package-server.mjs` gains a `win32-x64` target. Windows `tar` cannot extract the POSIX
  tarballs' pnpm symlinks without Developer Mode, so the Windows tree must contain no links. It starts
  from the **same lockfile-faithful isolated deploy** as every other target. The new
  `scripts/materialize-hoisted.mjs` then rewrites that deploy into a link-free hoisted layout.
  - It reads the dependency graph with Node's own lookup.
  - It places each package at the highest ancestor that doesn't shadow an existing resolution.
  - It re-verifies every dependency edge against the written files.
  - So Windows ships exactly the versions in `pnpm-lock.yaml`. pnpm 9's own hoisted `deploy` was
    rejected: it ignores the lockfile and re-resolves from the registry.
- The target removes `node_modules/.bin` and type/source-map files. It fails if any link remains, if
  a package can't run on win32-x64, or if a path exceeds the MAX_PATH budget under winget's install
  root (files and directories are gated separately). It produces `agentbrowser-server-win32-x64.zip`.
- On Windows hosts the packager runs pnpm through `npm_execpath`, or else through `cmd.exe` with
  checked arguments. It stages on the checkout's drive, because pnpm deploy fails across drive
  letters. Build-tool failures now include the tool's output.
- `scripts/check-win32-server-tree.mjs` extracts that zip outside the checkout and checks it:
  - no links;
  - the extracted-package dependency audit;
  - the server reaches `/health`;
  - with `--session`, a real Chromium session.

  It runs in Windows CI.

### Fixed — server command line

- `agentbrowser-server --help` and `--version` now answer without starting the service or
  loading the browser engine (previously every argument was ignored and the server started). The
  entrypoint parses arguments first and loads the server lazily, so help works even when
  Playwright cannot load. Unknown arguments exit 2; configuration stays environment-only.
- The server also shuts down cleanly on `SIGHUP` and, on Windows, `SIGBREAK`. A second signal
  force-exits a hung shutdown. A new opt-in `AGENTBROWSER_SHUTDOWN_ON_STDIN_EOF=1` stops it when stdin closes,
  which gives the Windows launcher a lifeline: if the launcher dies, the server still exits and
  closes Chromium.

### Fixed — winget package

- The winget manifests were not valid: three portable `x64` installers in one package are rejected
  as duplicate installer entries, and the version manifest lacked `DefaultLocale`. Releases now
  also publish `agentbrowser-windows-x64.zip` with the three Windows commands, and the manifest
  declares it as one zip installer with nested portable files, so
  `winget install AnvaiLabs.AgentBrowser` provides `agentbrowser-mcp`, `agentbrowser-cli` and
  `agentbrowser-server`. Regression tests in `scripts/winget-manifests.test.mjs` run with
  `pnpm test:release`.

## [1.17.0] — 2026-10-12

> **Known issue (Windows, v1.15.2 through v1.17.0):** `agentbrowser-server-windows-x64.exe` fails
> at startup on every machine except the build runner, with
> `Cannot find module 'D:\a\agentbrowser\…'`. Bun froze playwright-core's `__dirname` lookups
> to the CI checkout. An `agentbrowser-windows-x64.zip` attached to v1.17.0 after release wrapped
> the same executable and has since been removed from that release; each affected release now
> carries a known-issue banner. A winget submission for 1.17.0
> (microsoft/winget-pkgs#451310) was closed unmerged for this reason. Fixed in 1.17.1,
> which ships the Windows service as a bundled-Node `agentbrowser-windows-x64.zip`
> ([ADR-023](docs/adr/023-windows-server-bundled-node.md)). The Windows CLI and MCP executables
> are unaffected.

### Security — browser request guard, CORS off by default, dependency advisories

- **Drive-by control of the local service closed.** The no-keys local service sent
  `Access-Control-Allow-Origin: *` and checked neither `Host` nor `Origin`, so any web page
  the operator visited could create sessions and drive them — including `upload`, which reads
  local paths — directly or through DNS rebinding. A root `onRequest` guard
  (`packages/api/src/request-origin-guard.ts`) now answers `403 FORBIDDEN` to a `Host` that is
  not a trusted name (loopback or `AGENTBROWSER_ALLOWED_HOSTS`) on loopback binds and on **every
  bind without API keys**, to foreign or `null` browser origins, and to browser fetch metadata
  other than a typed navigation unless the origin is allowed or same-origin on a trusted name.
  CLI/SDK/MCP clients and the same-origin operator panel are unaffected when they use a trusted
  name. Residuals are documented in docs/threat-model.md.
- **Breaking for no-keys wide binds** (`HOST=0.0.0.0`, the Docker image's default): clients that
  reach the service by a container, service or LAN name now get 403 — list those names in
  `AGENTBROWSER_ALLOWED_HOSTS` or set `AGENTBROWSER_API_KEYS` (logged at startup). `localhost` /
  `127.0.0.1` (port publishing, the healthcheck) keep working; keyed deployments are unchanged.
- **CORS is disabled unless configured.** New startup-only `AGENTBROWSER_CORS_ORIGINS` (exact
  origins, merged with `ServerOptions.corsOrigin`) and `AGENTBROWSER_ALLOWED_HOSTS`. **Breaking
  for browser apps on other origins** that called the API: list their origins in
  `AGENTBROWSER_CORS_ORIGINS`. See docs/operations.md#browser-request-guard.
- **Dependencies:** fastify 5.12.1 → 5.12.5 plus lockfile refresh of `fast-uri` and
  `source-map-js`; `pnpm audit --prod` goes from 13 advisories (9 high) to none.
- **Dependabot version updates** (`.github/dependabot.yml`): npm, GitHub Actions, Docker and
  the docs pip toolchain, targeting `develop`.

### Docs — Anvai family brand

- The docs site adopts the shared Anvai family brand (v1.3), the same as the AnvaiOps, genmedia,
  InferFlux, ProximaDB, Sandhi and Victor docs. It includes the ink brand bar, teal accent and
  self-hosted Inter, which removes the Google Fonts request. `scripts/check_brand_tokens.py`
  pins the shared files and runs before the docs build (#400).

## [1.16.1] — 2026-10-10

### Added — formControls row/section context (G1)

- Custom controls with generic, duplicated accessible names (GitHub's permission editor
  renders 40+ "Access: No access" Primer menus) now carry `PageElement.context`: the nearest
  enclosing row label plus the section heading (`Contents — Repository permissions`), minted
  by the formControls enrichment and rendered by the CLI as `(context)`. Field evidence and
  the full gap packet (forms-extract parity, lazy-section probes, autofill context matching,
  scroll ergonomics, private-file downloads):
  docs/agent-handoffs/AGENTBROWSER_UI_GAPS_2026-10-10.md.

### Added — Windows CI + winget channel, App-based submission

- **Windows CI gates** (`windows-ci.yml`): windows-latest build + W1–W6 gotcha gates
  (stdio handshake, .cmd shim relay, spaced/UNC paths, PowerShell interop, browser
  discovery — each encoding a real win32 failure) + a full-stack headless MCP e2e
  through the real binary. The G2 shim gate caught its first real bug on first run:
  a never-executed-on-Windows argv-slice mismatch.
- **winget release channel**: manifests for all three portable commands
  (`agentbrowser-mcp`, `agentbrowser-cli`, `agentbrowser-server`) generated from the
  windows release exes; `winget install AnvaiLabs.AgentBrowser` provisions all three
  with no Node runtime. Manifests always upload as a workflow artifact.
  *Correction (2026-10-12):* these manifests were invalid (three portable installers for one
  architecture, and no `DefaultLocale`), so no winget package was published from 1.16.1. The
  1.16.1 server executable they would have installed also did not start outside CI. See the
  1.17.0 known issue above and the 1.17.1 Windows entries.
- **App-based submission (no user credential)**: a GitHub App installed on
  `anvai-labs/winget-pkgs` pushes the manifests branch per release (per-run
  installation tokens via `WINGET_APP_ID`/`WINGET_APP_PRIVATE_KEY`); the PR into
  `microsoft/winget-pkgs` is attempted and — because GitHub Apps cannot create PRs in
  repos they are not installed on — degrades to a one-click compare link in the run
  summary. `WINGET_FORK_TOKEN` (user PAT) remains the zero-click override.
- Also in this train: waitFor 6s budget fix for four real-Chromium panel waits under
  pre-commit parallel load, and honest `t.skip` (no bare passes) in G4/G5 when
  preconditions are unavailable.


## [1.16.0] — 2026-10-10

### Changed — MCP surface refresh (owner-approved breaking rename)

- **MCP tool names dropped the `browser_` prefix** (`browser_observe` → `observe`, `browser_act` →
  `act`, …; 17 tools + the delegated `operation`). Owner decision: consumers are few and adapt now
  rather than after wider adoption. Registered MCP clients must update tool names once.
- **Tool descriptions slimmed ~24%** (11.6K → 8.8K chars; `act` −54%) in telegraphic style with the
  repo's anchor-pinning tests as the deterioration boundary (they rejected two over-compressions:
  the egress-1014 "not a bot wall" cue and the reloading-recovery verb). Operator configuration
  essays moved out of agent-facing descriptions; `observe`'s description now teaches the compact
  projection.
- **Structured results everywhere it matters:** `act`/`navigate`/`extract` advertise outcome
  output schemas (`urn:agentbrowser:act-outcome:v1`, `urn:agentbrowser:extract-outcome:v1`, inline
  NavigationStatus) so their results arrive as `structuredContent` — previously `act` results were
  pretty-printed text only. The text fallback is now minified (−29% on that copy of every result).
- **Machine-readable structured errors:** tool failures keep the actionable remediation text and
  add `structuredContent {error: {code, message, operationId?}}` — with allowlisted details only
  (a raw `details` passthrough would have leaked `privateReason` from terminal close facts).
- **CLI `observe --output FILE`:** full observation to a new exclusive 0600 file (cookie-export
  discipline), stdout carries an identity receipt with the projection echo — the artifact escape
  hatch for evidence capture.
- **Agent skill shipped:** `docs/skills/agentbrowser-cli/SKILL.md` — the compact loop, ref
  discipline, and invariants as a copy-in skill for any harness.
- **Defaults raised 25% (owner direction):** default session TTL 3.5 h → **4.375 h**
  (15,750,000 ms; per-request `ttlMs` and the operator `AGENTBROWSER_DEFAULT_TTL_MS` override
  unchanged in precedence), and the per-page diffable revision history 8 → **10**
  (`sinceRevision` window). The application-authority TTL cap (3.5 h on control-plane
  application sessions, a separate subsystem) is unchanged.

### Added — compact observation output (CLI-first agent token reduction)

Design review and prior art: `docs/agent-handoffs/AGENTBROWSER_COMPACT_OUTPUT_REVIEW_2026-10-09.md`.
Measured on the OVH-Manager-shaped benchmark fixture (373 elements) against real Chromium:
full observe 27,462 B vs role+name projection 986 B and dialog scope 1,305 B — **96% reduction**
with the dialog's checkboxes found even where the default 300-element window truncated them away.

- **`observe` compact projection (opt-in)**: `roles` (exact), `name` (case-insensitive
  substring on names only, never values), `scopeRef` (subtree slice within the scope
  element's snapshot block), `limit`, and `includeFields` (`href`/`attributes`/`required`;
  the protected core — `ref`, `role`, `name`, `value`, `valueRedacted`, `checked`, `risk`,
  `focused`, non-default `visible`/`enabled`, `depth`/`block` — is never droppable).
  Responses carry a `projection` echo (`matched`/`total`) so a subset can never read as
  the whole page. Projection runs after secret redaction and before the byte budget;
  refs keep being minted over the full page, so filtered-out elements stay actionable.
- **Scope refs obey ADR-004**: an older-revision scope fails `STALE_TARGET`, a removed
  element fails `TARGET_NOT_FOUND` — never a silent empty result. Names cap at 200 chars
  (`nameTruncated`, mirroring `hrefTruncated`). Under `sinceRevision`, `changes` are
  filtered by the same predicate.
- **Element `depth`/`block` metadata** (engine a11y parse, stamped only when non-zero):
  block-local nesting and merged-frame block identity — the basis for scope slicing;
  flat top-level output is byte-identical.
- **Element-list cursors address page ordinals** under projection (`remaining` counts
  matches only); `budgetObservation` gained an `ordinals` mode whose identity case
  reproduces the previous index arithmetic exactly.
- **CLI**: `--roles/--name/--scope-ref/--limit/--include-fields` on `observe`;
  `--json` is minified by default with a new `--pretty` flag; the default text render
  now prints the continuation cursor (`--continue-from N (K elements remain)`),
  `[redacted]` markers and the focused element, plus the projection echo. An older
  server's rejection of projection options maps to an actionable error.
- MCP `browser_observe` and the REST API pick the projection fields up from the shared
  protocol schema (no adapter changes); OpenAPI and the MCP catalog digest regenerated.
- Benchmarks: `/ovh` fixture and `runCompactProjectionBenchmark` A/B (success parity is
  part of the `benchmarks run real` gate). The act result's existing lean keep-list is
  pinned by a regression test (`act-response-shape.test.ts`).

## [1.15.2] — 2026-10-06

### Security — TD-BROWSER-13: observation secret redaction (release blocker)

- **Password values no longer leak through observations.** Playwright's aria snapshot
  carries password inputs as plaintext `textbox` values; a trusted sensitivity boundary at
  the DOM-binding point now withholds them from observations, the ref store, semantic
  fingerprints, diff caches and every downstream envelope. Policy: native password/hidden
  inputs, `autocomplete` `current-password`/`new-password`/`one-time-code`/`cc-number`/
  `cc-csc`/`cc-exp`, and explicit `sensitive` fills (the classification persists for the
  element's lifetime across show-password toggles and revisions). Elements whose type
  cannot be established fail closed — values are dropped, never carried as fallback.
  Ordinary form values are preserved for bulk-autofill verification.
- New `PageElement.valueRedacted` (and `NativeFormControlEvidence.valueRedacted`) marks
  withheld values: absent `value` + `valueRedacted:true` means "withheld", not "empty".
  Native form evidence keeps hidden-input values (documented exception: the application
  witness's hidden-drift tamper check needs page-generated tokens; hidden inputs are not a
  user-typeable channel). The Safari and Firefox engines enforce the same policy at their
  describe boundaries (Safari via its observe/fill scripts, Firefox extending its existing
  password gate to hidden, credential autocomplete, and explicitly marked fields), so the
  withholding is engine-neutral, not Playwright-only.
- Autofill receipts for sensitive controls report `unverified` + `verificationWithheld`
  instead of a false value mismatch.
- Approval-gate action fingerprints use a per-instance keyed HMAC (they cover full action
  JSON including fill values; unkeyed digests of low-entropy secrets were brute-forceable).
- **CLI/SDK/API fix**: `sessions.events` object selectors always resolve to the
  `{events, nextCursor}` envelope — `--limit` without `--since` used to return a bare array
  and crash the CLI's formatted output (`envelope.events.map`); an unfiltered selector now
  returns the merged console+request ledger instead of an always-empty envelope.
  *Behavior change*: a type-only object selector (e.g. `events(id, {type})`) previously
  returned a bare array at runtime despite the declared envelope type — callers that
  relied on the runtime array must read `.events` now; the undefined/string selector
  keeps its legacy array shape.
  Design + honest boundaries (screenshots, raw HTML, page-side exfiltration):
  `docs/td/TD-BROWSER-13-observation-secret-redaction.md`.

### Added — task T7 (audit/security), slices 2a/1/3

- **Engagement scope enforcement** (`policy.scope` on session create; MCP `browser_create`
  `scope`; CLI `session create --scope-file`): hosts/paths/methods/identity-bindings/
  expiry/request-budget enforced per request and per redirect hop by `EngagementScopePolicy`
  as the outermost restrict-only layer of the session's policy chain
  (`SCOPE_*` typed denials). Design: `docs/spec/design/t7-scope-enforcement.md`.
- **Audit adapters** (`@agentbrowser/audit`, outside the default dependency closures):
  visual (pixelmatch-wrapped, versioned baselines with explicit saves) and
  accessibility (axe-core in a Node DOM over captured HTML — page scripts never
  executed; layout-dependent rules recorded as incomplete, never passing). Design:
  `docs/spec/design/t7-audit-adapter.md`.
- **Scanner-regression adapter**: bounded OWASP ZAP API client with scope
  enforcement, poll budget, and acknowledged-baseline comparison over
  `(pluginId, url, parameter)` signatures; the real-ZAP recorded run executed
  against ZAP 2.17.0 (seeded reflected-XSS confirmed high). Design:
  `docs/spec/design/t7-scanner-regression.md`; evidence:
  `docs/spec/evidence/t7-scanner-regression.md`.
- **Shared finding-baseline store** (`FindingBaselineStore`): the
  versioned persistence half for the finding adapters — explicit
  versioned saves (never overwrite; temp+rename manifest), latest-on-
  load, retained history, strict filename-component labels, typed
  errors for corrupt/unsupported manifests.

### Added — C4b execution requirement

- **`executionRequirement: 'ephemeral' | 'durable'`** optional field on
  application execute (C4b: missing normalizes to `ephemeral`; `durable`
  requires a qualified durable journal store and refuses typed when the
  runtime cannot satisfy it — the refusal does not reserve an identity
  or consume approval). Discovery surfaces `writeExecution` with the
  supported requirements. Trusted deployment configuration
  (`durableJournalAvailable`) — never settable from session or request
  input. Design: `docs/spec/design/t5-journal-control-views.md` (C4b).

### Added — records and procedures

- N2: the OS-enforced egress pairing documented as the T7 prerequisite
  (`docs/spec/design/t7-os-egress-pairing.md`; enforcement NOT SHIPPED).
- T5: the operator quarantine/reconciliation procedure for journal stores
  (`docs/spec/design/t5-operator-reconciliation.md`); the read-only-filesystem
  and disk-full qualification lanes (deterministic max-page mechanism);
  the C4b precondition audit (all five delivery gates pass; the F3
  authorization is the remaining gate).

### Qualified — installed harness

- T1: cursor consumption/retirement choreography through the Codex provider
  path (all seven cursor fields delivered; takeover revocation, fresh-grant
  recovery, old-epoch refusal).
- T8: provider-path resilience (service down / restored / blackhole timeout —
  uncertainty discipline surfaced honestly); slice-2 acceptance dimensions
  (union, enum, nested-object/array inputs, typed evidence) and the full
  cursor choreography through the same path.

## [1.15.1] - 2026-10-03

### Fixed

- Large site JavaScript responses can now be admitted using the operator-owned
  `AGENTBROWSER_MAX_RESPONSE_BYTES` startup setting. The default remains 10 MiB;
  a validated override accepts 1 byte through 64 MiB (for example, 33554432 for
  32 MiB). Session requests cannot raise the cap. Malformed settings fail startup,
  and SSRF and host restrictions remain intact. This does not change download or
  extraction budgets and is not a peak-memory guarantee for buffered adapters.
- Server and CLI usage documentation explains response-size policy failures and
  configuring a separate service without disrupting active browser sessions.

This maintenance release backports only the response-cap fix from develop onto
v1.15.0; unreleased engagement-scope and other develop features are not included.

## [1.15.0] - 2026-10-01

### Added

- Child-frame observation and ref binding (T6): `observe` walks child
  frames (depth-capped, per-frame snapshot slices) and merges their
  content into one deterministic ref list; bindings are frame-scoped
  with per-frame ordinals, so embedded-application content is visible
  and actionable — duplicate labels across frames bind independently.
- Frame coverage surfacing: uninspectable frames (`timeout`,
  `unavailable`, `depth_exceeded`, `budget_exceeded`) surface a bounded
  `frameCoverage` block through the observation schema instead of
  silently partial content; iframe nodes are no longer bindable refs.
- Frame-scoped form identity: form-identity evidence for frame-owned
  controls evaluates against a per-frame identity state (the main-frame
  limitation is lifted); act-time re-verification routes through the
  owning frame.
- Per-frame snapshot slices: frame captures draw an even split of the
  remaining snapshot envelope, so one slow frame cannot starve the rest;
  a spent envelope reads as `budget_exceeded` coverage per frame.
- Session event replay outside REST (N1): `browser_events_replay` MCP
  tool, `session events --since/--limit` CLI paging, and the SDK paged
  overload over the bounded event ledgers; uncaught page exceptions are
  captured as redacted `page.error` events.
- Operator loopback opt-in (`AGENTBROWSER_ALLOW_LOOPBACK`): disables the
  loopback egress block for all sessions on the server (local-machine
  testing against 127.0.0.1 dev servers). Startup-only; metadata
  blocking and session host restrictions still apply; visited pages can
  reach loopback services including the server's own API — see the
  operations table and threat model.

### Changed

- All-hop egress enforcement: redirect chains are walked in the routing
  choke point with per-hop policy checks, a redirect cap, and loop
  detection — the later-redirect policy bypass (R4) is closed; a denied
  terminal is never fetched.
- Journal horizons are monotonic across wall-clock rollback: admission
  and retention use max(now, persisted high-water); a reopen below the
  persisted high-water refuses as configuration.
- T8: the installed 1.14.0 MCP tool-call path and cursor
  consumption/retirement lifecycle are qualified on the record machine;
  explicit footprint gates (peak RSS on the shipped binaries) run in CI.

### Fixed

- The storage manager's dispose drain is bounded; a navigated child
  frame can no longer leave form evidence dead; journal manager
  hostile-frame and late/duplicate-reply hardening; footprint and
  per-frame snapshot-slice gates enforce the recorded budgets.

### Docs

- The tooling comparison (AgentBrowser vs Chrome debug mode,
  chrome-devtools-mcp, assistant-vendor browser integrations), the
  frame-observation and N1 designs, the installed-harness
  qualification records, and the foundation-first plan refinements.

## [1.14.0] - 2026-09-30

### Added

- T5 journal foundation, storage-neutral and internal (no public durability
  yet): a bounded journal manager with a dedicated storage child process and
  an adapter factory over the SQLite owner/anchor primitive; runtime
  selection, concrete store enablement and recovery remain gated behind the
  remaining resource and packaging acceptances.
- J2b.3 qualification gates: the full process-loss matrix (before-intent,
  after-commit, after-anchor barriers and the caller-timeout rule), the
  adversarial and bounded-resource matrix, and a packaging gate proving the
  extracted candidate resolves the storage child in a clean install. The
  journal gates run as a blocking CI job (promoted from a canary after the
  wedge root-cause and gate repairs).
- The journal manager's dispose drain is bounded (#319): shutdown can no
  longer wait indefinitely on a wedged storage child.

### Docs

- T8 installed-harness records: named-version availability (CLI-path
  delegated flows, Codex listing fidelity, two Victor infrastructure
  blockers with unblock paths) and footprint measurements for the installed
  harnesses.

## [1.13.0] - 2026-09-27

### Added

- `AGENTBROWSER_CHROMIUM_ARGS` operator escape hatch: extra Chromium launch flags,
  space-separated, applied to **headed chromium launches** only. Motivated by Chrome's
  Local Network Access enforcement against LAN-hosted consoles. The headless pool keeps
  stock launch defaults, firefox/webkit launches never receive the flags, and both CDP
  attach paths (`cdpEndpoint`, operator attachment) cannot apply launch flags at all —
  the engine logs a one-time warning at construction when the variable is set there.

### Changed

- Biome warnings cleared across the repo: every `warn`-level finding in production
  sources is fixed individually, `noExplicitAny`/`noNonNullAssertion` are promoted from
  `warn` to `error` in source, and both rules are scoped off for `**/*.test.ts` and
  `**/test-support/**` (test assertions rely on `!` throwing and test doubles need
  `any`; biome's autofix for nonNull is semantics-changing). All 16 workspace packages
  now declare a `lint` script, so `pnpm -r lint` actually checks the previously
  unlinted core/engine/protocol/testkit packages.

## [1.12.0] - 2026-09-25

### Added

- Observed browser/context disconnection ends the exact affected session, revokes
  delegated authority, and reports `engine_disconnected` through the existing
  REST/SDK/CLI/MCP terminal projection. Intentional teardown and page-only close
  remain distinct; no operator intent, crash diagnosis, reconnect or replay is inferred.

- Opt-in local operator Chrome attachment via `session create --cdp-attach`, REST/SDK
  `cdpAttach`, and MCP `browser_create.cdpAttach`. Requires a dedicated profile,
  bearer authentication, a loopback endpoint and an explicit startup acknowledgement of limited network checks.
  Shared diagnostics identify attachment and policy limitations; detach preserves
  operator tabs and the browser. Hosted, multi-tenant and delegated use refuse.

- Navigation failures carry bounded reasons across REST, SDK, CLI and MCP, distinguishing
  egress denial, unresolved names, resolver timeout/refusal, destination connection
  refusal, TLS refusal and browser error documents. CLI returns exit 1 and MCP sets
  `isError` for blocked/timeout results. Unknown causes remain `engine_error`.

- Sampled active-session lease deadlines on REST/SDK create/get/list, CLI and MCP
  inspection. A shared coordinator clock reports absolute TTL and idle deadlines;
  reading session status does not renew idle lifetime. Closing/failed sessions and
  older servers may omit the lease. No terminal history or recovery is implied.

- Bounded, tenant-authorized close facts for recently ended sessions. The coordinator
  distinguishes TTL, idle, explicit and policy termination, retains only detached
  allowlisted facts, and derives remaining lease from the authoritative sample. CLI
  and MCP share the strict terminal-error projector; observed engine disconnection
  uses the same projection.

### Fixed

- Navigation diagnostics come from the trusted routed request, not origin-supplied
  headers. Failed dispatched navigation invalidates old refs, connection errors
  cannot impersonate a browser crash through URL text, and bounded failure output
  retains valid operation IDs for reconciliation without raw transport topology.

- Session initialization rolls back its captured allocation on lifetime-inspection
  failure. Expiry shares teardown ownership, avoids a concurrent second close and
  preserves the existing retry after a settled close failure. A delayed old close
  cannot remove a replacement session.

- Session ID allocation refuses bounded collisions, and late abnormal-teardown
  callbacks use captured context identity before touching a replacement allocation.

### Internal qualification

- Journal intent/dispatch and terminal acknowledgments share authority, replay and
  control-view projections. Application execution revalidates authorization, consent
  and binding pins after storage waits. The SQLite child owner and external commit
  witness have process-loss tests; the raw adapter, runtime selection, bounded manager
  and restart recovery remain gated. This release exposes no durable execution promise.
- Packaged acceptance records bounded phase timings through child cleanup and names
  the active phase on deadline failure. Existing deadlines and behavioral gates stay
  unchanged. Falsy/non-Error callback rejections fail acceptance after owned cleanup.
  Consumer smoke scripts can qualify extracted services with actual Bun
  CLI/MCP binaries through the existing package resolver and workflows.
- The EDGAR research recipe documents JSON submissions, filing discovery, throttling
  etiquette and complete persisted-output inspection.

## [1.11.0] - 2026-09-24

### Added

- Shared launch diagnostics on REST/SDK session create/get/list, CLI JSON and human
  inspection, and MCP `browser_session`. Facts describe actual browser allocation,
  executable selection, viewport policy and init-script registration without paths,
  launch arguments or endpoint credentials. Unsupported adapters omit diagnostics.
- MCP `browser_session` also works without a bound session, using an explicit session
  ID. Inspection requires both `session.control` and `page.observe`; bound inspection
  retains its control and page fields and adds session metadata.

- MCP `browser_page_create` and `browser_pages` reuse the existing SDK/service page
  lifecycle. Pages share their session's cookies and policy; callers use returned IDs.
  Controlled-session creation carries caller-selected operation IDs. Ordinary sessions
  do not gain deduplication, and inventory does not correlate an uncertain create result.

### Fixed

- Release publication refuses duplicate asset names instead of replacing bytes
  under an existing tag, preserving checksums pinned by package managers.

- Session views retain the selected adapter's immutable name/version, including
  auxiliary engines, instead of reading the primary engine on later inspections.
  Capability lookup failures occur before browser allocation and cannot leave an
  unreachable registered session.
- TypeScript SDK `SessionResponse` now reuses the canonical HTTP session view.
  This corrects its previous compile-time claim that `engine.capabilities` was
  returned by these endpoints; that field was never present on the HTTP wire.

- Concurrent Playwright headless/CDP sessions share one pending browser initialization.
  Closing a remote session releases only its context, preserving sibling sessions.
  Failed setup cleans up owned resources; engine shutdown drains pending setup and
  refuses further creates on that engine instance. Service shutdown releases every
  distinct registered engine, including auxiliary pools and connections.

- A resolved Playwright navigation to an internal browser error document now fails
  instead of reporting success. Its diagnostic reason is `browser_error_document`;
  it does not infer a bot wall, disclose the error URL or retry automatically.

- Application discovery, execution (including replay), receipts and operation status
  keep their captured publication authority through HTTP delivery. Late permission
  changes, disconnects and output deadlines suppress unsent responses without
  rewriting committed operation facts. Browser responses and captured operator reviews
  use the same publisher after execution drains and finalizes. Prepare-resume delivery
  failure preserves review state; collection cleanup cannot take over a replacement owner.

- CLI extraction prints complete data instead of silently cutting at 4,000 characters.
  `extract --max-bytes` forwards a UTF-8 response budget through SDK/REST; optional MCP
  exposes the same field. The server enforces one ceiling across all formats (default
  1 MiB, configured at startup with `AGENTBROWSER_EXTRACT_MAX_BYTES`). Oversized results
  fail explicitly without returning partial JSON or evidence.

### Internal foundations

- Storage-neutral operation journal contract with immutable metadata, keyed fingerprints,
  bounded acknowledgment validation and shared adapter conformance tests. Unknown writes
  quarantine further mutations; late acknowledgments cannot restore authority. No concrete
  store, runtime durability setting or restart recovery is enabled.

- Captured operator review views reuse shared page, application and evidence owners
  during their original publication phase. Disclosure checks cannot collect new
  evidence, consume consent or dispatch effects. Durable recovery remains unimplemented.

## [1.10.1] - 2026-09-23

### Added

- SPA-capture robustness. `observe()` now flags an empty-but-successful
  accessibility snapshot over a content-rich DOM (the common
  JS-SPA-not-mounted-yet case) with `degradedReason: "empty-snapshot-nonempty-dom"`,
  distinct from the timeout case, so callers can wait/retry or read via
  `browser_html` instead of mistaking it for an empty page.
- Optional readiness `wait` on `browser_observe`/`browser_screenshot` (and the
  `observe`/`screenshot` CLI commands via `--wait-until/--wait-timeout/`
  `--wait-selector/--wait-pattern/--wait-count`), reusing the `browser_act` wait
  vocabulary. Applied before the snapshot/capture so slow-mounting SPAs do not
  observe empty or screenshot blank.
- Display diagnostics originate on the browser host and pass through REST,
  SDK, CLI, and MCP session responses. Linux checks display environment hints;
  a macOS launchd label alone no longer implies a missing GUI session. Operators
  may declare availability with `AGENTBROWSER_ASSUME_DISPLAY=1` or absence with `0`.

### Changed

- The degraded DOM fallback (`getContentElements`) now covers more ARIA-role
  widgets (`combobox`, `menuitem`, `tab`, `checkbox`, `option`, `contenteditable`)
  and captures a best-effort accessible name, so a timed-out observation stays
  addressable. Empty-DOM thresholds are tunable via
  `AGENTBROWSER_EMPTY_DOM_MIN_TEXT` / `AGENTBROWSER_EMPTY_DOM_MIN_NODES`.

- Capture requests share protocol schemas and runtime validation across REST,
  SDK, CLI, and MCP, including condition-specific wait fields and bounded numeric
  options. Invalid and unsupported options now fail instead of being ignored.
- Screenshot readiness waits reach the HTTP service. MCP also exposes screenshot
  `quality`/`maskSensitive` and observation `sinceRevision`. CLI `describe --schema`
  and MCP output schemas expose the capture contracts; CLI human output reports
  degraded observations. Artifact schemas describe both inline and URL delivery.
- DOM fallback refs bind to the discovered node rather than a guessed accessible
  name, preventing a ref from selecting a different node with a matching name.

## [1.10.0] - 2026-09-23

### Added

- First-class CLI `form prepare` compiles reusable form mappings into bounded,
  block-scoped autofill requests. Scoped stage checks and owned widget popups
  prevent repeated-label and unrelated-option selection (#237–#238).
- Byte-verified uploads accept expected SHA-256 and MIME type. Shared native-form
  evidence and application-owned draft adapters qualify attachment and field
  state across controlled UI/API fixtures (#239, #243–#246, #249).
- Explicit operator-reviewed approvals, application submission reviews and
  payload-bound consent across REST, SDK and CLI. The operator panel supports
  application binding and read-only operation/receipt reconciliation
  (#240–#242, #247–#248, #254, #257, #259, #261–#262).
- Operator-only `AGENTBROWSER_ALLOWED_CIDRS` permits selected private destinations
  at both hostname and DNS-address gates. Defaults remain blocked; loopback,
  metadata and per-session host restrictions still apply. Invalid CIDRs abort
  startup and `/0` emits a warning. Use `/32` for one IPv4 host (#275).
- Offline job-eligibility and listing-review examples use explicit evidence and
  compensation criteria; these are reusable examples, not live job-portal or
  application-submission qualification (#260, #264).

### Fixed

- Application authorization, callback ownership, scoped reads and drain handling
  now reject stale or reentrant owners. Stored application review reads/decisions
  recheck the application authority before evidence-provider invocation and pin
  the original action; provider permission cannot replace application permission.
- Explicitly empty, malformed or conflicting `AGENTBROWSER_API_KEYS` configuration
  now aborts startup instead of selecting anonymous mode. Embedded credential maps
  are copied so caller mutation cannot disable authentication. Unset the variable
  for intentional trusted-local operation; valid `key:tenant` configuration is
  unchanged.
- Engine and HTTP error surfaces use bounded, detached and redacted diagnostics;
  framework logger failures cannot reveal private callback details (#252–#253,
  #255–#256). Document extraction uses the shared stable-read boundary (#263).

### Internal foundations and limits

- Shared dispatch/finalization and bounded publication helpers cover execution,
  lookup, replay and review owners without duplicating authority or operation
  stores (#267, #269–#274). HTTP publication integration, durable journal/recovery
  and restart guarantees remain unfinished; these helpers do not close T5.
- T4/T6 remain partial. No production evidence source is enabled by default; full
  live ATS/job applications, broader widgets and installed external-harness
  qualification remain open. Inbound client CIDRs, OIDC and Basic authentication
  are follow-up designs and are not included in this release.
- CLI and optional MCP executables remain Bun-compiled. The service ships compiled
  JavaScript with production dependencies, qualified on Node 24.21.0. Existing
  browser-egress and platform limits remain as documented in the
  [threat model](docs/threat-model.md) and [release tracker](docs/release-milestones.md).

## [1.9.1] - 2026-09-20

### Added

- CLI cookie-file handoff: `session create --cookies-file <path>` accepts canonical
  JSON, Netscape cookie files or explicitly selected Chrome DevTools TSV. Local
  normalization reuses the session cookie contract and bounded input reader.
  `session cookies <id> --output <path>` creates a private, exclusive JSON export
  and prints only a count/path receipt. Inline `--cookies` remains compatible.
- Completed the bounded T3 regression vertical: shared report contracts, navigation
  reset, CLI `test evaluate`, Node test integration, JUnit/HTML reports, artifact
  links and packaged live qualification (#212, #214, #223, #225–#227, #229–#231).

### Fixed

- Bulk-form verification now checks committed widget state and revalidates the
  original node and block before acting; transient display text cannot stand in
  for a committed value (#232).
- Foundation alignment removes duplicated command/route declarations and pins
  OpenAPI, SDK/CLI/MCP contracts, mode catalogs and verifier composition to their
  shared owners (#213, #215–#221, #224).
- Local development, CI, release packaging and container builds use Node 24.21.0.
  Node 22 remains the supported minimum (#228).

### Qualification and limits

- Cookie files are bounded to 1 MiB and 1000 entries. Malformed, expired, ambiguous
  or unsupported input is refused before session creation. Partitioned cookies
  require explicit whole-entry omission; partition semantics are not supported.
  Existing files and symlink output paths cannot be overwritten. The existing
  packaged acceptance harness exercises all three imports, authenticated navigation,
  private export/re-import and refusal controls with synthetic credentials.
- T3 and widget checks qualify controlled fixtures. Full job applications, popup
  ownership, broader widget coverage, production verification/G6, durable recovery
  (T5) and installed external-harness qualification (T8) remain open. No new service
  endpoint, runtime dependency, MCP tool or CI job is introduced by cookie handoff.
  See the [cookie contract](docs/spec/design/cli-cookie-file-handoff.md) and
  [future job checkpoint](docs/spec/design/t6-job-application-checkpoint.md).

## [1.9.0] - 2026-09-19

### Added

- Completed the T2 shared execution and verification foundation. REST, the SDK
  and the first-class CLI use the existing executor, authority ledger and outcome
  contract; MCP remains optional. Optional `verification.evidenceCorrelationId`
  identifies a business receipt separately from the outer service operation ID
  and grants no permission by itself (#203).
- Scoped application receipt preflight uses authority-owned actor, tenant, mode,
  resource and session-incarnation identity. Deadline-abandoned receipt reads keep
  admission busy until they settle; cancellation or revocation withholds late
  evidence, and operation replay never redispatches writes (#204, #205).
- Evidence sources can require explicit permission for the exact verifier,
  version and bounded input. Generation fences apply through execution, reads,
  evaluation and cleanup. The application receipt helper and narrow deployment
  registry provider compose these checks without another executor or store
  (#206, #207).

### Fixed

- Empty subprocess input now closes stdin without an empty pipe write, avoiding
  an EPIPE race while preserving errors for undelivered nonempty input (#208).

### Qualification and limits

- The existing packaged acceptance job now drives seven real compiled-CLI cases
  and their reconciled replays through an extracted service and Chromium. An
  independent controlled application oracle distinguishes a UI-caused commit
  from a historical receipt, ignored action, failed action, stale state or wrong
  resource, including a lost response after commit (#208).
- This is controlled G4 fixture qualification under an exclusive UI actor
  contract. No production evidence source is installed by default. Deployments
  must register trusted verifiers/sources and explicitly authorize protected
  predicates. Production UI/API parity and G6 remain T4 work; durable recovery
  remains T5. The user-facing QA regression/reporting vertical (T3) is ready to
  begin, not included in this release. See the
  [foundation qualification](docs/spec/evidence/t2-foundation-qualification.md).
- Existing application REST/SDK/CLI commands, bulk-form strategies and outcome
  semantics remain available. No new MCP tool, dependency, package or CI job
  was added for this foundation checkpoint.

## [1.8.20] - 2026-09-17

### Added

- Application authority over REST/SDK/CLI (shared-infra slice 2): operator
  binding via `PUT/DELETE /v1/sessions/{id}/application`, delegated discovery
  (`GET .../application`), execution (`POST .../application/execute`) and
  receipt lookup (`GET .../application/receipts/{operationId}`), backed by
  deployment-injected `applicationAdapters`. A repeated operation ID returns
  the recorded operation as a first-class `{replay, operation}` result (never
  re-executes, never surfaces as OPERATION_RECORDED). SDK `sessions.application*`
  methods and an `agentbrowser application` command group (bind/unbind/
  discover/execute/receipt; the global `--operation-id` is the WRITE identity —
  reads must omit it, they refuse a write identity). New
  `application.discover`/`application.execute` delegated
  capabilities granted only to the dedicated `application` agent mode; browser
  modes stay fenced out. Binding is impossible in unauthenticated local mode;
  without adapters the surface fails closed.

## [1.8.19] - 2026-09-17

### Added

- Qualified multi-step widget strategies for react-select single-select and
  chip-multi-select in the autofill orchestrator. React-select commits via
  click-open → per-char typeText filter → fresh-observe exact match click;
  chip-multi-select commits by typing the filter text and clicking the
  matching chip option. Both verified via post-commit chip text or
  committed-attribute evidence (#191).
- `ServiceActRequest` gains `delay` for typeText per-char pacing (#191).

### Fixed

- MCP tool catalog regenerated from the current build (#191).

## [1.8.18] - 2026-09-16

### Added

- CLI full parity with the REST/MCP/SDK surfaces: `autofill` (payload inline,
  `@file`, or stdin; `--policy` override; per-field receipt render that omits
  values and redacted excerpts), `pdf`, `health [--ready|--live]` (exit 1 when
  unhealthy), `artifact get --out`, `page list/get/close`, `page create --url`,
  `session get`, and `download` + `download collect`.
- Flag completions: `screenshot --quality/--mask-sensitive/--out`,
  `observe --since-revision`, `extract --records`.
- SDK: three health methods, `SessionsClient.download`/`collectDownload`, and
  the `parseAutofillRequest` re-export.

### Changed

- Recipe: deterministic keyboard-menu commit procedure (type-to-filter →
  short walk → Enter), the focus-purity rule for keyboard menus, and
  targeted-press-`Delete` chip removal (#170).

## [1.8.17] - 2026-09-16

### Added

- Native scoped bulk autofill: `POST /v1/sessions/{sid}/pages/{pid}/autofill`
  (SDK `sessions.autofill`, MCP `browser_autofill`) accepts a field payload
  upfront (1-50 fields; match by role/label/labelRegex/dataAutomationId with
  optional fieldset block scoping) and the service owns the serial
  resolve → act → reobserve → verify loop, returning per-field verification
  receipts plus a whole-page HTML artifact reference (#174). Native
  text/email/tel/url/search/number inputs, textareas, and native single
  selects are delivered; React-Select/active-descendant comboboxes, chip
  multi-selects, password/file/multi-select inputs are refused with receipts
  rather than guessed at. Values support `vault://` references; operation IDs
  cover the whole batch for delegated sessions; the final pass rechecks all
  previously verified fields. See `docs/bulk-autofill.md`.

## [1.8.16] - 2026-09-15

### Added

- `typeText` action: real per-character keystrokes (focus + per-char
  keydown/textInput/keyup, optional inter-character `delay` 0-1000ms) for
  widgets that ignore programmatic value setting — search-as-you-type boxes,
  typeahead filters, keystroke-driven masks. Chromium implements it; Firefox
  and Safari refuse the action like other unqualified engine features.
  Value bounded at 5000 characters (#170).

### Changed

- Recipe: deterministic keyboard-menu commit procedure (type-to-filter →
  short walk → Enter), the focus-purity rule for keyboard menus, and
  targeted-press-`Delete` chip removal (#170).

## [1.8.15] - 2026-09-15

### Added

- `count` on `press` (1-20, default 1): the keypress repeats inside a single
  action and one revision bump covers the run (#165). Spinbutton-style
  controls need repeated keypresses, and the revision bump from each
  individual press invalidated the ref before the next one, costing an
  observe round trip per press. Surfaced through the protocol, engine
  (Chromium), CLI `act press --count <n>`, and the MCP `browser_act` schema;
  Firefox and Safari refuse the option instead of silently pressing once.

### Changed

- Fill verification (`expectValue`) re-reads once after a short settle before
  failing (#164). The single post-fill readback raced late async
  normalization on production form widgets and reported `VALUE_MISMATCH` for
  values that had landed. The write is still never replayed.
- Non-sensitive `VALUE_MISMATCH` errors now carry `expected` and `actual` in
  details, making the widget's normalization visible without a separate HTML
  round trip (#164). `sensitive: true` fills and password inputs keep the
  value-free error contract.

### Fixed

- A partial counted-press run (a press fails after earlier ones landed)
  bumps the revision; previously the bump was skipped, leaving pre-run refs
  trustworthy after a page mutation (#165).

### Docs

- Interactive-forms recipe: keyboard-commit pattern for select/multi-select
  widgets (arrow walk + Enter; highlight starts at the current value),
  locale selectors resetting dependent blocks, digits-not-display-text for
  spinbutton fields, commit probing via the trigger control's accessible
  name, and `sensitive` fill guidance (#166).

## [1.8.14] - 2026-09-15

### Added

- Page `GET /v1/sessions/{sid}/pages/{pid}` now returns `url` and `title`
  (both secret-redacted) instead of a fixed shell (#152).
- `include: ["formControls"]` on observations mints refs for interactive
  controls the ARIA snapshot misses (div-based widget triggers carrying
  `data-automation-id`, `aria-haspopup`, or inline handlers), bound like any
  ref with document-level evidence (#153). ADR-021.
- `browser_html` MCP tool returning the page HTML inline as ground truth for
  widget state (#153). ADR-020.
- `continueFrom` on `browser_observe` to resume a truncated observation from
  its continuation cursor (#153).
- `checked` on observed checkbox/radio/switch elements, end to end (#154).

### Changed

- `fill` accepts `expectValue`: post-fill readback with `VALUE_MISMATCH`
  (HTTP 422) on disagreement (#154). Single-write contract per the
  coexistence integration evidence.
- Workday-class long-form patterns documented in
  `docs/recipes/interactive-forms.md` (#155).

## [1.8.13] - 2026-09-14

### Changed

- Default session TTL raised from 15 minutes to 3.5 hours (`SessionCoordinator`
  default; operator override `AGENTBROWSER_DEFAULT_TTL_MS` unchanged, per-session
  `ttlMs` still wins). Long flows keep their session across a working block, but
  a session that outlives usefulness now occupies its browser slot 14x longer.
  To retain the previous window: `AGENTBROWSER_DEFAULT_TTL_MS=900000`.

## [1.8.12] — 2026-09-13

### Added

- Per-session `snapshotTimeoutMs` override (1-30000ms) across the protocol,
  API, core, CLI (`--snapshot-timeout`), MCP server (`browser_create`), and
  Playwright engine (#143), for sessions known to navigate large or complex
  pages where the default whole-page ariaSnapshot budget would be exceeded.

### Fixed

- `observe()` no longer silently degrades on large/complex forms (#143). The
  whole-page ariaSnapshot budget default is raised 1000ms → 5000ms; when the
  budget is still exceeded, observations now carry an explicit
  `degraded: true` / `degradedReason: "aria-snapshot-timeout"` marker on
  `browser_observe` and `browser_snapshot` responses instead of returning a
  DOM-tag-only element list with no names, values, or custom widgets and no
  signal. Independent per-element `isVisible()`/`isEnabled()` reads are
  parallelized instead of one sequential round trip per element, removing the
  main source of outright observation timeouts on pages with hundreds of
  elements.

## [1.8.11] — 2026-09-13

### Added

- Explicit, off-by-default `allowServiceWorkers` session option across the
  protocol, API, core, CLI, MCP server, and Playwright engine (#140). Callers
  can enable service-worker-dependent functionality for one session while
  accepting that service-worker-originated requests bypass routing-based
  egress checks. Sessions with an active request policy still block service
  workers by default; see
  [ADR-019](docs/adr/019-explicit-service-worker-opt-in.md).

### Fixed

- Headed Playwright sessions now expose a locale-derived `navigator.languages`
  chain including the base language fallback without duplicates (#140), such
  as `["en-US", "en"]` or `["fr-CA", "fr"]`. Headless behavior is unchanged.
  Live effectiveness of this change and the service-worker opt-in against
  the observed Ashby ATS rejection remains unproven.

## [1.8.10] — 2026-09-12

### Fixed

- Egress choke point (`installEgress()`) corrupted body-bearing uploads: its
  `route.fetch()`/`route.fulfill()` replay did not preserve request bodies
  with the fidelity some upload flows require, causing signature-checked
  multipart uploads (e.g. S3 presigned-POST, a common direct-to-cloud-storage
  pattern) to fail with a 400 even though the identical request succeeds when
  sent natively (#137). `POST`/`PUT`/`PATCH` requests now take the same
  hostname/IP-range verdict check but call `route.continue()` instead,
  leaving `GET`/`HEAD` on the original fetch/fulfill path for redirect-hop
  and response-size inspection. The SSRF-relevant guarantee is unchanged;
  what's given up for these methods is redirect-hop re-checking and
  response-size/body-size capping — see
  [ADR-006](docs/adr/006-network-egress-policy-ssrf.md).

## [1.8.9] — 2026-09-11

Post-release hardening for the `upload` action and the hidden-file-input
discoverability follow-up (PRs 130–132). Strictly additive or
refusal-improving; no route was removed.

### Added

- `observe` enrichment token `fileInputs` (`include: ["fileInputs"]`): mints
  revision-scoped refs for every `input[type=file]` on the page — hidden ones
  included — as `role:"fileinput"` elements carrying `attributes`
  (`id`, `accept`, `multiple`) and a resolved name (aria-label → `label[for]`
  text → `name` → `id`). Available across the HTTP API, the `browser_observe`
  MCP tool, the CLI (`observe --include fileInputs`), and the TypeScript SDK.
  Untargeted `upload` on a multi-input page refuses with `TARGET_AMBIGUOUS`
  details naming every discovered input (`count`, `inputs[]`, `advice`), so
  the observe-and-target advice is actionable exactly where it fires.

### Changed

- Targeted `upload` is exempt from the targeted-action visibility gate:
  hidden Dropzone-style inputs are targetable by ref. `TARGET_DISABLED` still
  applies, and targeted upload now passes the executor's full staleness gates
  like every targeted action — a detached ref refuses with retryable
  `STALE_TARGET` instead of mis-attaching.
- The CLI `act upload` accepts the file path(s) in the ref slot when no ref
  is given, making the no-target single-input form reachable from positionals
  (the empty-string `''` workaround is no longer needed).

### Fixed

- Upload adversarial-review hardening (#130): the server binds `127.0.0.1` by
  default (was `0.0.0.0`; an explicit `HOST` still wins), non-regular files
  refuse with `INVALID_REQUEST`, non-absolute paths are rejected before
  engine contact, acting on a non-file element normalizes to
  `INVALID_REQUEST`, and plan step results carry the upload evidence payload.

## [1.8.8] — 2026-09-11

Native file attachment for agents (PR #128, [ADR-018](docs/adr/018-upload-action.md)):
the one capability the Dice-class real-world flows exposed as genuinely missing —
attaching a local file to a page's `<input type=file>` without the native OS
picker or any JS injection.

### Added

- The `upload` wire action: `{ action: "upload", target?: { ref }, paths: [...] }`.
  `paths` **replace** the input's current file list (setInputFiles semantics).
  `target` is optional because hidden file inputs — the common case — never
  appear in the ARIA snapshot and therefore get no ref; no-target mode binds
  the page's only `input[type=file]` and refuses honestly otherwise
  (`TARGET_NOT_FOUND` at 0, `TARGET_AMBIGUOUS` with `{count}` at >1).
- Path validation before page contact: each path is `fs.stat`-checked
  server-side; a missing file is `INVALID_REQUEST` and the revision is
  untouched.
- Evidence over assertion: the act response carries
  `result: { success, files: [{name, size}], inputFiles?: [names] }` —
  `files` from stat of the validated paths, `inputFiles` read back from the
  live input before the revision bump. Only `upload` produces a per-action
  payload; other actions keep the bare wire shape.
- Delivered across every surface from the single action-type tuple
  ([ADR-015](docs/adr/015-cross-package-contract-single-source-of-truth.md)):
  HTTP `act`/`plan`, `browser_act` MCP tool, CLI `agentbrowser act upload`,
  OpenAPI schema, TypeScript SDK, and FakeEngine (which advertises the
  delivered tuple, so it now delivers what it claims).
- [ADR-018](docs/adr/018-upload-action.md) and a new section in
  [synthetic input limitations](docs/synthetic-input-limitations.md): attach
  files through `upload`, never by clicking the picker.

### What this does not claim

- No native-picker bypassing and no `isTrusted` claims: the input is set
  through the browser's own file machinery, and events the page observes
  remain synthetic.
- Safari engine returns `ENGINE_UNSUPPORTED` for `upload` (safaridriver has
  no equivalent primitive).
- Risk classification is unchanged (ADR-007); operators who want to gate
  uploads add an `{action: "upload"}` rule.

## [1.8.7] — 2026-09-09

Post-release smoke findings batch (PRs 119–123): empty-body request tolerance,
session page visibility, branded-Chrome headed launches, and the deterministic
`records` extraction format (TD-12), plus its docs. Behavior changes are
strictly additive or fix incorrect rejections; no route was removed.

### Added

- `records` extraction format: list extraction with plain CSS selectors —
  `container` plus per-field selectors evaluated within each matched record —
  returning `Record<string,string>[]` with per-record evidence (`url`,
  `revision`, `hash`, `index`). Available across the HTTP API, the
  `browser_extract` MCP tool, and the TypeScript SDK types. Invalid selectors
  are rejected with `INVALID_REQUEST` (400) naming the offending selector.
- `pages` count on session create, get, and list responses (sessions are
  page-less by default; the count makes that contract visible).
- `url` parameter on page creation: the page navigates during creation, so the
  listed page url is the requested one. A failed navigation tears the page
  down and surfaces the error instead of stranding a registered page.
- Branded Chrome support for headed sessions (ADR-016): detected Google
  Chrome is preferred over bundled Chromium (`AGENTBROWSER_CHROME_PATH` still
  wins; `AGENTBROWSER_PREFER_BUNDLED=1` forces bundled, e.g. for CI). The
  selected binary is logged at headed session create.
- Documentation: cookie seeding requires the `name/value/domain/path` wire
  form (url-form is rejected), export via `GET /v1/sessions/{id}/cookies` is
  compatible, and empty `cookies: []` is a silent no-op.

### Changed

- Headed sessions default to a window-true viewport (`viewport: null` plus
  `--start-maximized`) instead of the pinned 1280×720; an explicit viewport
  still pins in both modes and headless is unchanged.
- `links` extraction parses anchors with a real DOM (linkedom) instead of a
  regex, so nested-anchor text and `>` inside attribute values are extracted
  correctly.

### Fixed

- Requests carrying `content-type: application/json` with a zero-length body
  are no longer rejected with 400 (`FST_ERR_CTP_EMPTY_JSON_BODY`); the empty
  body resolves to undefined and routes handle it, while malformed JSON is
  still a 400.

## [1.8.6] — 2026-09-08

Act and wait robustness, richer observations, popup lifecycle, and inline
artifact payloads (PRs 104–107, adversarially reviewed), plus the T2c1
destination-policy and session-owned TCP admission prerequisite (PR 108).
Everything user-facing is additive or strictly opt-in: new wait conditions and
act options default off, new observation fields ride `include`, and existing
error semantics only gain detail fields. No route was removed and no default
behavior changed.

### Added

- New delivered wait conditions, usable both in `wait` and per-act:
  `urlPattern` (glob or `/regex/`), `selectorVisible`, and `minElements`.
  Conditions the engine cannot evaluate natively are polled by the service
  with a bounded deadline; a `timeoutMs` of 0 no longer means "wait forever"
  anywhere (floored at 1ms).
- Opt-in act remap (`remap: true`): when a reference's binding went stale, the
  service takes a fresh observation and re-targets only when exactly one
  candidate matches the original role + name; the response reports
  `remap {from, to}`. Live semantic evidence (a fingerprint mismatch) is never
  remapped — only binding staleness is healable.
- `/act` batch form: `{"steps": [...]}` of 1–20 flat actions, executed
  sequentially with stop-on-first-error, per-step results, and the plan-grade
  self-heal for pre-observed references.
- ACTION_TIMEOUT diagnostics: when an action times out on a target, the error
  details carry `blockedBy {tag, role, name}` from an engine hit-test and a
  diagnostic screenshot artifact id. Diagnostics are best-effort and can never
  outlive the error itself.
- Observe opt-ins via `include`: `"overlays"` returns aggregate blockers
  `{tag, name, covers}` (capped at 30 visible elements), and link elements
  carry their raw `href` (capped at 2048 chars with `hrefTruncated`).
- Act validation errors now list the sorted `validActions`, and the deprecated
  `type` alias is accepted (with a warning) when `action` is absent.
- Inline artifacts: screenshot, pdf, and html responses carry
  `inline {contentBase64, byteSize}` when the artifact is under
  `AGENTBROWSER_INLINE_ARTIFACT_MAX_BYTES` (default 256 KiB, clamped to
  0–10 MiB, invalid values fall back to the default). The artifact is still
  registered in the store either way.
- Popup lifecycle: popups opened by session pages are auto-adopted — they
  appear in the page list with `openerPageId`, emit `page.created`, and are
  fully operable. `page.crashed` is emitted, and a silent engine stream end
  fans out `page.destroyed {reason: "streamEnded"}`. Adoption is serialized
  per session and capped at 20 popups per session. Popups opened with
  `rel="noopener"` have no opener and are never adopted.
- T2c1 gateway prerequisite: destination-policy adaptation produces explicit
  immutable request/destination pairs (TCP-only coverage; one extracted host
  predicate preserves exact/suffix, deny-first and empty-allowlist semantics),
  and sessions own a shared TCP admission scope (8 concurrent slots under the
  32-slot cap) used by downloads. No CONNECT listener — T2c2/T2c3 remain open.

### Changed

- `STALE_TARGET` and `TARGET_NOT_FOUND` refusals carry structured details
  `{ref, revision, role, name}` and a `remapEligible` marker restricted to
  binding staleness; a caller's own `expectedRevision` mismatch or a live
  fingerprint mismatch stays ineligible for remap.

### Docs

- New guides: [human handoff](docs/human-handoff.md) (working a session with a
  person in the loop) and [synthetic input limitations](docs/synthetic-input-limitations.md)
  (what `isTrusted: false` costs and what works).

## [1.8.5] — 2026-09-07

Observation resilience for pages whose elements never stabilize, page
discovery, a longer default idle window, and validated semantic evidence
behind the recovered bindings (PRs 91–98).

**Upgrade notice:** 1.8.5 is the owner-selected release label, not a bug-fix-only
SemVer patch. The page-listing API is additive, idle sessions live longer by
default, and custom network-policy embeddings require migration for downloads.
See [upgrade requirements](docs/operations.md#upgrading-from-184-to-the-185-candidate)
before deployment; private package manifests do not waive embedding compatibility.

### Added

- `GET /v1/sessions/:sessionId/pages` lists a session's pages in creation
  order with each page's cached URL when available — the discovery path
  when a create-page response was lost, and the answer to which page ids are
  live in a session.
  URL metadata is secret-redacted, may lag navigation, and is omitted when the
  engine has no synchronous cache; listing never waits for browser URL I/O.

- Trusted in-process `buildServer({ networkPolicy })` configuration now forwards
  the existing service policy option; session policy remains restrict-only.
  No HTTP option or stock-default relaxation is introduced.

### Changed

- The default session idle timeout is now 10 minutes (previously 2). The
  default remains operator-tunable via `AGENTBROWSER_DEFAULT_IDLE_TIMEOUT_MS`
  and per-session `idleTimeoutMs` still wins.

- Private, bounded TCP connection-authority primitive with revocation, retained
  in-flight admission and connected-peer verification, backed by deterministic
  and real HTTP/TLS tests. Direct downloads now use it per session generation,
  with shared transfer/socket admission, cancellation before engine teardown,
  logical-host TLS verification and bounded terminal diagnostics. No new
  browser-containment guarantee or public route is exposed.

### Fixed

- Pages whose elements never stabilize — a perpetually animating shared
  header, a hydration loop — no longer fail the whole observation. Per-element
  aria snapshots that cannot stabilize degrade instead of erroring, and the
  recovered bindings act only on validated semantic evidence: evidence is
  fixed-size and provenance-locked at observation, timed-out element captures
  fall back to whole-document evidence that must still match at action time,
  and actions without available semantic evidence refuse with a retryable
  `STALE_TARGET` instead of proceeding on DOM identity alone. One monotonic
  budget bounds snapshot waiting across the document and all elements, and
  `AGENTBROWSER_SNAPSHOT_TIMEOUT_MS` (or the `snapshotTimeoutMs` engine
  option) accepts integer values 1–30000 ms; invalid environment values fall
  back to the default while invalid explicit options throw.
  An observed named control that cannot be safely rebound after total snapshot
  timeout also returns retryable `STALE_TARGET`; unknown refs remain missing.

- Server tarball packaging no longer retains pnpm's API self-link back into the
  build checkout. PR and release CI share extracted-package real-browser checks,
  artifact validation and matching-client workflows before publication.

- CLI commands forward `--api-key` (or `AGENTBROWSER_API_KEY` when no flag is
  supplied) to the SDK, allowing commands against authenticated servers.

- Cancel direct downloads on session termination and prevent late artifact
  publication. Preserve one overall deadline across redirect/body policy work,
  enforce encoded and decoded byte limits, and drain each redirect's lease.
  Download-enabled sessions capture a fixed policy snapshot; custom policies
  must explicitly support immutable snapshots instead of silently losing rules.

- Classify mapped/expanded IPv6 addresses consistently for configured loopback,
  private-network and metadata policy rules. Reject malformed or scoped resolved
  addresses, ambiguous raw dotted-quad hostnames and invalid download resolver
  address/family pairs before connection. Preserve explicitly permitted local
  downloads. This R14/T2b0 correction does not close browser egress gap R4 or
  introduce OS-enforced containment.

## [1.8.4] — 2026-09-07

Patch release of the independently reviewed engineering corrections in PRs
77–83 and transport-feasibility evidence in PRs 84–88. This release does not
introduce a contained browser profile or close the remaining egress gaps.

### Fixed

- Preserve tenant ownership of retained artifacts and traces after session
  closure; redact structured evidence, events and extraction boundaries using
  the configured secret registry.
- Bind Playwright element references to live node identity and enforce
  operator-controlled approval rules with page/action-bound consent.
- Unify action wire semantics and adapter error normalization; keep SDK
  deadlines active through response-body consumption and preserve error details.
- Preserve policy delegation and bound direct-download redirects, response
  collection and retained downloads; expose captured downloads through a typed
  engine contract.
- Centralize observation byte/element budgets and continuation handling; bound
  event retention and approval-token admission.
- Correct Safari session-scoped transport and lifecycle races, with explicit
  refusal when the guarded deployment requires unsupported egress enforcement.

### Changed

- Synchronize all first-party package versions and generated API/CLI stamps
  with the root product version. CI verifies runtime versions and release-tag
  consistency; npm publication depends on the tag guard.
- Retain independently reviewed worker-policy/startup probes, raw evidence and
  79 offline regression tests. The sole-owner comparison does not reproduce
  the earlier early-execution result and does not establish production enforcement.

### Known limitations

- **R4 and T1 remain open:** later browser redirect hops and worker WS/WSS
  coverage are not fully enforced. Execution startup pauses do not gate the
  initial worker-script request. Do not rely on this release for required SSRF
  containment of hostile browsing.
- Native local operation remains supported. A contained Linux Chromium profile
  still requires the accepted transport gates and OS-enforced gateway-only
  egress; full multi-tenant ADR-008 isolation remains deferred. See the
  [remediation tracker](docs/engineering-review-remediation.md) and
  [transport reassessment](docs/egress-transport-reassessment.md).

## [1.8.3] — 2026-09-05

Closes the 2026-08-31 engineering-hygiene audit in full — every finding is now
fixed (see [docs/hygiene-audit.md](docs/hygiene-audit.md)).

### Fixed

- **Screenshots and PDFs from real engines were 0-byte artifacts.** The real
  Playwright and Safari engines silently dropped the `bytesBase64` byte
  payload that `service.ts` needs to build an artifact, so every real
  screenshot/PDF was a 0-byte file — uncaught because all service-level
  tests ran against `FakeEngine` only. The engine contract is now
  compiler-enforced via the `CapturedArtifact` type, with a real-Chromium
  regression test (hygiene C6).
- **Genuine navigation aborts were silently mislabeled as egress-policy
  blocks** (hygiene E3). `navigate()` matched Playwright errors against a
  `net::ERR_ABORTED`-style regex, but every egress deny actually goes
  through `route.fulfill` (detected via the `x-agentbrowser-blocked`
  header) — the regex's only live effect was reporting unrelated real
  navigation aborts as `{status: 'blocked'}`. The regex is removed; real
  aborts now propagate. A regression test reproduces a genuine
  `net::ERR_ABORTED` (superseding a navigation) and confirms it surfaces.
- **`pdf()`/`screenshot()` fail cleanly when an engine violates the
  capture contract.** `CapturedArtifact` is compile-time only and
  `BrowserEngine` is a plugged-in interface a non-TypeScript engine could
  implement over RPC/subprocess; a non-conforming result previously
  crashed with an opaque `Buffer.from(undefined, ...)` TypeError. Both
  routes now throw a diagnosable `INTERNAL` `ServiceError` naming the
  contract violation, with contract-violation tests.
- **Teardown race in listener cleanup** (hygiene D1's own first draft):
  the initial fix used `page.removeAllListeners()`, which strips
  Playwright's own internally-attached listeners too and raced the Obscura
  engine's context-level route handler into an unhandled
  "route.abort: ...has been closed" rejection on teardown. The app's four
  listeners are now removed individually via `.off()`.

### Changed

- Internal consolidations from the audit's low-severity findings,
  behavior-neutral with the existing test suite unchanged: `server.ts`
  `route()`/`params()` helpers (F1/F2), MCP tool catalog hoisted out of
  `buildMcpServer` (F4), one shared SDK `HttpClient` replacing
  per-method HTTP boilerplate (F6), injectable logger (G2), dead
  `composite: true` dropped from tsconfig (G1), `FakeEngine` properly
  typed (C6), and documentation updates marking findings already fixed in
  v1.8.2 (C2/C4/C5/D2/E4).

## [1.8.2] — 2026-09-04

### Security

- **SSRF range gaps closed** (hygiene C3, the audit's top security-adjacent
  item): `blockPrivateIPs` previously allowed entire non-routable ranges —
  `169.254.0.0/16` link-local (including the ECS task-metadata address),
  `100.64.0.0/10` CGNAT, all of `0.0.0.0/8` beyond exact `0.0.0.0`,
  `198.18.0.0/15`, and every IPv6 literal (`::1`, `fe80::/10`, `fc00::/7` —
  the parser was IPv4-only). Public addresses unaffected.

### Fixed

- **Plan steps are validated again** — a v1.8.1 defect: an unvalidated
  `waitMs` on a `waitForLabel` step could hang the plan route in an infinite
  observe loop forever (`waitMs: "abc"` → NaN deadline → a poll that never
  exits; `1e308` → the same via Infinity). The route now schema-checks every
  step (`PlanStepSchema`, the last unvalidated request surface) and the
  service clamps hard (100–60000 ms, finite, typed rejection) as defense in
  depth.
- **Error-to-HTTP mapping is exhaustive** (hygiene F3): three live-thrown
  codes reached clients as 500s — `ACTION_TIMEOUT` (as an incoherent
  500 + retryable), `ENGINE_CRASHED`, and `INVALID_TENANT_ID` (which wasn't
  even in the enum, violating the protocol error schema). Timeouts now map
  to 504, invalid tenants to 400, `SESSION_EXPIRED` to 410; the table is
  `satisfies`-checked so a new code without a mapping is a compile error.

### Added

- **Network summary** (the last required §5.1 evidence row): the egress
  choke point emits `request.started`/`finished`/`failed` at every path —
  including all five previously-silent denial sites, each carrying the
  POLICY's own code/rule instead of a flattened 'deny'. URLs are recorded
  as origin+path only (query strings are the token carrier and are dropped
  at the engine). Events ride the existing pipeline into their own bounded
  ledger (a request flood no longer evicts console lines) and replay via
  `?type=request.finished`.
- **The CLI ships** — previously uninstallable by any packaged means (brew
  had only the MCP binary and the server wrapper; the package is private).
  Release artifacts now include `agentbrowser-cli-<target>` for all five
  targets, `--help`-smoked wherever the runner can execute them.
- **The CLI/MCP session flags dogfooding actually needed**:
  `--idle-timeout` (the 2-minute default was yanking headed human-in-the-loop
  logins mid-flow), `--cookies` + a `session cookies` export command (the
  full credential-handoff loop), `--allow-downloads`/`--max-download-bytes`,
  `--locale`, `--timezone-id`, `--allow-hosts`/`--blocked-hosts`; MCP
  `browser_create` gains `idleTimeoutMs`.
- **Operator session-default env vars**: `AGENTBROWSER_DEFAULT_TTL_MS` and
  `AGENTBROWSER_DEFAULT_IDLE_TIMEOUT_MS` (per-request values still win).
- **Evidence export from the CLI**: `session trace` (spans artifact),
  `page html` (page HTML artifact), and `session events [--type]` (console +
  request-ledger replay) — the evidence routes are now reachable from
  scripts without curl, via new SDK `trace()`/`html()`/`events()` methods.

### Changed

- **compact_dom de-scoped** (ADR-003 amendment): the Evidence row it
  belonged to is served by the HTML artifact + interactive/content modes,
  there is no reserved plumbing and no consumer, and an ungated delivery
  flip would recreate the exact lie the typed rejection was added to
  prevent. The normalizer-only revival path is documented if a consumer
  appears.
- `SessionPolicy.allowedHosts` is optional (a blockedHosts-only or
  downloads-only policy is a legitimate restrict-only combination).
- operations.md: the "30-second sweep" claim corrected (the API service uses
  lazy-on-access expiry plus a 1-hour background sweep).

## [1.8.1] — 2026-09-04

### Added

- **Evidence completion** (spec §5.1, A3): the span tracer now actually runs
  in production (built and tested since v1.7.1, but never constructed by the
  server); `POST /v1/sessions/:id/trace` exports a session's completed,
  secret-scrubbed spans as a JSON artifact, and
  `POST /v1/sessions/:id/pages/:id/html` captures the page's raw HTML
  (explicitly marked NOT secret-redacted — typed-in form values ride it
  verbatim). `GET /v1/sessions/:id/events/replay` exposes a bounded
  per-session event ledger for late subscribers. Requesting an undelivered
  observation mode (`compact_dom`, `visual`) now fails typed instead of
  silently returning zero elements.
- **`waitForLabel` plan steps** (TD-BROWSER-8 Phase 2): a plan step can
  declare `waitForLabel` (substring match) + `waitMs` instead of a fixed
  `target` — for fields that only exist after a prior step (e.g. a password
  field revealed by clicking Continue). The executor polls, resolves the
  ref itself once the label appears, and fills it into the step; a miss
  surfaces as a typed `PLAN_WAIT_TIMEOUT`, never a hang.
- **`/plan` and `/snapshot` are now documented in OpenAPI** — both have been
  reachable since Phase 1 but were invisible to any spec-generated client.
  The snapshot route (and SDK method) accept `maxElements`/`maxBytes`
  bounds; `executePlan`'s response gains `newRevision`. The CLI gains
  matching `snapshot` and `plan` commands.
- **Schema extraction is complete end-to-end**: CLI `--schema`, SDK
  `ExtractResult.modelUsed`/`tokenUsage`, and REST/SDK/MCP test coverage
  (previously wired in Phase 1 but never tested on those surfaces). The
  schema argument itself is now shape-validated instead of accepting any
  truthy value.

### Fixed

- **Model-adapter hygiene in schema extraction** (hygiene finding E1, worse
  than originally audited): a model failure no longer discards deterministic
  results that had already succeeded, and — the more serious half — **page
  text is now redacted before an injected model adapter sees it**, not only
  on the value it returns. No production code path injects a model today
  (this closes a public-API hazard, not a live leak). Text handed to an
  adapter is also capped. Property-name matching is regex-escaped and
  word-boundary anchored (`price` no longer matches inside `pricey`, E2).
- A stale-then-successfully-remapped plan step now decays its own churn
  bump, matching the always-clean success path. Previously only fully clean
  steps decayed churn, so a plan with several remapped-but-fine steps could
  ratchet upward forever and stay pinned in verified mode even after the
  page had genuinely stabilized.
- A dead `vitest` `resolve.alias` in `packages/api` (relative to CWD, so
  silently broken under `pnpm -r test`) is fixed — surfaced by this cycle's
  first API-package test importing `@agentbrowser/engine-playwright`
  directly.

### Changed

- **ADR-005: session-resume snapshots are de-scoped**, not implemented.
  Auth re-entry — the only real reason to want this — is already fully
  served by cookie seeding (TD-BROWSER-6); the one genuine gap
  (localStorage-based auth) has zero engine support today and would need
  its own scoped TD if it ever becomes a real need. See the ADR for the
  full reasoning.
- TD-BROWSER-8 status corrected: the adaptive-modes table previously
  claimed VERIFIED mode inserts an observation before every step and rides
  snapshots on responses — neither was ever built. VERIFIED only changes
  remap-matching strictness (role+label required, never guesses).
- ADR-003: `compact_dom` is documented as not delivered (was silently
  returning an empty observation; now a typed `INVALID_REQUEST`).

## [1.8.0] — 2026-09-04

### Added

- **Nine new delivered actions** (spec §5.1 parity): `hover`, `dblclick`,
  `clear`, `check`, `uncheck`, `wait`, `goBack`, `goForward`, `reload` — across
  REST, MCP (`browser_act`), CLI, and SDK; `hover`/`wait` are non-mutating
  (refs survive them). `upload` (needs file transport + size policy) and
  `download`-as-action (already first-class policy-gated endpoints) are
  deliberately excluded.
- **Working per-session policy from every client**: the nested `policy` object
  on session create is validated and mapped onto the session (previously
  silently ignored outside REST flat fields); the SDK type surface now mirrors
  the protocol's.
- `browser_extract` gains the `schema` argument (format `schema` was
  REST-only); the MCP tool's format list had omitted it.

### Fixed

- **Every HTTP `select` was rejected** — the flat transport's single `value`
  was never coerced into the protocol action's `values` array (latent since
  select shipped; regression-tested end-to-end).
- **maxBytes hardened**: measured in real UTF-8 bytes (was UTF-16 units —
  multibyte pages could exceed the budget ~3x), the text field and diff
  `changes` are now budgeted (previously only the element list), the
  sinceRevision diff path and post-action observations no longer bypass the
  budget, and non-integer/zero values are rejected.

### Changed

- **ADR-015 implemented** (Proposed → Accepted): contract primitives live once
  in `@agentbrowser/protocol` — the `e<rev>_<ord>` grammar (`REF_PATTERN`/
  `parseRef`, replacing four divergent copies), the extract-format list
  (seven copies had drifted on whether `schema` exists), `UsageError` + one
  user-facing error formatter (the copies had diverged on the STALE_TARGET
  hint), `ActionEffectType`/`EngineTarget` aliases (a latent same-name type
  collision between protocol and engine), and compiled TypeBox request/action
  validation replacing per-surface `typeof` checks — with type-level contract
  tests so schema/type drift fails `type-check`.
- `SessionRequest.engine` accepts registered engine names (the registry
  routes arbitrary names and fails loudly on unknown ones; the old
  two-literal enum couldn't express the shipped semantics).

## [1.7.1] — 2026-09-04

### Added

- Bounded-collection eviction discipline (TD-BROWSER-9, née TD-BROWSER-8): `BoundedCache`/
  `RingBuffer` primitives in `@agentbrowser/core`, applied to the redaction cache, span buffer, and
  network-policy request log (previously **fully unbounded**, not just large); indexed lookups for
  approval-token-by-session and element-by-ref replace per-call linear scans; the plan executor's
  churn map is cleaned up on session/page teardown instead of leaking one entry per session:page
  pair for the life of the process.
- **Summary quantiles over a bounded window** (TD-BROWSER-9, A2): metrics summaries keep
  incremental all-time-exact `_count`/`_sum` and compute quantiles over the most recent
  `maxSamplesPerSummary` samples (default 1,000) — quantiles are now recent-window signals, not
  all-time promises; identical to prior behavior below the window size.
- **Operations guide** (`docs/operations.md`): configuration, auth, health/metrics, session
  lifecycle, engine selection, deployment notes, and a troubleshooting table.
- **`docs/README.md` re-indexed by audience** with a task-based routing table; stale
  "planned documentation" entries resolved (the threat model has existed for a while; the
  operations guide now does too).
- engine-obscura's scope relative to ADR-013's no-evasion rule is now stated explicitly in
  `docs/engines.md` — outside the rule (unregistered, unreachable by `createSession`,
  benchmark-only), and barred from the engine registry until a follow-up ADR closes its tested
  egress-enforcement gap.
- **A `check-doc-links.mjs` CI check** (`scripts/`) validates every relative markdown link and
  heading anchor across the repo; wired into the lint job.
- **Documentation audit and reconciliation**: `CLAUDE.md` no longer claims the project is in
  "Phase 0" (the MVP and five post-MVP TDs have shipped since); the MVP planning docs
  (`technical-design.md`, `implementation-roadmap.md`, the phase progress summaries) carry
  historical-record banners instead of presenting a completed plan as still-open work; 11 of 15
  ADRs are reconciled against current code (isolation-tier honesty in ADR-008, the real 11-tool
  MCP surface in ADR-009, the real approval-token flow in ADR-007, real egress defaults in
  ADR-006, and more).

### Fixed

- **The two decision-record numbering collisions introduced while "resolving" the prior pair are
  now actually resolved.** 1.7.0's changelog entry below claimed the ADR/TD-BROWSER-8 collisions
  were closed; the renumbering picked 012 and TD-BROWSER-8, which — unnoticed at the time — were
  *already* taken by the Accepted, shipped snapshot/plan-batching work (ADR-012, TD-BROWSER-8).
  The Proposed, not-yet-implemented docs move again: the cross-package-contract ADR is now
  **ADR-015**, and the bounded-in-memory-collections TD is now **TD-BROWSER-9**. `docs/README.md`'s
  index is corrected to list all four documents (the two Accepted/shipped ones were previously
  missing from it entirely).
- **`browser_plan`'s MCP schema didn't declare `sessionId`/`pageId`**, so a caller that omitted
  them got the literal string `"undefined"` sent to the service instead of a validation error.
  Fixed alongside a new `browser_snapshot` MCP tool (TD-BROWSER-8's snapshot half had a server
  route and service method but no SDK or MCP path — unreachable from any real client until now).
  The same `"undefined"` coercion on `browser_close`, `browser_cookies`, and `browser_create`'s
  `tenantId` is fixed too, and `browser_plan` no longer reports `ok` for a missing/non-array
  `actions` argument (it was an empty plan with zero steps).
- **Verified mode has teeth** — and its remap works past the first stale step. `verified` mode
  (raised after repeated ref churn) now requires a role+label match before accepting a remapped
  ref (previously it changed nothing behaviorally and could silently rebind an action to the wrong
  element on a reordering page), matching on the redacted form so labels embedding secrets still
  match their own element, reading the pre-failure baseline from the mint-time revision history
  (the self-heal's own re-observe used to invalidate it, killing remap for every stale step after
  the first), reporting a gone element as the honest `PLAN_STEP_FAILED` instead of a misleading
  `AMBIGUOUS_REMAP`, and surfacing a remap-retry failure as the plan envelope instead of a thrown
  error. A leftover debug `console.log` in the same path is removed.
- **Memory/reclamation fixes**: `RingBuffer.clear()` (used by `clearLogs`) now releases item
  references instead of only resetting cursors; per-session teardown is deduplicated into one
  helper, fixing shipped drift where a crashed session's event listeners survived
  `recoverFromCrash` while the sibling paths dropped them.
- The snapshot payload type is declared once (`PageSnapshot` in the SDK) instead of hand-copied
  across three packages, and the release smoke test reports the real tool count instead of a
  hardcoded `9`.

## [1.7.0] — 2026-09-03

### Added

- **npm distribution** (ADR-014): the MCP server ships to npm as `@anvailabs/agentbrowser-mcp`
  via OIDC Trusted Publishing — no publish token exists anywhere. The bun-compiled GitHub-Release
  binaries remain for standalone/no-Node users; the server stays tarballs + Docker.
- **Headed de-fingerprinting + ADR-013**: headed sessions launch with automation fingerprints
  stripped (`--disable-blink-features=AutomationControlled`, no `--enable-automation`,
  `navigator.webdriver` scrubbed) and prefer real Google Chrome (`channel: 'chrome'`) when
  installed (`AGENTBROWSER_CHROME_PATH`). Doctrine: no arms race with CDP-fingerprinting walls —
  the cookie-seeding handoff is the prescribed route. The headless pool keeps stock defaults.
- **`--no-headless` on the CLI**: headed sessions were unreachable from the CLI (the `--headless`
  flag could only ever send `true`). The OpenAPI create-session schema now documents `headless`
  semantics and the `cookies` seeding field the runtime has accepted all along.

### Fixed

- **Both decision-record numbering collisions resolved** (ADR-011 ×2 → the contract ADR became
  ADR-012; TD-BROWSER-6 ×2 → the bounded-collections TD became TD-BROWSER-8), and the branch-flow
  rule that caused them (main merges must be followed by a main→develop back-sync) is now in
  CLAUDE.md. Stale "6-tool catalog" counts corrected to the enforced 9.
  ⚠️ **Corrected in [1.7.1](#171-2026-09-04) above**: this renumbering collided a second time.

## [1.6.1] — 2026-09-02

TD-BROWSER-7 Phase 1: per-session engine registry. See the `v1.6.1` GitHub Release.

## [1.6.0] — 2026-09-01

TD-BROWSER-6 (headed sessions + credential handoff). See the `v1.6.0` GitHub Release.

## [1.1.0] — earlier

MCP MVP through TD-BROWSER-5 (single-binary distribution). See the GitHub Releases for
`v1.1.0`–`v1.5.0`.
