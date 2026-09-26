# Consumer Field Handoff — MCP Research Workload, 2026-09-24

> **Follow-up:** open findings from this handoff are now
> implementation-ready briefs with paste-ready onscreen prompts, TDD
> plans, and smoke gates — see
> [Consumer Handoff: Implementation Briefs, 2026-09-25](consumer-field-handoff-2026-09-25-implementation-briefs.md).
> The verification table at the bottom of this document records what
> 1.11.0 already closed.

## Verification against 1.11.0 (2026-09-25, brew service restarted on v1.11.0)

| Finding | 1.11.0 disposition | Evidence |
| --- | --- | --- |
| F1 tab provisioning | **VERIFIED FIXED** | Changelog ships MCP `browser_page_create` / `browser_pages` (PR #286 `fix/research-consumer-workflow`); page lifecycle re-verified live via CLI (two active pages in one session). Navigate auto-provisioning intentionally absent — the explicit verbs are the contract. New-session MCP consumers get the tools. |
| F2.1 launch diagnostics | **VERIFIED FIXED** | `session create` response now carries a `diagnostics` block: `executableSelection: detected` (branded Chrome per ADR-016), `launchMode: headed`, `viewport.mode: no_viewport` (window-true), `initScript: registered` (ADR-013 scrub) — exactly the "what actually launched" visibility requested. |
| F7 blocked/no-reason | **FIXED ON DEVELOP, PENDING RELEASE** | 1.11.0 typed the browser-error-document case; develop goes further — `classifyNavigationFailure` (engine/src/navigation-failure.ts) maps DNS/TLS/transport errors to the full reason taxonomy with unit + integration + MCP payload tests (verified on 2026-09-25). The brew release still shows bare `blocked` on NXDOMAIN until the next tag. |
| F3 session lifecycle | **PARTIALLY FIXED** | Remote-session close now preserves sibling sessions; engine shutdown drains pending setups. Close-cause classification and remaining-lease visibility not yet shipped. |
| F8 headed screenshot timeout | **VERIFIED FIXED** | Headed `screenshot` captured immediately on 1.11.0 (previously two consecutive timeouts on the same host/page); artifact retrieval via `artifact get --json` works. Visual look-and-feel audits are unblocked (used same-day on the AnvaiOps control plane). |
| F2.2 CDP-attach lane | **NOT SHIPPED** | Absent from the 1.11.0 changelog. |

Smoke regression after the service restart: consumer's 24-check UI suite
passed 19/19 public checks (unauthenticated variant), 0 failures.



**Status:** Field report (input to backlog; makes no decisions)
**Context:** 2026-09-24
**Producer:** Claude Code consumer session driving `agentbrowser-mcp` (headed
sessions) for a multi-hour financial-research workload
**Related:** [ADR-005](adr/005-ephemeral-sessions-explicit-persistence.md),
[ADR-009](adr/009-mcp-high-level-tools.md),
[ADR-013](adr/013-headed-sessions-and-walled-logins.md),
[ADR-016](adr/016-branded-chrome-first-headed-launches.md),
[Shared session infrastructure](shared-session-infrastructure.md),
[TD-BROWSER-10](td/TD-BROWSER-10-session-extension-loading.md),
[TD-BROWSER-11](td/TD-BROWSER-11-session-initial-page-race.md)

This document records what an intensive real consumer workload experienced on
2026-09-24, what held up, where the MCP surface forced workarounds, and the
resulting change requests. Every finding below was observed live and is
reproducible from the logged operation IDs in §5.

## 1. The workload

Three research sprints, ~120 MCP tool calls, all `headless: false`, one
tenant (`default`):

| Sprint | Target sites | Doc sizes touched |
| --- | --- | --- |
| Insurance sector filings | `sec.gov` (browse-edgar, FTS SPA), `data.sec.gov` (submissions JSON), `efts.sec.gov` (FTS API), 10-K/10-Q/8-K primary documents | 13–52 MB filing HTML |
| Semiconductors | EDGAR 10-Q/10-K documents, `stockanalysis.com` | 12–28 MB filing HTML |
| FAANG + hyperscalers | `stockanalysis.com`, EDGAR 10-Q documents | up to ~30 MB filing HTML |

Patterns used: sequential navigate→extract pipelines on single pages, three
parallel sessions when a single session could not branch (see F1), and
large-text extraction with reliance on the persisted-output overflow files
(§2).

## 2. What held up (preserve these contracts)

- **Large-document extraction.** 13–52 MB SEC filing pages loaded and
  extracted to the persisted-output overflow files without error. This made
  "load the 10-Q, grep MD&A locally" a viable consumer pattern — it is now
  load-bearing for our research workflows. Please treat the overflow file
  contract (path shape, `{"data":{"text":…}}` wrapper) as stable API.
- **JSON endpoints in the page.** `data.sec.gov` submissions JSON (~190 KB)
  and `efts.sec.gov` search-index responses render and extract cleanly.
- **Evidence on every extract.** URL/revision/hash in `evidence` let the
  consumer reconcile repeated extractions of mutating pages (the stock quote
  pages bumped revision between calls; the hash disambiguated).
- **Create response shape.** Returning `pageId` up front made the first
  navigate immediate.

## 3. Findings and change requests

### F1 — The MCP surface cannot create tabs (P1)

**Observed.** `browser_navigate` to a not-yet-existing `pageId`
(`pg_12_page-1`, `pg_12_page-2`) inside a live session returns
`NOT_FOUND: Page pg_12_page-1 does not exist in session …`. Pages exist only
when the service provisions them at `create` (always exactly one,
`pg_N_page-0`).

**Update 2026-09-24 (later run).** The service **already supports multi-page
sessions** — `agentbrowser page create <sessionId>` (plus `page list/get/
close`) works against a live session and returns a second active page.
F1 is therefore confirmed as purely an **MCP adapter gap**: the tool catalog
lacks the page CRUD verbs the CLI/REST surface has. Exposing them closes
this finding.

**Impact.** The natural consumer model — one browser, N tabs, shared cookie
jar — is unavailable to MCP consumers. To parallelize a crawl we were forced
into N parallel sessions, i.e. N independent cookie jars and N fingerprints,
plus N windows on the operator's desktop (three were needed; each is also a
separate thing that can die mid-task, see F4).

