# Consumer Handoff — Implementation Briefs for Open Findings, 2026-09-25

**Status:** Implementation-ready briefs (each gated on TDD + smoke before commit)
**Context:** 2026-09-25, after verifying the 2026-09-24 consumer field
findings against the [1.11.0 release](consumer-field-handoff-2026-09-24.md)
(verification table in that document; brew service restarted on v1.11.0 and
every step re-driven live).
**Related:** [v1 field handoff + 1.11.0 verification](consumer-field-handoff-2026-09-24.md),
[ADR-006](adr/006-network-egress-policy-ssrf.md),
[ADR-008](adr/008-process-container-isolation.md),
[ADR-011](adr/011-safari-via-safaridriver-webdriver.md) (loud-refusal pattern),
[ADR-013](adr/013-headed-sessions-and-walled-logins.md),
[ADR-016](adr/016-branded-chrome-first-headed-launches.md),
[ADR-017](adr/017-default-port-5709.md),
[consumer research intake](spec/design/consumer-research-intake.md)

## Verification recap (what is already closed — do not re-implement)

F1 (MCP page provisioning), F2.1 (launch diagnostics), F8 (headed
screenshot) — **verified fixed in 1.11.0**. F7 is half-fixed
(browser-error-document failures are typed; DNS failures are not). F3 is
half-fixed (sibling-session preservation; close causes and lease
visibility not shipped). F2.2 and F4 are unstarted. This document carries
the open remainder only.

## Process contract — applies to every brief below

1. **TDD: write the failing tests first.** Every brief names its test
   cases; they must exist, fail, and then pass — in that order — before
   any implementation commit. Repo norm (`CLAUDE.md`): contract tests in
   the owning package, engine-neutral code stays Playwright-free.
2. **Smoke gate before commit.** Each brief ends with a consumer smoke
   reproduction (the exact live commands from the 2026-09-24/25 sessions).
   The smoke must pass against a locally restarted service *before*
   `git commit`, and the smoke transcript (commands + outputs) goes into
   the PR description alongside the test evidence.
3. **Workflow.** Feature branch from `develop`; PR back to `develop`;
   adversarial review per `CLAUDE.md`; no AI-authorship attribution.
   Public-surface changes (MCP tools, error payloads) require a
   CHANGELOG entry under the release's Added/Changed section.
4. **Sizing.** Each brief is one PR-sized slice. If implementation
   discovers a second PR-sized change, split it and note it in the PR —
   do not widen the slice.

---

## Brief 1 — Navigate failure reason classification (F7 remainder) — P1

### Onscreen prompt

> You are hardening `navigate` failure reporting in the AgentBrowser
> monorepo. Today, a navigation to a destination whose DNS does not
> resolve returns the same opaque `blocked` status as an egress-policy
> denial (consumer reproduction: `https://docs.montecarlodata.com/docs/`
> is NXDOMAIN after that vendor's docs migration, and it is
> indistinguishable from a policy block). 1.11.0 already types the
> browser-error-document case; extend the same discipline to every
> pre-response failure. Write the failing tests listed below FIRST, then
> implement a `reason` field on failed navigations with exactly these
> values: `dns_nxdomain`, `dns_timeout`, `dns_refused`, `tls_refused`,
> `egress_policy`, `browser_error_document` (existing — keep its
> semantics), `engine_error`. Rules: never infer a bot wall; never
> disclose the resolved address or error URL beyond echoing the caller's
> input; policy decisions keep coming from the ADR-006 choke point.
> Surface `reason` through REST, CLI (`navigate --json`), and the MCP
> navigate error payload. TDD and the consumer smoke gate are mandatory
> before any commit — a PR whose tests were written after the code will
> be rejected in review.

### TDD plan (write these first)

* `packages/policy` — extend the policy-denial test to assert
  `reason: "egress_policy"` on the typed failure.
* `packages/engine-playwright` (navigation wrapper) — with a scripted
  transport: `ERR_NAME_NOT_RESOLVED` → `dns_nxdomain`;
  `ERR_DNS_TIMED_OUT` → `dns_timeout`; `ERR_CONNECTION_REFUSED` after DNS
  → `dns_refused`; TLS alert / certificate rejection → `tls_refused`;
  browser error document → `browser_error_document` (assert the existing
  1.11.0 behavior now also carries the field).
* `packages/api` — navigate response envelope carries `reason` on
  failure; success responses carry no `reason`.
* `packages/mcp-server` — MCP navigate error payload includes `reason`.
* Known-live fixture: `docs.montecarlodata.com` is NXDOMAIN (captured
  2026-09-24); use it only in the smoke, not in unit tests.

