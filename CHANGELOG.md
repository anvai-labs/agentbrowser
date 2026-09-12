# Changelog

All notable changes to **AgentBrowser** are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); releases are tagged `vX.Y.Z` and
built by `.github/workflows/release.yml` (binaries + server tarballs on GitHub Releases;
`@anvailabs/agentbrowser-mcp` on npm from 1.7.0 — [ADR-014](docs/adr/014-npm-distribution.md)).

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