**Request.** Expose page provisioning on the MCP surface: an explicit
`session_page_create`/`page_close` tool pair (mirroring the existing CLI
verbs) or implicit auto-provisioning when `browser_navigate` targets a new
`pageId` within a session page budget.
[Shared session infrastructure](shared-session-infrastructure.md) already
frames sessions/pages/agents as first-class shared infrastructure and notes
"MCP compatibility is an adapter concern" — this is the adapter gap. The
`create` response already implies a page set (`pg_N_page-0` naming); make the
set growable and report provisioned `pageId`s in `create`'s response.

### F8 — Headed-session `screenshot` times out (P3)

**Observed.** Two consecutive `screenshot` calls (jpeg, then jpeg with
`wait: settled/15s`) against a healthy headed session on a fully rendered
page both returned `TIMEOUT: Request timeout; outcome may be unknown`.
Navigate/observe/extract on the same page kept working. Reproduced only on
the headed Windows-less macOS host so far; headless sessions were not
exercised for screenshots in the same window.

**Impact.** Visual look-and-feel audits — the thing screenshots exist for —
are unavailable in headed sessions; consumers fall back to semantic
snapshots, which cannot judge aesthetics.

**Request.** Investigate the headed capture path (compositor/window-occlusion
on macOS?), and return a typed capture-failed error instead of a timeout
when the frame cannot be produced.

### F2 — Bot-walled sites: confirm ADR-013 in the field, then give consumers visibility and an escape lane (P1)

