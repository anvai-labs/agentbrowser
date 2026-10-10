# Compact-output handoff review: pressure tests, token budgets, prior art (2026-10-09)

Review of `AGENTBROWSER_COMPACT_OUTPUT_HANDOFF_2026-10-09.md`. Two scope corrections were
given by the owner while this review ran and are baked into every recommendation below:

1. **CLI-first.** Most consumers will drive AgentBrowser from an agent shell (Bash + `agentbrowser`); MCP is optional. The primary token surface is therefore **CLI stdout** and (secondarily) the MCP tool catalog — not the other way around. This is also the direction the industry took: the Playwright team ships a dedicated token-efficient CLI for exactly this reason ("CLI invocations are more token-efficient: they avoid loading large tool schemas and verbose accessibility trees" — microsoft/playwright-mcp README) and measured ~114K tokens/task via MCP vs ~27K via CLI (~4×, morphllm.com/playwright-mcp citing the Playwright team).
2. **Primary user is an agent, not a human.** Help text, `describe` output, default renderings, and error text are model-facing surfaces and should be budgeted like tool descriptions.

Method: all local numbers below were measured from the built 1.15.2 tree (`packages/mcp-server/dist`, `buildTools` + a simulated `tools/list`) and a synthetic OVH-Manager-style fixture (192 elements: 120 nav links, 30 toolbar buttons, 1 policy dialog with 6 checkboxes, 6-row user table with per-row actions) matching the handoff's description. Token estimates use ~3.8 chars/token for JSON-heavy text (conservative vs the ~4 chars/token commonly used); treat them as ±15%.

---

## 1. Measured baseline (before any change)

### 1.1 Static MCP catalog cost (paid once per MCP connection, every conversation)

| Metric | Value |
| --- | --- |
| Tools advertised (unbound/qa) | 17 |
| tools/list payload | **46,421 bytes ≈ 11–15K tokens** |
| Tool descriptions total | 11.6 KB |
| Input schemas total | ~33 KB |
| Output schemas total | ~6.3 KB |

Heaviest tools: `browser_plan` 8.2 KB, `browser_act` 8.2 KB, `browser_observe` 6.7 KB, `browser_create` 5.1 KB, `browser_autofill` 4.8 KB. For calibration, Microsoft's playwright-mcp advertises 25 tools in **19.6 KB ≈ 5K tokens** (their measurement, issue #1772) — AgentBrowser spends ~2.3× that on 32% fewer tools.

Avoidable redundancies found in the catalog (see §5):
- The wait-condition schema (1,841 bytes) is serialized **four times** — as `wait` *and* as `condition` in both `browser_act`'s envelope and `browser_plan`'s step schema = 7.4 KB (16% of the catalog) for one vocabulary.
- `browser_act`'s description (2,511 chars) duplicates content that also exists in its schema property descriptions, in `browser_plan`'s description, and in runtime error text (STALE_TARGET remediation appears in description *and* in `formatToolError`).
- Operator essays from `INTERACTION_GUIDANCE` are injected into agent-facing descriptions: `networkPolicy` (~1.1 KB, into `browser_navigate`), `livePush` (~450 B, into `browser_create` **and** `browser_navigate`), `cookieHandoff` (into `browser_cookies`). These are startup/env configuration instructions for a human operator, not model guidance.

### 1.2 Per-call observation cost on the OVH-style fixture (192 elements)

| Output shape | Bytes | ≈ Tokens | vs status quo |
| --- | --- | --- | --- |
| MCP status quo: pretty text block + structuredContent (both always shipped) | 62,578 | **~16.5K** | — |
| `content[0].text` alone (pretty, 2-space — what text-only clients render) | 36,617 | ~9.6K | −42% |
| Minified JSON (structuredContent alone) | 25,961 | ~6.8K | −59% |
| CLI default render (line format, `renderObservation`) | ~9,032 | ~2.4K | −75% |
| **Proposed compact projection** (dialog scope, 11 elements, minified) | 1,232 | **~324** | **−95%** |
| Compact projection, line-format elements | 547 | ~144 | −98% |

