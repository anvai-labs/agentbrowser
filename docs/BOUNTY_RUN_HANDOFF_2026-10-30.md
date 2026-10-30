# Handoff: bounty-pipeline dry-run findings → engineering items (2026-10-30)

**From:** Claude Code session (AnvaiOps bounty wedge, 2026-10-29/30)
**To:** Codex — implement in this repo (`~/code/agentbrowser`, branch `develop`, up to date with origin as of 2026-10-29)
**Context:** First real-world end-to-end run of the T7-scope → T10-ledger bounty workflow against live programs (HackerOne directory → policy vetting → scoped session → ledgered pass → `finding check` → `finding sarif`). The pipeline works. Below are the gaps the run exposed, with evidence, proposed fixes, and acceptance criteria. Evidence artifacts live outside this repo at `~/code/consulting/bounty/` (`PROGRAMS.md`, `scope-vercel.json`, `ledger-vercel-2026-10-30.ndjson`, `findings-vercel-2026-10-30.json`, `sarif-vercel-2026-10-30.sarif`).

Run summary: engagement `eng_8aa5b182a474f680e1dba103` (program `hackerone:vercel`), 472-record sealed ledger (chain verifies), 196 requests rate-limit-paced, 50 denials all correctly typed, 2 informational findings citation-checked, SARIF 2.1.0 exported. Zero policy escapes. Every item below is polish/diagnosability/fit-for-bounty-work, not a correctness hole.

---

## P1-1 · `scope import` needs bounty presets (or guidance) for JS-heavy sites