### Smoke gate (before commit)

```bash
agentbrowser session create --tenant default   # note SESSION/PAGE
agentbrowser navigate $SESSION $PAGE https://docs.montecarlodata.com/docs/   # expect fail, reason dns_nxdomain
agentbrowser navigate $SESSION $PAGE https://www.montecarlodata.com/         # expect success (live successor domain)
agentbrowser navigate $SESSION $PAGE https://finance.yahoo.com/quote/TRV/key-statistics/  # expect fail, reason browser_error_document
agentbrowser navigate $SESSION $PAGE http://192.168.1.89:8080/               # expect success (allowed LAN target)
```

Acceptance: a consumer seeing `blocked` can read `reason` and know whether
the URL is stale, the network is hostile, or the policy said no — without
leaving the response.

---

## Brief 2 — Session close-cause classification and remaining lease (F3 remainder) — P2

### Onscreen prompt

> You are making session death legible in the AgentBrowser monorepo.
> Consumers lose sessions mid-work and today cannot tell idle expiry from
> an operator closing the headed window from an engine crash — every
> failure reads the same. Extend session views and session-scoped errors
> with (1) `closeCause`: `idle_expired` | `ttl_expired` |
> `operator_window_closed` | `engine_crash` | `policy_terminated` |
> `explicit_close`, populated by the session coordinator from the actual
> terminal transition, and (2) `leaseRemainingMs` (or `expiresAt`) on
> every session view and on the error envelope of session-scoped
> failures, so a consumer can see the lease draining before it dies.
> Semantics: an operator closing the headed window is NOT an engine
> crash; idle and TTL expiries come from the existing reaper paths;
> unknown causes must not be invented — default to the most specific
> truth the coordinator observed. Keep ADR-005 ephemerality semantics
> unchanged. TDD first per the plan below; the consumer smoke gate is
> mandatory before commit.

### TDD plan (write these first)

* `packages/core` (session coordinator) — drive each terminal transition
  through a fake clock/transport and assert the recorded cause:
  idle reaper → `idle_expired`; TTL → `ttl_expired`; explicit
  close → `explicit_close`; engine 'target destroyed' on a headed window
  → `operator_window_closed`; engine process exit → `engine_crash`.
* `packages/api` — `GET /v1/sessions/{id}` on a live session returns
  `leaseRemainingMs`; a session-scoped failure envelope (the
  `SESSION_NOT_FOUND` path) carries `closeCause` and `leaseRemainingMs: 0`.
* `packages/mcp-server` — MCP session-scoped errors include `closeCause`.
* Keep the existing states enum (`EXPIRED`, `ENGINE_CRASHED`,
  `POLICY_TERMINATED`, …) as the source of truth; `closeCause` refines,
  does not replace.

### Smoke gate (before commit)

```bash
agentbrowser session create --tenant default --headed    # note SESSION
# close the headed window by hand, then:
agentbrowser session get $SESSION                        # expect closeCause operator_window_closed
agentbrowser session create --tenant default             # note SESSION2
agentbrowser session get $SESSION2 --json                # expect leaseRemainingMs decreasing across reads
```

Acceptance: the 2026-09-24 mystery (three sessions lost mid-audit,
cause unknowable) is impossible to reproduce — every death names itself.

---

## Brief 3 — Opt-in CDP-attach session lane (F2.2) — P2

### Onscreen prompt

> You are adding an opt-in "attach to the operator's browser" session
> lane to the AgentBrowser monorepo, per consumer field request F2.2:
> for bot-walled destinations, attach to a Chrome the operator launched
> themselves (`connectOverCDP`) so the session inherits the operator's
> profile, keychain trust, and residential network. Rules: (1) OFF by
> default — an attach request fails with a loud, remediated error unless
> the service was started with `AGENTBROWSER_CDP_ENDPOINT` (or equivalent
> create option); (2) unavailable in hosted multi-tenant mode per ADR-008
> — refuse loudly, like ADR-011; (3) egress policy follows ADR-006: if
> the attached browser cannot honor the choke point, say so in the
> response and diagnostics rather than silently weakening policy;
> (4) never default to the operator's daily profile — documentation and
> the attach response recommend a dedicated `--user-data-dir`; (5)
> diagnostics (1.11.0 block) must report `attachment: "cdp_attach"` plus
> endpoint class, never credentials or full URLs. Session lifecycle:
> disconnect must leave the operator's browser running. TDD first per the
> plan; the smoke gate is mandatory before commit.