Two structural facts behind these numbers:
- `packages/mcp-server/src/mcp-server.ts` `textResult()` pretty-prints **and** duplicates every result: `content[0].text = JSON.stringify(value, null, 2)` plus `structuredContent` whenever the tool has an `outputSchema`. The spec's text fallback is a SHOULD; minifying it is free (−29% on that copy). Worse, `structuredContent` is gated on `outputSchema` presence — `browser_act`, `browser_navigate`, `browser_extract` have none, which is exactly why the Sandesha client sees "compact JSON wrapped as pretty-printed `content[0].text`" from `browser_act`.
- The default `maxElements` is 300, so the OVH page's 190 elements ship **untruncated**; nothing in the current pipeline can return "just the dialog."

### 1.3 Full OVH-style workflow (1 create + 1 navigate + 10 observes [6 full refreshes, 4 scoped] + 12 acts)

| Strategy | ≈ Total tokens | Δ |
| --- | --- | --- |
| MCP status quo | ~110K | — |
| MCP + compact projection + minified fallback | ~55K | −50% |
| CLI status quo, default render | ~27K | −75% |
| CLI `--json` (pretty) | ~99K | −10% |
| CLI `--json` + compact projection | ~44K | −56% |

Note what this says for the CLI-first direction: **the CLI default render is already the cheapest surface AgentBrowser has** — it just isn't trustworthy for agents (§4 P11) so agents fall back to `--json`, which is nearly as expensive as MCP.