**Observed.** `finance.yahoo.com/quote/TRV/key-statistics/` navigate returns
`status: success` with `url: chrome-error://chromewebdata/` — the wall fires
before content, even in a headed session. Separately, `sec.gov`
`browse-edgar` intermittently serves its "temporarily unavailable /
undergoing maintenance" throttle page while `data.sec.gov` and `efts.sec.gov`
on the same egress work fine (see F5's recipe notes).

**Interpretation.** Consistent with ADR-013's conclusion: CDP-driven sessions
are fingerprintable regardless of launch flags, and egress reputation
(datacenter IP, automation-typical TLS) does the rest. ADR-016's
branded-Chrome-first rule improves surface compatibility but does not claim
anti-detection. No contradiction with the ADRs — this is the field
confirmation of them.

**Requests.**

1. **Launch-profile diagnostics.** A consumer staring at a wall cannot tell
   *what* the session actually launched (branded Chrome vs bundled
   Chromium — ADR-016's resolution depends on the host machine — whether the
   headed scrub from ADR-013 was applied, viewport mode). Add either fields
   on the `create` response or a `session_diagnostics` read: engine binary
   path, branded-vs-bundled, active launch flags, `navigator.webdriver`
   observed value, viewport mode (pinned vs window-true), egress hint.
2. **CDP-attach session type (opt-in).** ADR-013 shipped cookie-seeding
   handoff for walled logins; the complementary lane is attaching to the
   operator's own running Chrome (`connectOverCDP`), which inherits the real
   profile, home-IP egress, and real TLS stack. Scope it loudly: never the
   daily profile by default, dedicated `--user-data-dir` documented, and
   keep it unavailable in hosted multi-tenant mode per ADR-008.

### F3 — Session mortality mid-task (P2)

**Observed.** Across the day, five sessions died out from under in-flight
work: one after a ~5 h idle gap (expected: idle reaper), but three within
seconds-to-minutes of successful calls, and one immediately after a
successful `navigate` (the next `extract` hit
`SESSION_NOT_FOUND`). Possible operator window-closes; not distinguishable
from the consumer side.

**Impact.** Every death cost a full session re-create plus navigation replay;
mid-research, pages keep no server-side draft, so re-entry is manual.

**Requests.** (a) distinguish close causes in the reconciliation payload
(operator window closed vs idle expiry vs engine crash); (b) surface
remaining lease on the response envelope (create already returns
`ttlMs`/`idleTimeoutMs`; nothing refreshes the consumer's knowledge later);
(c) when the shared-session reconnection work lands, headed sessions should
re-attach rather than re-spawn.

### F4 — Field recipe for filings research: `browse-edgar` is the wrong lane (P3, docs)

`www.sec.gov/cgi-bin/browse-edgar` throttled intermittently ("SEC.gov is
undergoing maintenance") while `data.sec.gov/submissions/CIK##########.json`
and `efts.sec.gov/LATEST/search-index` (both machine-readable) worked
reliably all day. Worth a recipes page (filings/EDGAR etiquette): prefer the
JSON endpoints, keep ~1 rps, use FTS `_id` (`accession:filename`) to build
primary-document URLs directly. Happy to draft it from today's working
patterns.

### F7 — `navigate` reports `blocked` without a reason; NXDOMAIN and policy denial are indistinguishable (P1, small)

**Observed.** Same session, same egress:

* `https://docs.montecarlodata.com/docs/` → `{"status": "blocked", "url": <unchanged>}`
* `https://www.montecarlodata.com/` → `{"status": "success"}` (redirects to montecarlo.ai)

**Investigated to root cause** (2026-09-24): `docs.montecarlodata.com` does
not resolve **at all** — NXDOMAIN from any resolver (confirmed with `dig`
and `curl` exit 6 outside agentbrowser; the subdomain is dead after Monte
Carlo migrated docs to `docs.getmontecarlo.com`, which navigates
successfully). So this instance of `blocked` was a **destination that no
longer exists**, surfaced with the same one-word status a policy denial
would use.

**Impact.** The consumer cannot distinguish (a) a dead/stale URL
(NXDOMAIN), (b) a TLS-layer refusal, (c) an agentbrowser egress-policy
block, or (d) a site-side wall — and today (a) and (c) produce the
identical `blocked` status with no payload. Debugging required a
second resolver outside the service.

**Request.** Enrich the `blocked` response: `{"status": "blocked",
"reason": "dns_nxdomain" | "dns_timeout" | "tls_refused" |
"egress_policy", "detail": …}` — the DNS failure class is already known
at the point of classification, and the egress-policy choke point
(ADR-006) knows when *it* is the blocker. Lowest-cost fix, highest
consumer-debugging value of everything in this handoff.

## 4. Non-goals noted explicitly

Per ADR-013: we are **not** asking the service to enter an arms race against
CDP-fingerprinting walls, and we accept that headless stays honestly
identifiable as automation. F2's requests are about *visibility* (F2.1) and
an *honest alternative lane* (F2.2), not about making Playwright pass
turnstile.

## 5. Evidence log

| When | Symptom | Verbatim signal |
| --- | --- | --- |
| 2026-09-24 ~06:22Z | Session died after idle gap | `SESSION_NOT_FOUND: Session ses_1790230930811_n2jd3xqfb does not exist.` (op `61adde24-1ca0-4488-a066-7d1b25ebd017`) |
| 2026-09-24 ~11:42Z | Tab creation rejected | `NOT_FOUND: Page pg_12_page-1 does not exist in session ses_1790249769769_ufd84mpz7.` (op `678df1f2-7d3f-46f0-a848-ac1b81675953`; same for `pg_12_page-2`, op `0c4c0fe4-3cc9-4fae-a676-d70fdd1b923`) |
| 2026-09-24 ~11:5xZ | Navigation timeout (page still loaded; extract succeeded) | `TIMEOUT: Request timeout; outcome may be unknown` (op `59166a11-d9f9-4320-9f7f-02e518394b25`) |
| 2026-09-24 | SEC browse-edgar throttle | "This page is temporarily unavailable. SEC.gov is undergoing maintenance." — blocked `CIK=all` and numeric-CIK queries after two earlier successes |
| 2026-09-24 ~12:4xZ | Yahoo wall | navigate returns `success`, `url: chrome-error://chromewebdata/`, empty DOM |
| 2026-09-24 ~14:0xZ | Three fresh sessions died within ~2 calls each | `SESSION_NOT_FOUND` ops `39816079-faaa-46b4-…`, `fb84e1a0-…`, `ea150507-…` (partial IDs logged) |
| 2026-09-24 ~14:5xZ | Death immediately after successful navigate | op `81dddd37-…`; same URL then succeeded on a fresh session |
| 2026-09-24 ~18:5xZ | `blocked` on a dead subdomain | `docs.montecarlodata.com` → `{"status":"blocked"}`; NXDOMAIN confirmed outside agentbrowser; `www.montecarlodata.com` → success; live successor `docs.getmontecarlo.com` → success |

## 6. Suggested priority

1. **P1** F1 tab/page provisioning on the MCP surface (blocks the
   single-browser-multi-tab operating model).
2. **P1** F7 `blocked` reason classification (small; NXDOMAIN vs policy
   denial cost a live debugging session today).
3. **P1** F2.1 launch-profile diagnostics (small, unblocks consumer
   reasoning about walls; complements ADR-016).
4. **P2** F2.2 CDP-attach session type (opt-in, loud scoping).
5. **P2** F3 close-cause distinction + remaining-lease visibility.
6. **P3** F4 EDGAR/filings recipe page.