**Observation.** A "polite" scope (`requestBudget: 80`, `rateLimit: {requests: 2, perSeconds: 1}`) cannot load a single modern page. vercel.com pulls 50–100+ subresources per navigation (Next.js immutable chunks). Result: ~50 chunk requests hit `SCOPE_RATE_LIMITED`, scripts never loaded, `navigate` timed out, then the budget was gone (`SCOPE_BUDGET_EXHAUSTED` — budget counts every subrequest, as documented). Second run with `requestBudget: 400`, `rateLimit: {requests: 5, perSeconds: 1}` (Vercel's own documented scanner cap) rendered pages fine and still paced 196 requests.

**Evidence.** First-run ledger: `request.failed` seq 103–119 `SCOPE_RATE_LIMITED` (script chunks), seq 224 `SCOPE_BUDGET_EXHAUSTED`; navigate error `NAVIGATION_TIMEOUT`/`engine_error`. Scope status after first run: `{limit: 80, spent: 408, remaining: 0}` (hops counted).

**Proposal.** In `scope import` (and the operations doc):
1. Add per-platform presets that populate `requestBudget`/`rateLimit` from a budget model of *subresources per navigation*, not navigations (e.g. `budget ≈ pages_planned × 120`), and a rate limit at or below the program's published cap when known.
2. At minimum: `scope import --from h1` should warn when the resulting scope has `requestBudget < 150` ("a single JS-heavy page load consumes 50–120 requests; budget counts every subrequest and redirect hop").
3. Docs: add a "sizing an engagement" table to the bounty/engagement section of `operations.md`.

**Acceptance.** A preset or validation path exists; a scope with an unsustainably small budget for its rate limit either warns (import) or is documented with the arithmetic. Co-located tests for the warning logic.

## P1-2 · Scope-starved navigations report bare `engine_error`

**Observation.** When the scope (not the target) causes a navigation to fail, `navigate`'s failure detail is `details.reason: "engine_error"` — indistinguishable from a genuine engine fault. The scope story was only visible by replaying `request.failed` events and noticing the `SCOPE_RATE_LIMITED`/`SCOPE_BUDGET_EXHAUSTED` sub-codes.

**Evidence.** First-run navigate result: `{"code":"NAVIGATION_TIMEOUT","details":{"reason":"engine_error"}}` while the same page's ledger showed 20+ scope denials inside the navigation window.

**Proposal.** When a navigation fails/times out, if the session's scope denied requests attributed to that page during the navigation window, say so in the failure details — e.g. `details.scopeDenials: {rateLimited: 17, budgetExhausted: 3}` (counts already exist in scope status; this is correlation + surfacing, not new enforcement). Stretch: a hint string like `"page load was scope-starved; consider raising requestBudget/rateLimit"`.

**Acceptance.** Unit test: scoped session, budget too small for the page fixture → navigate failure carries the scope-denial counts. No change to denial semantics.

## P1-3 · Programs increasingly *require* research identity on traffic; T7 can validate markers but not inject them

**Observation.** Two of three shortlisted programs condition testing on researcher-identifiable traffic: Wolt requires an HTTP header `X-HackerOne-Research: <h1 username>` on all testing requests ("Reports resulting from testing without headers can result in the forfeiture of the eligible bounty"); A&F "strongly recommend" a modified User-Agent. T7 `identityBindings` are the inverse mechanism — they *deny a marked request on unbound hosts*; nothing injects the marker. So an agentbrowser session literally cannot comply with these policies today without unsupported tricks.

**Evidence.** `scope-wolt.json` carries the identityBinding but it is inert for outbound header setting; policy text quoted verbatim in `~/code/consulting/bounty/PROGRAMS.md`.

**Proposal.** Design-first item (needs a short design note alongside `docs/spec/design/t7-scope-enforcement.md` before code):
1. Scope-level `requestHeaders: [{header, value, hostSuffix?}]` — injected by the engine on every matching request; **refuse well-known headers** (`host`, `content-length`, `cookie`, `authorization`, …) per the existing identity-binding footgun note; cap count/total size; record the injected set in scope status and the engagement ledger so reports can prove compliance.
2. Separately, a session-level `userAgent` override (engine launch option) for the A&F-style "modified UA" recommendation — must be visible in `session status`.
3. Keep `identityBindings` semantics unchanged (validation), so the two mechanisms compose: inject + bind = provable compliance.

**Acceptance.** A Wolt-shaped scope can carry `X-HackerOne-Research` onto every request to `.wolt.com` and nowhere else; attempts to bind/inject well-known headers are refused with the existing `floor.`/`scope.` refusal style; ledger records the injection. Tests for refusal paths included.

## P2-4 · `engagement export --out` EEXISTs on re-export

**Observation.** Re-exporting the same engagement to the same path (natural: export while open to inspect, close session, export the sealed copy) fails: `EEXIST: file already exists, open '…ndjson'`. The `--out` contract is "created exclusively" — correct for safety, but there is no escape hatch.

**Evidence.** Exact error during the run; worked around by deleting the file first.

**Proposal.** Add `--force` (truncate-and-replace, same 0600 creation semantics), keep default exclusive. One-line docs row in `operations.md`.

**Acceptance.** `export --force` overwrites; without it, EEXIST stands. Test both.

## P2-5 · `paced` count only visible in `session scope`, not `session status`

**Observation.** `session scope <id>` reports `rateLimit: {requests, perSeconds, paced: 196}` — the single most useful "am I being a good citizen" number mid-engagement. Operators watching `session status` during a run don't see it.

**Proposal.** When the session is scoped with a rate limit, surface `paced` (and budget remaining) in `session status` output as well — read-only surfacing, no state change.

**Acceptance.** Status shows the counts for scoped sessions, absent for unscoped. Test on the status formatter.

## P3-6 · Docs: HackerOne (and similar) reject headless sessions

**Observation.** hackerone.com serves a "your JavaScript is disabled" wall to the headless engine; the same URL renders fully in a headed session (same engine build 156.0.8078.x, fresh profiles). This cost a debugging cycle before switching to `--no-headless`.

**Proposal.** A short note in the bounty/operations docs: program directories and auth-walled surfaces may fingerprint headless contexts; recommend headed sessions for directory/policy browsing, scoped headless for the in-scope target pass (our Vercel pass would likely have been fine headless — unverified).

**Acceptance.** Doc note exists; no code.

## P3-7 · CLI `session create` returns `pages: 0` (MCP returns an initial pageId)

**Observation.** MCP `session_create` hands back an initial `pageId`; the CLI create returned `"pages": 0` and required a separate `page create` before any navigation. Not wrong, just an asymmetry that cost a round trip.

**Proposal.** Either create the initial page in CLI `session create` (breaking-ish; maybe `--with-page`), or document the "create → page create" cadence in the CLI usage notes. Low priority.

---

## Constraints for all items

- **Restrict-only stance is load-bearing.** Scope unknown-field refusal ("a restriction the server cannot enforce is never ignored"), fail-closed scheme/port/exclusion checks, and the outermost-layer composition must not be weakened by P1-3's injection feature — injection is an *addition* expressed in scope, validated server-side, never a bypass of network policy.
- Follow existing conventions: colocated `.test.ts` suites, `SCOPE_*`/`floor.` error taxonomies, TD/T10 numbering for anything that changes documented behavior, design notes under `docs/spec/design/`.
- Reproduction material: scope files + sealed ledger + findings + SARIF at `~/code/consulting/bounty/`; first-run (starved) ledger was not retained — recreate with `scope-vercel.json` at `requestBudget: 80`, `rateLimit: {requests: 2, perSeconds: 1}` against any JS-heavy in-scope page.
- Suggested order: P2-4 (trivial) → P2-5 → P1-2 → P1-1 → P1-3 (design note first) → P3 docs.
