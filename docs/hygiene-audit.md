# Engineering-hygiene audit (2026-08-31)

> **Status (2026-09-05, third pass): Theme A/B/E1/E2/C3/F3/F5 remediated;
> C2/C4/C5/D2/E4 were already fixed in Phase 3's C9 hygiene sweep but never
> marked here.** Theme A landed as TD-BROWSER-9 (BoundedCache/RingBuffer,
> bounded quantile window, indexed lookups). Theme B landed as ADR-015
> (SSOT ref grammar + extract formats, ActionEffect/EngineTarget aliases,
> shared UsageError/formatter, SDK type mirror, compiled schema validation
> with type-level contract tests). E1/E2 (Phase 2) and C3/F3/F5 (Phase 3)
> are fixed; C1 closed by honest re-label. C2 (dead `checkExpiration`), C4
> (dead engine-wide revision counter), C5 (dead normalizer counters), D2
> (listener-ownership doc), and E4 (dialog `try/finally`) were deleted/fixed
> in Phase 3's C9 sweep alongside other work but this doc was never updated
> — confirmed absent from the code by direct grep, marked fixed now.
> **Remaining open: C6, D1, F1/F2/F4, F6, G1/G2** — a hygiene-tail cycle is
> in progress against the M/L-severity ones (C6, D1, F1/F2/F4, G1/G2); E3
> and F6 stay deliberately deferred (low severity, narrow value per this
> audit's own text). Findings below are as audited (12 packages; 14 now).

A **maintenance-and-design** audit, distinct from `docs/audit.md` (which was a
vision-vs-implementation / security-and-spec audit, now closed). This pass looks
only at software-engineering hygiene: **design patterns, data-structure choice,
cross-package contracts, dead code, resource lifecycle, and resilience**. It
introduces no new product requirements — every item is either debt to retire or
a defect against the code's own stated intent.

Scope: all 12 packages under `packages/` (~23.7k LOC) plus workspace tooling.
Every finding below was **read in code and grep-verified**, not inferred; each
carries a *rationalization* so an adversarial reviewer can independently confirm
or refute it. Where a pattern is defensible / on-vision, it is called out as
**Not debt** rather than dressed up as a finding.

**Status legend:** **H** = active maintenance hazard, bug-prone, or code contradicts
its own intent — fix next. **M** = real debt with a clear fix, no urgency. **L** =
polish. **On-vision** = intentional per spec/ADRs; listed only to pre-empt re-flagging.

**Two workstreams are split into their own design docs** because they need a
decision, not just a patch:
- **[ADR-015](adr/015-cross-package-contract-single-source-of-truth.md)** — where shared contract primitives live (Theme B).
- **[TD-BROWSER-9](td/TD-BROWSER-9-bounded-in-memory-collections.md)** — eviction discipline for long-lived in-memory collections (Theme A).

---

## Theme A — Unbounded / inefficient in-memory data structures → [TD-BROWSER-8]

The service is single-node with in-memory state, which is **on-vision** (the spec
makes no HA claim). What is *not* on-vision: several of those in-memory
collections grow without any eviction bound, and a few hot paths pick the wrong
structure. On a long-running server these are latent memory-growth and CPU
findings independent of the HA question.

| # | Finding | Location | Sev | Rationalization (verify this) |
|---|---------|----------|-----|-------------------------------|
| A1 | Secret-redaction cache grows unbounded — every unique string ever redacted is memoized forever | `core/secret-manager.ts:31,118-130` | **H** | `redactionCache` is a plain `Map` with `.set` on miss and no eviction; redaction runs on every log/trace/observation boundary, so cache size tracks total distinct output strings over uptime. |
| A2 | Metrics samples unbounded, **re-allocated on every `observe()`** (O(n²)), and `render()` re-sorts all samples each scrape | `core/metrics.ts:80-87,104-115` | **H** | `observe()` does `values: [...(current?.values ?? []), valueMs]` — a full array copy per sample, so total work is O(n²), not just unbounded — and `render()` sorts `[...values]` per series per call. Prometheus-style registries keep count/sum/quantile sketches, not raw sample history. |
| A3 | Span buffer evicts with `Array.shift()` — O(n) copy per span over cap | `core/tracing.ts:93-95` | **M** | `this.spans.shift()` when `> maxSpans`; `shift` re-indexes the whole array. A ring buffer is O(1). |
| A4 | Network-policy log array unbounded when `enableLogging` on | `policy/network-policy.ts:57,182-196` | **M** | `logs.push(...)` with no cap or rotation; every checked request appended for the process lifetime. |
| A5 | Egress verdict cache per Playwright context unbounded | `engine-playwright/index.ts:193-210` | **M** | `verdicts = new Map<string,'allow'\|'deny'>()` keyed by hostname, `.set` on miss, never cleared; a page hitting many distinct hosts grows it without limit. Memoization is correct; the missing bound is the issue. |
| A6 | Approval-token lookup by session is an O(n) full scan (no secondary index) | `core/approval-gate.ts:211-224` | **M** | `getSessionTokens` iterates all tokens filtering by `sessionId`; a `Map<sessionId, Set<tokenId>>` maintained on create/delete makes it O(1). |
| A7 | Action-time element lookup is a linear `find` over the observation | `core/action-executor.ts:241` (`verifyFingerprint`) | **M** | `observation.elements.find(el => el.ref === ref)` runs per action; observations carry no ref→element index. Building the `Map` once per observation removes the repeated scan. |

**On-vision (not debt):** single-node in-memory session/artifact/approval stores;
observation multi-pass normalization at ≤300 elements (A-adjacent, `observation-normalizer.ts`) is small-constant and not worth merging until element caps rise.

---

## Theme B — Cross-package contract single-source-of-truth & type drift → [ADR-015]

The protocol-over-implementation principle (ADR-002) says the contract is the
source of truth. Several primitives that *are* contract have been re-declared per
consumer, and have already drifted apart. Each is a DRY violation with concrete
divergence evidence — not a hypothetical.

| # | Finding | Location | Sev | Rationalization (verify this) |
|---|---------|----------|-----|-------------------------------|
| B1 | **`ActionEffect` name collision across packages** — a classification union in protocol, an unrelated result object in engine | `protocol/types.ts:230` (`export type`) vs `engine/types.ts:175` (`export interface`) | **H** | Two exports share the name for different concepts; a module importing both silently keeps the last. Worse, the engine's shape duplicates protocol's existing `ActionResult` (`protocol/types.ts:433`) — the name is both a collision and a synonym. |
| B2 | **SDK `SessionRequest` drift** — contradicts `docs/audit.md`'s "reconciled" claim | `sdk-typescript/client.ts` vs `protocol/types.ts:35` | **H** | SDK has `tenantId: string` (required; protocol optional), `engine?: string` (protocol `engine?: EngineType`), and is **missing** `policy`, `ttlMs`, `idleTimeoutMs`, `cookies`. So SDK clients cannot set per-session policy at all — they must drop to raw JSON. |
| B3 | `REF_PATTERN` defined 4× in 3 incompatible forms | `core/action-executor.ts:46`, `api/service.ts:166` (capture groups); `cli/cli.ts:67` (no groups); `mcp-server/mcp-server.ts:87` (**string**, re-wrapped as ``new RegExp(`^${REF_PATTERN}$`)`` → double-anchored) | **M** | The ref grammar `e<rev>_<ord>` is protocol (ADR-004). Four copies means a grammar change (e.g. tenant prefix) is a 4-file edit with no guarantee they stay equal — and they already differ in capture-group shape. |
| B4 | Ad-hoc request validation instead of the TypeBox schemas that already exist | `api/server.ts:464-471,530-537,576-583,693-701`; duplicated in MCP/CLI/SDK | **M** | `protocol/schemas.ts` defines `SessionRequestSchema`/`NavigationRequestSchema` etc. with min/max/enum rules; the surfaces hand-roll `typeof x !== 'string'` checks and never invoke the schemas. Constraint drift is guaranteed. |
| B5 | Supported-format list duplicated in 5 places, already divergent | `api/server.ts:692`, `mcp-server.ts:324`, `cli.ts:391`, `sdk client.ts:128`, `api/openapi.ts:561` | **M** | Grep the five lists: only the server's includes `'schema'`. A format added in one place is silently unsupported in the others. |
| B6 | `formatError`/`formatToolError` duplicated, already diverged | `mcp-server.ts:489-503` vs `cli.ts:539-551` | **M** | ~90% identical; the MCP copy has a `STALE_TARGET` remediation hint the CLI copy lacks — same error, different guidance depending on surface. |
| B7 | SDK `ActionRequest` flattens away the protocol discriminated union | `sdk client.ts:109-125` vs `protocol/types.ts` `SupportedAction` | **M** | Protocol models per-action shapes (`ClickAction`, `FillAction`, …); SDK collapses to `{action, target?, value?, options?: Record<string,unknown>}`, so `{action:'click', value:'x'}` type-checks. Loses compile-time safety the protocol already encodes. |
| B8 | Engine `EngineEventType` literal `'page navigated'` breaks the dotted convention of its siblings | `engine/types.ts:209` | **M** | Siblings are `page.created/destroyed/loaded/crashed`; the space breaks any `startsWith('page.')` routing and is a latent bug the moment prefix-matching is added. |
| B9 | `RequestPolicy` contract doesn't specify what to throw to block | `engine/types.ts:63-70` | **M** | Doc says "throw to block" but names no error type/code; two engines could throw `TypeError` vs a coded error and callers can't handle both. `checkResponse?` optional with no documented default. |
| B10 | `UsageError` class duplicated verbatim | `mcp-server.ts:464`, `cli.ts:72` | **L** | `class UsageError extends Error {}` in both; two copies of an error taxonomy that should be one import. |
| B11 | `ElementTarget` (protocol) vs `EngineTarget` (engine) — two names, one `{ref:string}` shape | `protocol/types.ts:280`, `engine/types.ts:146` | **L** | Identical shape, two names across the boundary developers cross most; a type alias in engine removes the friction. |
| B12 | Effect taxonomy union inlined in 4 files rather than a named type | `protocol/types.ts:230-236`, `protocol/schemas.ts:173-180`, engine + testkit element shapes | **L** | The `'read'\|'write-local'\|…` union is retyped inline in each; adding an effect is a 4-file change with no shared alias. |

**On-vision (not debt):** the four surfaces *intentionally* differ in altitude
(MCP high-level tools per ADR-009, CLI ergonomics, SDK convenience) — B2/B7 are
flagged because the **types** drifted, not because the surfaces exist. Independent
package versions (mcp-server 1.3.1, api 1.1.0, rest 1.0.0) are intentional per
TD-BROWSER-5.

---

## Theme C — Dead code & capability/implementation drift

Dead members and stubs that misrepresent what the system does. Each is a
straight deletion or an honest re-label; none needs a design decision.

| # | Finding | Location | Sev | Rationalization (verify this) |
|---|---------|----------|-----|-------------------------------|
| C1 | `engine-playwright` `extract()` is a body-text stub, yet extraction is advertised in `capabilities()` and the **real** schema extraction runs elsewhere | `engine-playwright/index.ts:752-759` returns `{text: body}`; real path `api/service.ts:1326` `new SchemaExtractor(...).extract(...)` | **M** | The engine method ignores `schema/selector/format`; nothing calls it for real extraction — the service extracts from observed state via `@agentbrowser/extraction`. So the method is dead **and** the advertised capability overclaims (the exact anti-pattern ADR-009 / "no silent fallback" forbid). Either implement it or drop it from capabilities and route explicitly. |
| C2 | ~~Dead `checkExpiration()` shadows the real cleanup path~~ **FIXED (Phase 3, undocumented until now)** | `core/session-coordinator.ts:334-341` | **M** | Never called; duplicates `isSessionExpired()` logic and calls `this.close()` in a shape incompatible with the timer-driven `runCleanup()` that is the actual path. |
| C3 | ~~Incomplete SSRF IP-range coverage~~ **FIXED (Phase 3, 2026-09-04)** | `policy/network-policy.ts:60-65` (`PRIVATE_IP_RANGES`, unused) + `:230-233` (`0.0.0.0/8` branch matches only exact `0.0.0.0`) + `:242-266` (`isPrivateIP` covers only RFC1918) | **H** | The `PRIVATE_IP_RANGES` field is dead; the checks were hand-inlined instead — and incompletely: `0.0.0.0/8` non-zero (e.g. `0.1.2.3`) and general `169.254/16` link-local (only the metadata IP is blocked separately) fall through `isLoopback`/`isPrivateIP`/`isMetadataEndpoint` and are **allowed**. Code contradicts the `0.0.0.0/8` comment and the SSRF intent. Security-adjacent; narrow real-world exploitability but a clear defect. Fix by driving all checks from the (revived, CIDR-correct) table. |
| C4 | ~~Engine-wide `revisionCounter`/`incrementRevision()` never used~~ **FIXED (Phase 3, undocumented until now)** | `engine-playwright/index.ts:93,259-261` (vs page-local `revision` at `:360`, used in refs at `:573`) | **L** | Method never invoked; leaves the revision model ambiguous (engine vs page scope). Delete and let ADR-004's page-local model stand. |
| C5 | ~~Dead `elementCounter` field + `resetCounter()` in the normalizer~~ **FIXED (Phase 3, undocumented until now)** | `core/observation-normalizer.ts:48,277` | **L** | Never read/incremented; refs come from `revision`+`index` via `generateRef()`. Vestige of an abandoned scheme. |
| C6 | FakeEngine returns `Promise<any>` where the interface promises typed results | `testkit/fake-engine.ts:482,494` (`screenshot`/`pdf` → `any`), `:148-150` (`cookies(): Promise<any>` always `[]`), throws plain `Error` not `ErrorCode` at `:364,134,270` | **L** | The reference test substrate erodes the very types it exists to validate; `any` hides `ArtifactRef`/`NormalizedCookie` shape drift, and plain-string throws mean contract tests can't assert on `ErrorCode`. |

---

## Theme D — Resource lifecycle

| # | Finding | Location | Sev | Rationalization (verify this) |
|---|---------|----------|-----|-------------------------------|
| D1 | Playwright page listeners never deregistered on `close()` | `engine-playwright/index.ts:371-435` attach `page.on('close'/'dialog'/'load'/'console')`; `:842-854` `close()` doesn't `off` them | **M** | Four listeners per page attached in the constructor, none removed before `page.close()`; a session churning many pages accumulates handler stubs. Fix is `removeAllListeners()`/stored `off` in `close()`. |
| D2 | ~~Session-scoped listener ownership on teardown is undocumented~~ **FIXED (Phase 3, undocumented until now)** | `core/session-coordinator.ts:355-361` (`SessionContext` holds `engine`/`engineSession`) | **L** | No dereg call in `close()`/`terminate()` and no comment stating whether the engine or the session owns listeners; not demonstrably a leak (engine may own them) but the silence is the hazard. Document the ownership contract. |

---

## Theme E — Resilience & correctness

| # | Finding | Location | Sev | Rationalization (verify this) |
|---|---------|----------|-----|-------------------------------|
| E1 | ~~Model-adapter failure discards successful deterministic extraction~~ **FIXED (Phase 2, 2026-09-04)** | `extraction/schema-extraction.ts` | **H** | Was worse than originally audited: the model call was unguarded (a throw discarded successful deterministic data) AND `secretManager.redact` ran AFTER the model call, so an injected adapter saw unredacted page text. Now: try/catch keeps deterministic data + a warning; redaction runs before the model call; input is size-capped. |
| E2 | ~~Deterministic field-match regex isn't word-boundary anchored~~ **FIXED (Phase 2, 2026-09-04)** | `extraction/schema-extraction.ts` | **M** | Property names are now regex-escaped and `\b`-anchored in both match patterns; a substring-false-positive test (`price` not matching inside `pricey`) is in place. |
| E3 | Fragile Playwright error classification by `String(error)` regex | `engine-playwright/index.ts:451-462` | **L** | Blocked-navigation detection matches `net::ERR_*` against the stringified error; breaks silently if Playwright changes message format. Prefer error `.code`/`.name`, or throw a typed error from the egress handler. |
| E4 | ~~Dialog settlement lacks an error boundary in the fake~~ **FIXED (Phase 3, undocumented until now)** | `testkit/fake-engine.ts:233-246` | **L** | Listener call then `emitEvent` in sequence; a throwing listener skips the emit, leaving `pendingDialog` cleared but no event — `try/finally` fixes it. Test-substrate only. |

---

## Theme F — Surface-layer structure (api/mcp/cli)

| # | Finding | Location | Sev | Rationalization (verify this) |
|---|---------|----------|-----|-------------------------------|
| F1 | 16 route handlers repeat the same `try { … } catch (error) { return fail(reply, error) }` frame | `api/server.ts` (16× `return fail(reply, error)`) | **M** | Grep count = 16 in one file; a `route()` higher-order wrapper (tenancy + error mapping once) removes ~450 lines and makes the error contract a single edit. |
| F2 | `const { sessionId, pageId } = request.params as {…}` cast repeated 9×+ | `api/server.ts` (multiple) | **L** | Mechanical param-cast repetition; a typed `params(request)` helper centralizes the cast. |
| F3 | ~~`statusFor()` code→HTTP switch not checked against the enum~~ **FIXED (Phase 3)** | `api/server.ts:71-99` | **L** | 20 hand-maintained cases vs 21 enum members; a missing case silently defaults to 500. A table keyed by the enum (exhaustiveness-checked) prevents drift. |
| F4 | 378-line `buildMcpServer()` interleaves tool definitions with dispatch | `mcp-server.ts:83-461` | **L** | Tool schemas (~300 lines) inline before dispatch at `:416`; a module-level `TOOLS` table separates data from control flow and makes adding a tool a data edit. |
| F5 | ~~MCP `browser_observe` accepts `maxBytes` but omits it from the tool description~~ **FIXED (earlier)** | `mcp-server.ts:196-230` (prop present at `:206-211`, description `:191-195` mentions only `maxElements`) | **L** | Silent capability — agents can't discover `maxBytes` from the schema description. (Also noted P2-6 in `docs/audit.md`.) |
| F6 | No shared HTTP client abstraction | `sdk client.ts:185-403` | **L** | Timeout/JSON/error-decode logic lives inside `SessionsClient`; any second HTTP consumer re-implements it. Low priority at 4 surfaces. |

---

## Theme G — Workspace & build hygiene

| # | Finding | Location | Sev | Rationalization (verify this) |
|---|---------|----------|-----|-------------------------------|
| G1 | `composite: true` declared (root + core/engine/protocol/testkit) with **no `references` graph anywhere**, and builds run plain `tsc` not `tsc -b` | root `tsconfig.json:20`; per-pkg build scripts `"build": "tsc"` | **L** | `grep -rn '"references"'` returns nothing; `composite` only forces `rootDir` discipline and emits `.tsbuildinfo` (which `clean` deletes) but yields no incremental cross-project build. Either wire `references` + `tsc -b`, or drop `composite`. Topological correctness currently relies on `pnpm -r` ordering, which works — so this is config that misleads, not breakage. |
| G2 | Service/library code logs via raw `console.*`, bypassing `StructuredLogger` | `core/session-coordinator.ts:305`, `core/approval-gate.ts:252`, `api/server.ts:128,233,818` | **M** | `StructuredLogger` exists but background/error paths call `console.error/warn/log`; combined with `docs/audit.md` P2 (bin.ts builds a logger it never injects), production has no structured operation log for these paths. Inject the logger and route these through it. |

---

## What held up (architectural, verified)

The engine-neutral boundary is **intact**: `grep` finds zero `playwright` *imports*
in `protocol`/`engine`/`core`/`policy` (only string literals, comments, and the
legitimate composition roots `api/bin.ts` and `benchmarks/run.ts`). Package
dependency directions are correct (protocol → engine → core → surfaces; policy
dependency-free). No `TODO/FIXME/HACK` markers anywhere. The revision/ref model,
secret-redaction-at-boundaries design, and deterministic-first extraction shape
are sound — the findings against them are bounds and guards, not redesigns.

## Suggested remediation order

1. **C3** (SSRF range gap — security-adjacent, cheap), **E1** (deterministic-first regression), **A1/A2** (unbounded caches most exposed to uptime).
2. **B1/B2/B8** (name collision + SDK drift + event typo — small, high-confusion), then the rest of **Theme B** behind [ADR-015].
3. **Theme A** remainder behind [TD-BROWSER-9]; **G2** (logger injection).
4. Polish: **Theme C** deletions, **Theme F** refactors, **G1** build config, remaining L items.