Also relevant: Anthropic caps tool responses at **25,000 tokens by default in Claude Code** ("Writing effective tools for agents"). A single full observation (~9.6–16.5K tokens) plus ordinary turn content brushes that ceiling; two stacked observations can exceed it. External datapoints for scale: playwright-mcp page snapshots run 50 KB–540 KB in the wild (issue #1233) and a Wikipedia snapshot measured ~124K tokens; browser-use measured ~50K tokens/task. This is the class of problem the handoff is pointing at, and it is real.

---

## 2. Verdict on the proposed interface

The handoff's shape (`includeRoles`, `namePattern`, `scopeRef`, `limit`, `fields` on observation; `compact: true` on action results; full response stays the default) is the right family and matches where production systems landed (Playwright MCP `browser_snapshot`: `target`, `depth`, `filename`; Chrome DevTools MCP: `verbose:false` default, `filePath`, `pageIdx/pageSize` pagination; Stagehand: locator-scoped snapshots "reduces token costs"). Pressure-testing each parameter against the actual pipeline (`packages/api/src/service.ts` observe path, `packages/core/src/observation-budget.ts`, `packages/engine-playwright/src/index.ts` ref/refStore machinery) produces one design change and several sharpenings:

### 2.1 `scopeRef` is not implementable as written — the observation model is flat

`parseAriaSnapshot` (engine-playwright `index.ts:3249`) flattens the a11y tree and **discards the indent/tree structure**; `PageElement` carries no parent/depth/bounds. "Scope to the dialog's subtree" cannot be computed from a `PageState` today. Two ways out:

- **Recommended: preserve depth in the flat list, scope by slice.** The DFS order of `ariaSnapshot` guarantees a subtree is a *contiguous run* in document order; recording each element's tree depth (a few lines in `parseAriaSnapshot`) makes `scopeRef` = "the scope element plus following elements with greater depth" — a pure post-normalization slice. Refs, ordinals, the refStore and revision semantics are untouched.
- **Rejected: engine-level scoped re-snapshot** (`locator.ariaSnapshot()` on the subtree). A scoped snapshot mints subtree-local ordinals that **collide with page-global refs** (`e5_0` of the subtree ≠ `e5_0` of the page), and the refStore is rebuilt per observation (`this.refStore.clear()` then re-set), so a scoped enumeration would either strand every out-of-scope ref or mis-bind actions to the wrong elements. Do not do this without a separate ref namespace, which is not worth the complexity for v1.

Interaction with truncation: `applyTruncation`'s prioritization **sorts** (focused > interactive > content) when elements exceed `maxElements` (300). A scope *slice* computed on a sorted list is garbage. Projection must run on the document-ordered list; the priority sort belongs only to the budget-truncation fallback path (in the service it already runs with `retainAllElements: true`, so this is a matter of doing projection before/instead of re-sorting under projection — but the invariant must be stated in the contract, and tested at >300 elements).

### 2.2 `namePattern` → `name` substring for v1

A model-supplied regex evaluated per element on the server invites ReDoS (`(a+)+b` over ~300 untrusted names), empty-match surprises, and dialect confusion, and matching against element **values** would allow probing redacted secrets ("does the password match ^a?" is a boolean side channel). v1: case-insensitive **substring** match on `name` only, length-capped, never applied to values or redacted content. This also matches Anthropic's guidance to steer agents toward "many small and targeted searches" — Playwright MCP's `browser_find` is a text/regex search that is "cheaper than capturing the whole snapshot," and their CLI `find --regex` returns matches with 3 lines of context; a substring filter covers the OVH cases ("user-1", "policy").

### 2.3 `fields` — flip the polarity to a protected core + additive opt-ins

An allowlist that can drop `valueRedacted`/`risk`/`degraded` contradicts the handoff's own acceptance list ("do not strip evidence needed to detect … secret redaction"). Make the compact element a **protected core** — `ref`, `role`, `name?`, `value?`, `valueRedacted?`, `checked?`, plus `visible:false`/`enabled:false`/`focused` only when non-default — and add `includeFields: ["href"|"attributes"|"required"]` as additive opt-ins. The core alone cuts the serialized element ~45% (measured: omitting default-true `visible`/`enabled` saves 22% of the whole payload; the remaining savings come from never emitting empty optionals). An allowlist that includes only protected fields is then a no-op by construction, not a footgun.

Add a **name-length cap** to the compact core: truncate `name` at ~200 chars with a `nameTruncated` marker (mirroring the existing `hrefTruncated` disclosure convention). Today nothing caps accessible names — a marketing hero paragraph as a name would bloat a compact element. Prior art: Playwright drops names >900 chars (YAML key limit), Chrome DevTools MCP truncates at 100 by default.

### 2.4 `limit` and `continuation` must be defined over the projected sequence

`budgetObservation` cursors address the **full normalized list** by ordinal (`nextOrdinal = start + length`). Under projection: `limit` bounds the *filtered* element count; `truncated: true` must be set whenever either the budget or `limit` cut the list; `continuation.nextOrdinal` must remain a **page ordinal** (so a subsequent unfiltered observe can still use it), while `remaining` counts only *matching* elements. Otherwise `--continue-from` resumes at the wrong element or loops.

### 2.5 The response must echo the projection, or the model will not trust it

Add to the compact response (all cheap, few tokens each):

- `projection: { roles?, name?, scopeRef?, matched: n, total: m }` — present whenever any filter applied. Without `matched/total`, a 0-match result on a 192-element page reads as "the page has no dialog," and the recovery move (re-observe unfiltered) is not hinted.
- Keep `summary` (orientation: "Page with 44 buttons, 120 links") — it is what tells the model the subset is a subset.
- Keep `degraded`/`degradedReason`, `focusedRef` (when the focused element survives the filter), `frameCoverage`, `untrustedContent`, `sessionId/pageId/revision/url/title/status`, `continuation`.

### 2.6 `compact: true` on action results — enumerate the keep-list, not the drop-list

Must never be dropped (each maps to an acceptance item in the handoff): `actionId`, `oldRevision`/`newRevision` (stale-ref detection for the *next* action), `error` (+ its `code`), `policyDecision` when denied, `approvalDecision`, `artifacts` ids (ACTION_TIMEOUT screenshot evidence), `navigationStatus` when not `success`, the operation/reconciliation id, and any embedded `observeAfter` observation (which should itself honor the projection parameters). Droppable: `startTimestamp`/`endTimestamp`, `targetFingerprint` (audit trail, not needed to decide the next step), `result` payloads that merely echo the request. Typical act result: 223 chars pretty → ~120 chars compact; the win is mainly in the embedded observation.

### 2.7 Errors: machine-readable, bounded, keep the reconciliation id

The "occasional `INTERNAL` text block with an operation ID" comes from `errorResult()` returning text-only content. Fix at the adapter (this also resolves the Sandesha `functions.exec` parsing complaint):
- MCP: on tool failure return `isError: true` **with** `structuredContent: { error: { code, message, details: { operationId?… } } }` and a *minified single-line* text fallback. SEP-1303 (spec, 2025-11-25): input-validation failures must be tool-execution errors so the model can self-correct — keep `UsageError` messages in that form (they already are).
- CLI: stderr gets the same `{code, message, operationId?}` one-line JSON (navigate already does roughly this); stdout stays clean for pipelines.

### 2.8 Version skew is a real deployment hazard

`ObservationRequestSchema` is `additionalProperties: false`, so an old server will **reject** every observe carrying the new params (INVALID_REQUEST). Bundled CLI/MCP/-server releases move together, but SDK clients and staggered Homebrew upgrades do not. Do not silently strip params (violates the no-silent-fallback invariant); instead map that specific rejection to an actionable error: "server older than client; re-issue without projection parameters" — and put the feature in `health`/describe output so agents can probe once.

---

## 3. Pressure tests (thought experiments, with outcomes)

| # | Scenario | Outcome / required behavior |
| --- | --- | --- |
| P1 | `scopeRef` points at a ref from revision 4, page is at revision 5 | Fail `STALE_TARGET` exactly like an action would (ADR-004 symmetry). The scope ref participates in revision semantics. |
| P2 | OVH page grows past 300 elements; compact+scope issued | Projection must run **before** any priority sort; scope slice must be computed in document order, else the filter returns an arbitrary shuffled subset (§2.1). Add a >300-element regression test. |
| P3 | `limit: 20` cuts a filtered list mid-dialog | `truncated: true`, `continuation.nextOrdinal` = page ordinal of the first **unreturned match**, `remaining` counts matches only. Round-trip test: `--continue-from` returns exactly the missed elements. |
| P4 | Agent filters `roles: ["dialog"]` on a degraded (aria-snapshot-timeout) observation — bare tag roles | Filter still applies and returns 0 matches, but `degraded`/`degradedReason` must ride along, and the observe description must say matches on degraded data are unreliable → retry unfiltered or raise `snapshotTimeoutMs`. Without this, "0 elements, filtered" reads as "no dialog exists." |
| P5 | Agent asks `includeFields` on a login page, password field present | `valueRedacted: true` always survives (protected core). Absent value + `valueRedacted: true` keeps meaning "withheld," not "empty" — the exact distinction `PageElementSchema` documents. |
| P6 | `name: "user-1"` filter — matches row, cell, and kebab button (3 elements) | Fine and useful; document that substring matching across roles is expected. Never extend the match to `value` (redaction side channel, §2.2). |
| P7 | Compact observe returns dialog refs; agent clicks `e5_155` it never "saw" before (came from an earlier full observe) | Must keep working: the refStore and `page.lastObservation.byRef` are built from the **full** enumeration before projection (service.ts builds `byRef` at normalize time; projection slots in at the `budgetObservation` call site). Projection is response-shaping only. Engine enumeration, href capture (50-link cap), and revision bumping are untouched. |
| P8 | `sinceRevision` diff + projection combined | `changes` must be filtered by the same predicate, and change entries for out-of-projection refs either follow the same filter or the response must not advertise the projection as complete. Simplest consistent rule: the projection predicate applies to the elements the response is allowed to mention. |
| P9 | Sandesha-style client on old server sends new params | See §2.8: deterministic, actionable INVALID_REQUEST; no silent stripping. |
| P10 | Model trained on full output gets compact only — does task success hold? | This is the "no drop in performance" gate: run the existing benchmarks observe→fill→verify loop twice (full vs compact) and require success parity plus the byte/token delta. Playwright's maintainers rejected *hard token caps* precisely because "max tokens parameters don't work as the page snapshot becomes incomplete" (#1233); a *scoped/filtered* snapshot avoids that class of incompleteness because it is honest about what it omitted (`projection` echo + counts). |
| P11 | CLI agent uses the default render today | Two evidence gaps make it unusable for agents and push them to `--json`: `renderObservation` prints "Observation truncated." **without the cursor** (agent cannot resume), and never prints a redaction marker (agent cannot distinguish withheld from empty). Fixing those two lines makes the cheapest existing surface (−75% vs MCP) agent-correct. |
| P12 | Repeated observations of a static page | Refs stay stable only until the fingerprint set changes (revision bump rewrites all refs). Compact changes nothing here, but tests should pin: compact→act→compact on an unchanged page yields identical refs. |
| P13 | Error mid-plan, `compact: true` | Per-step failure details (which step, which ref, blockedBy) are diagnostic evidence, not verbosity — keep in compact mode; only the happy-path envelope shrinks. |
| P14 | Dialog closes; agent re-observes with the same stale scope | Scope ref now points at nothing (element removed): typed error (`SCOPE_REF_NOT_FOUND` or reuse STALE_TARGET), never an empty 200 that reads as "page is empty." |

---

## 4. The CLI-first program (primary surface, per owner direction)

1. **Server-side compact projection** (§2) benefits both surfaces and is the single biggest lever (−95% per scoped observe). Ship it in the protocol/service, not the MCP adapter.
2. **Make the default render agent-trustworthy** (P11): print `continuation: N — resume with --continue-from N`, print `[redacted]`, mark the focused element, and keep the truncated/degraded warnings. This is a ~10-line change to `renderObservation` and turns the cheapest surface into a correct one.
3. **Minify `--json`** (or add `--json=compact` with `--pretty` for humans). Pretty-printing is a 29% tax on every machine-read byte; the current `JSON.stringify(value, null, 2)` in `ctx.emit` is the same bug the handoff flags at the MCP layer, on the surface the owner says is primary.
4. **Flags mirroring the projection**: `observe --roles dialog,checkbox --name user-1 --scope-ref e5_150 --limit 20 --include-fields href`, plus `act --compact`. Commander wiring only; the vocabulary lives in the protocol schema once.
5. **Progressive disclosure via `describe` + a shipped agent skill, not fat help text.** `agentbrowser describe <cmd> [--schema]` is already the right on-demand surface (offline, per-command, bounded). Ship a short SKILL.md (the "skills page") next to the binary — the Playwright CLI made the same move ("agents discover it via `--help`/SKILLS"; snapshots to disk; `--depth`; `find --regex`). Keep operator essays (LAN CIDR configuration, loopback policy, WebMCP/transport notes) in `docs/` and `describe`, out of the hot path an agent walks every session.
6. **Optionally**: `observe --output FILE` (write the full observation to a private file, print `{matched, total, file}`) — the Chrome DevTools `filePath` / Playwright `filename` escape hatch that makes "zero tokens for the bulk, tokens only for the slice" possible. Useful for evidence capture; not a substitute for projection.

### MCP parity items (secondary, but cheap and one-time)

- Add `outputSchema` to `browser_act`, `browser_navigate`, `browser_extract` → `structuredContent` flows for them (kills the pretty-text-only inconsistency the consumer hit).
- Minify the text fallback (`JSON.stringify(value)`); keep both fields (spec SHOULD; Cursor ignores structuredContent, VS Code prefers it).
- Structured error results (§2.7).
- Regenerate `docs/mcp-tool-catalog.md` (its SHA is a release-gate drift check) after any description/schema change.

---

## 5. Tool names, descriptions, and catalog redundancy

**Names: keep `browser_*`.** Renaming to shorter verbs saves ~7 chars per call mention but breaks every deployed consumer (Sandesha, Victor), forfeits the namespacing Anthropic explicitly recommends, and risks collisions in multi-server clients. The measured catalog cost is in prose and duplicated vocabularies, not names: all 17 names joined are 284 chars.
*Owner decision, 2026-10-10 (recorded after this review): the prefix was removed anyway — consumers are few and adapt now rather than after wider adoption; the collision and compat concerns above were accepted as a one-time migration cost.*

**Descriptions: compress ~50–60% without losing behavioral anchors.** Validated on the worst offender: `browser_act`'s 2,511-char description was rewritten in 1,111 chars (−56%) with all 23 behavioral anchors retained (ref-not-selector, STALE_TARGET/re-observe, remap semantics, blockedBy+screenshot on timeout, typeText-vs-fill, delay, press count/spinbutton, combobox late-render recipe, upload/fileInputs, uncertain-write/operationId). Rules that survived the experiment:
- Telegraphic lines, one behavior per bullet; cut connective prose, keep the trigger→action pairs.
- Keep safety-critical pairs verbatim (stale → re-observe, never retry; lost write → reconcile operationId) — they are the instructions that prevent destructive mistakes.
- Move operator configuration essays (networkPolicy, livePush) to `describe`/docs; one pointer line in the description.
- Playwright MCP norm: 5–10-word one-liners with a **shared constant** reused for the `target` param description across all element tools. AgentBrowser should adopt the shared-constant pattern for `sessionId`/`pageId`/`target.ref`/`operationId` (the operationId description is currently injected per-tool from one string — good; do the same for the rest).

**Schemas: deduplicate the action vocabulary.** `WireActionEnvelopeSchema` is `Type.Omit(PlanStepSchema, ['waitForLabel','waitMs'])` and both tools serialize the wait-condition schema twice each (§1.1). Within a tool's `inputSchema`, use `$defs` + `$ref` for the wait condition (halves it); JSON Schema semantics apply and client validators resolve same-document refs. For `wait`-vs-`condition` specifically, the codebase already has the right precedent: `decodeWireAction` accepts a deprecated `type` alias that the advertised schema does not mention — so **advertise `condition` only, keep accepting `wait`** server-side (compat without catalog cost).

**Expected result:** catalog ~46.4 KB → ~22–26 KB (≈ 5.5–7K tokens), i.e. roughly parity with playwright-mcp's per-tool density while keeping richer safety semantics — without renaming anything.

**Rejected alternatives, with reasons:**
- *Delta/incremental snapshots as the compact path* — mixed prior art, and a poor fit for AgentBrowser's ref model. Playwright shipped then **removed** deltas ("proved inefficient and added a lot of complexity for little benefit," #1654), and rejected hard token caps ("the page snapshot becomes incomplete," #1233). The counter-example is vercel-labs' agent-browser v0.38 (2026-09-16), which ships true `snapshot --delta` (baseline, then "unchanged revision or compact structural changes") — but it pairs that with **persistent refs across same-document changes**, invalidated-not-recycled. AgentBrowser's refs are revision-scoped (all renumbered on the revision bump), so a delta stream would reference refs the client never saw; deltas would require persistent refs first (a separate, larger design). Keep `sinceRevision` as-is; scope/filter is the compact path.
- *Pagination of the element tree as the primary size lever* — industry pattern is **cap-then-narrow**, not paginate: no system paginates the element tree itself; Anthropic caps `read_page` at 50,000 chars *with disclosure* ("say so in the text; Claude then narrows with a smaller depth or a ref"), Chrome DevTools paginates only non-tree lists (console/network/CSS, 10/page). AgentBrowser's existing `continuation` stays (it already exists and serves the byte budget), but the new projection params are the narrowing mechanism, and truncation under projection must be disclosed per §2.5, never silent.
- *search_tools/get_tool_details meta-tools (150K→2K progressive disclosure)* — that is a host/harness responsibility (Claude Code tool search, Anthropic `defer_loading`); the server's job per the playwright-mcp maintainers is "to publish a small, stable list." Keep the 17-tool list small and stable, deterministic order (prompt-cache friendly, per current MCP spec guidance), and let hosts filter.
- *Cloudflare-style 2-tool code mode* — wrong fit: AgentBrowser's value is that raw selectors/CDP never reach the model (ADR-004/009); code mode inverts that.

---

## 6. Prior art (mechanisms worth copying, with sources)

| System | Mechanism | AgentBrowser mapping |
| --- | --- | --- |
| Playwright MCP `browser_snapshot` | `target` (subtree), `depth`, `filename` (snapshot to disk = 0 tokens, response carries only a file link), `--image-responses`, `--caps` gating; refs (`[ref=eN]`, `f<k>eN` in iframes) minted only on *interactable* nodes; "distiller" plugin chain post-processes the tree (merge text children, drop nameless images, unwrap single-child generics, drop redundant names) | `scopeRef` (slice-based, §2.1), `limit`, future `--output FILE`; protected core already approximates interactable-only; name cap (§2.3) |
| Playwright MCP `browser_find` | text/regex grep over the snapshot, matches + 3 context lines, `maxResults`; "cheaper than capturing the whole snapshot" | `name` filter (substring v1); a future `find`-style tool is the MCP-surface analog |
| Anthropic browser-use tool (`browser_toolset_20260801`) | `read_page` with `filter: visible\|interactive\|all`, `depth` (default 15), `ref` (subtree scope), **50,000-char cap with explicit disclosure** ("say so in the text; Claude then narrows"); `find` ≤20 matches; refs stable until navigation, "don't renumber" | the closest published spec to the proposed design: filter + depth + ref-scope + disclosed cap = §2 exactly; validation of scope-by-ref and of the projection echo |
| Chrome DevTools MCP | `--slim` 3-tool mode; `verbose:false` default (Puppeteer `interestingOnly`); `filePath`; `pageIdx/pageSize` on list tools; 100-char name truncation; **stable uids** (`uid=s_c` re-mapped from backendNodeId, surviving across snapshots); "files are the right location for large amounts of data" design principle | protected core = interesting-only default; name cap; stable-ref contrast: AgentBrowser renumbers per revision (remap + STALE_TARGET instead) — keep, but note the two philosophies |
| Stagehand | locator-scoped observation (`selector`), `ignoreSelectors`, instruction-scoped `observe()` returning XPath+description candidates only; server-side result cache (repeat calls consume zero LLM tokens) | scope projection; (refStore already caches bindings per revision) |
| browser-use | element-extraction observation (interactive/scrollable/iframe-only indexes); paint-order occlusion removal; `*` new-element markers (weak delta); prompt ordering history-before-state for KV-cache hits; measured ~50K tokens/task | AgentBrowser's `interactive` mode already does element-extraction; compact makes it cheaper |
| agent-browser (vercel-labs) v0.38 | true `snapshot --delta` + **persistent refs** invalidated-not-recycled across same-document changes | the one working delta system pairs it with persistent refs — see §5 rejection rationale |
| Cloudflare browser-rendering MCP / Agents SDK browser tool | per-projection read tools (links/markdown/json); 5-tool code-mode surface; `maxChars` result bounds | bounded-output philosophy; already mirrored by maxBytes budgets |
| Anthropic tool guidance | `response_format` concise/detailed; high-signal fields; 25K-token response cap; actionable errors | `compact` flag = concise; protected core = high-signal; §2.7 errors |
| MCP spec 2025-06-18/2025-11-25 | `structuredContent`+text-fallback SHOULD; `title` vs `name`; deterministic tool order for prompt caching; SEP-1303 validation errors as tool errors | §4 MCP parity items; keep stable ordered catalog |

**Same-page representation costs** (D2Snap, arXiv 2508.04412, 52 Online-Mind2Web pages, mean per snapshot): raw screenshot 2,294 tokens / 0% success; grounded text+image 3,754 / 65%; **text tree only 1,461 tokens / 63%**; raw DOM truncated at 8,192 / 38%. Anthropic's computer-use docs price screenshots at 1,000–1,800 input tokens each (visual tokens = `ceil(w/28)×ceil(h/28)`, >20 images per request triggers forced downsizing). This is quantitative backing for ADR-003's text-over-screenshot stance and for compacting the tree itself.

Scale references: playwright-mcp catalog 19.6 KB/25 tools (#1772, with the maintainer's cache-math caveat: providers cache the tools prefix at ~0.1× cost, so the *static* catalog is real but amortized — the per-call observation bytes are the bigger lever); wild snapshots 50–540 KB (#1233); Wikipedia snapshot ~124K tokens (OpenBrowser's published comparison, chars/4 method); MCP vs Playwright-CLI ~114K vs ~27K tokens/task; production snapshot-trimming reports 10,000 → 500–1,000 tokens via per-region relevance filtering (arXiv 2511.19477).

---

## 7. Recommended acceptance criteria (additions to the handoff's list)

1. Fixture parity: same OVH-style fixture measured before/after for (a) full (unchanged bytes), (b) compact scoped observe — assert ≥90% reduction and exact expected element set; report both bytes and a tokenizer count, not just chars.
2. Ref correctness: compact→act→compact on an unchanged page keeps refs identical; acting on a ref that was filtered out of the response still resolves (P7); stale scope ref → typed error (P1, P14).
3. Continuation: `limit` + `--continue-from` round-trips every matching element exactly once, at >300 elements (P2) and under `maxBytes` pressure; `remaining` counts matches only.
4. Evidence preservation (redline tests): `valueRedacted` survives every compact shape; degraded responses keep `degraded`/`degradedReason` under filters; compact action results keep `newRevision`, `error.code`, `policyDecision` on denial, artifact ids, operation ids; CLI default render prints the continuation cursor and a redaction marker.
5. Performance non-regression: benchmarks observe→fill→verify loop run compact vs full — success parity required, token delta reported; add a >300-element page variant.
6. Compatibility: old-server + new-client → actionable error naming the unsupported params (P9); full mode byte-identical to today; `additionalProperties:false` unchanged for unknown keys.
7. Catalog: after description/schema slimming, `docs/mcp-tool-catalog.md` regenerated and drift gate green; catalog ≤ ~26 KB; no tool renamed; tool order unchanged (prompt-cache).
8. MCP result normalization: `browser_act`/`browser_navigate`/`browser_extract` return `structuredContent`; all text fallbacks minified; errors return structured `{error:{code,message,details}}` + `isError`.

## 8. Placement (where the work lands)

- Protocol (`packages/protocol`): `ObservationRequestSchema` + `roles`/`name`/`scopeRef`/`limit`/`includeFields`; compact action-result shape; `projection` echo on `PageState`; validator updates.
- Engine (`engine-playwright`): record a11y tree depth in `parseAriaSnapshot` → `RawElement.depth` (optional, additive; no behavior change elsewhere).
- Core/API: projection function beside `budgetObservation`, invoked in `service.ts` observe path **after** `secretManager.redact`, before budget; document-order invariant enforced there.
- CLI: `renderObservation` fixes; minified `--json`; projection flags; stderr JSON errors.
- MCP adapter: `outputSchema` additions, minified fallback, structured errors, slimmed descriptions, `$defs` dedup, advertise-`condition`-accept-`wait`.
- Docs: regenerate catalog doc; `docs/cli-agent-usage.md` gains the compact loop; ship SKILL.md; update the two handoff docs' acceptance sections.

This is a tool-ergonomics change throughout — it does not touch authorization, egress policy, or the active headed session, consistent with the handoff's closing constraint.