### TDD plan (write these first)

* `packages/engine-playwright` — attach lifecycle contract tests with a
  scripted connection: connect → page create → navigate → disconnect
  leaves the remote browser alive; failed connect cleans up owned
  resources (mirror the 1.11.0 ownership fix); attach reports
  `attachment: "cdp_attach"` in diagnostics.
* `packages/policy` — attach lane disabled by default (typed
  configuration error naming the enabling env); enabled → policy check
  still consulted for navigations the service initiates, and the
  cannot-enforce case returns the ADR-011-style loud refusal.
* `packages/api` / `packages/mcp-server` — create option
  (`cdpAttach: true` + endpoint source) parses; refusal errors carry
  remediation text; docs strings match.
* `docs/operations.md` — operator section: launch Chrome with
  `--remote-debugging-port=9222 --user-data-dir=<dedicated>`, set the
  env, expected diagnostics, and the daily-profile risk note.

### Smoke gate (before commit)

```bash
# operator machine, dedicated profile:
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --remote-debugging-port=9222 --user-data-dir=$HOME/tmp/cdp-profile &
AGENTBROWSER_CDP_ENDPOINT=http://localhost:9222 <restarted service>
agentbrowser session create --tenant default --cdp-attach   # expect attach + cdp_attach diagnostics
agentbrowser navigate $SESSION $PAGE https://finance.yahoo.com/quote/AAPL  # expect SUCCESS (the walled case)
agentbrowser session close $SESSION                          # operator browser stays open
# and with the env unset: create must refuse loudly with remediation.
```

Acceptance: the 2026-09-24 Yahoo wall passes from a lab machine without
arms-racing CDP fingerprinting (we inherit the operator's trust), while
default behavior and hosted mode are unchanged.

---

## Brief 4 — EDGAR/filings research recipe (F4) — P3, docs-only

### Onscreen prompt

> You are writing `docs/recipes/edgar-filings.md` for the AgentBrowser
> docs tree: the proven recipe for SEC EDGAR research from the
> 2026-09-24 consumer run. Content to cover, with the working URLs
> inline: (1) prefer `data.sec.gov/submissions/CIK##########.json` for
> filing inventories (parse form/filingDate/accessionNumber locally) and
> `efts.sec.gov/LATEST/search-index` for full-text search — the hit
> `_id` is `accession:filename`, which builds the primary-document URL
> `https://www.sec.gov/Archives/edgar/data/<cik>/<accession-no-dashes>/<filename>`;
> (2) `www.sec.gov/cgi-bin/browse-edgar` throttles intermittently with a
> maintenance page — treat it as last resort and keep ~1 request/second;
> (3) large primary documents (10–52 MB) load fine — extract to the
> persisted-output overflow file and grep locally; (4) earnings 8-K
> EX-99.1 press releases are the compact carrier of segment metrics;
> (5) a worked example: the TRV → HIG → ALL walk (inventory, consent
> walk for auth, combined-ratio extraction) as executed on 2026-09-24.
> All links must resolve — the docs CI includes a link check; fetch each
> URL at authoring time and record its status in a table. Run the doc
> lint and the link check before commit (this is the TDD equivalent for
> a docs-only slice: the failing state is a red link check).

### Smoke gate (before commit)

* `pnpm` docs link check green locally.
* Every command block in the recipe executed once by the author, outputs
  pasted as comments.

Acceptance: a consumer can reproduce the full 2026-09-24 EDGAR research
run from the recipe alone, without hitting the throttle.

---

## Priority and sequencing

| Brief | Priority | Suggested slice | Depends on |
| --- | --- | --- | --- |
| 1 — navigate reasons | P1 | ~1 PR (policy + engine + surfaces) | none |
| 2 — close causes + lease | P2 | ~1–2 PRs (core + surfaces) | none |
| 3 — CDP-attach lane | P2 | ~2 PRs (engine + api/mcp + docs) | none |
| 4 — EDGAR recipe | P3 | 1 docs PR | none |

All four are independent. Briefs 1 and 2 close the last consumer-visible
observability gaps; Brief 3 opens the walled-site lane that ADR-013
deliberately left to a non-fingerprinting path; Brief 4 is pure docs.

## Commit gate (repeated, because it is the contract)

**No commit without: (1) the brief's named tests written first and
passing, (2) the brief's consumer smoke reproduction executed and its
transcript in the PR, (3) `pnpm -r type-check && pnpm -r test && pnpm -r
lint` green, (4) CHANGELOG entry for anything on a public surface.**
