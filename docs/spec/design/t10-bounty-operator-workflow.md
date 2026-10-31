# T10 design: bounty exploration workflow — operator browser first, scoped evidence second

**Status: implemented for review (2026-10-30), T10 B1–B6.**
B2 is specified by [ADR-027](../../adr/027-evidence-pass-state-transfer.md).
B4 is narrowed by [ADR-028](../../adr/028-operator-asset-scope-amendments.md):
only static asset hosts append; program `allowedHosts` remain immutable.
The three-command acceptance reaches a fresh ledgered evidence context;
reproduction, close/seal and export are explicit subsequent actions.
See the [operator guide](../modes/bounty.md).
Evidence: three live bounty engagements run 2026-10-29/30 (Vercel ×2, Wolt, Vinted
recon, A&F attempt) plus two program-directory vetting passes, executed with
agentbrowser 1.28.0 built artifacts. Sealed ledgers referenced below exist under
the operator's engagement store; the friction catalog quotes them.

## The finding that drives this design

Every hard failure in four nights of live bounty work came from the same root:
**Playwright-launched contexts are fingerprinted as automation** by the exact
surfaces bounty researchers must use.

| Surface | What happened |
| --- | --- |
| hackerone.com directory (headless) | "JavaScript is disabled" wall; headed Playwright context passed |
| abercrombie.com (SFCC + Akamai) | Wall in headless AND headed Playwright with browser-like UA — persistent real Chrome only would have a chance |
| wolt.com signup | hCaptcha script denied by scope → form hung; also needs a real interactive context to pass |
| Retail/media sites generally | Consent CDNs (cookielaw), asset CDNs (ctfassets, cdn4dd), telemetry (sentry, datadog), SSO (google) all outside scope until manually adopted; until then the page is visually broken |

Meanwhile the **operator CDP-attach browser** (`cdpAttach` on the dedicated
persistent profile) sailed through every wall, kept logins/cookies across
sessions, and is where all identity work naturally lives (H1/Bugcrowd signups,
email verification links, alias inboxes).

The scoped marked session's unique value was proven too: Wolt's policy requires
`X-HackerOne-Research` on all testing traffic and forfeiture otherwise; the T7
`requestHeaders` injection produced 317+ `request.headersInjected` ledger
records — machine-checkable compliance evidence a plain browser cannot produce.

**Conclusion:** bounty mode should stop treating the scoped session as the
default vehicle and the operator browser as an exception. Invert them.

## Proposed workflow

```
program vetting → operator browser (cdpAttach): explore, signup, map the app
                        │  (discipline-enforced compliance: throttle by hand, stay on listed targets)
                        ▼
              finding candidate identified
                        │
                        ▼
        scoped+ledgered session ("evidence pass"): reproduce the PoC
        with requestHeaders marker, rate limit, budget, sealed ledger, SARIF
```

Exploration is where researchers live 95% of the time; evidence passes are
short, deliberate, and produce the artifact that wins the report.

## Implementation items (ordered)

### B1 · `bounty` mode session defaults (small)
`AGENTBROWSER_MODE=bounty` (or a `--mode bounty` flag on session create) should
default: `--no-headless`, idle timeout 1h, TTL 4h, rate 5/s. Rationale: the
10-minute idle default killed a live engagement mid-signup (documented
incident, Wolt engagement seq window); headless is wall-bait on program
surfaces. Env overrides already exist (`AGENTBROWSER_DEFAULT_IDLE_TIMEOUT_MS`,
`AGENTBROWSER_DEFAULT_TTL_MS`) — wire mode presets to them and document.

### B2 · Evidence-pass helper (core feature)
A first-class way to spawn the evidence session FROM the operator browser
state: `session create --evidence --from <operator-session>` that carries over
cookies AND localStorage for scope-allowed hosts into a fresh scoped context.
Tonight's blocker: Wolt auth lives in localStorage, so a cookies-only seed did
not transfer the session and identity flows had to be redone in-session. Needs
an ADR (extends TD-BROWSER-16 handoff): what transfers, host filtering against
the scope, ledger record of the transfer (hashes, not values).

### B3 · Asset-host adoption (kills the biggest friction)
When a scoped render is starved, the ledger already knows exactly which hosts
were denied. Add:
- `session scope-denied <id>` — summarize denied hostnames by count (today
  this is manual NDJSON grepping);
- `scope adopt-assets <scope-file> --from <ledger>` — append denied hosts as
  asset-only entries (requestHeaders stay host-bound to program targets so
  markers never leak to third parties), recorded in an append-only scope
  amendment log.

### B4 · Scope hot-amend for live sessions (design note first)
Tonight every host addition required destroying and recreating the session,
losing page state mid-flow. An operator-gated, ledger-audited in-session
`allowedHosts` append would remove the churn. Restrict-only stance must hold:
appends only, never removals, each amendment sealed into the ledger.

### B5 · Program-brief import bundles (extends `scope import`)
`--from bugcrowd|h1` briefs already parse program scopes. Add site-class
bundles for the hosts modern pages need (consent/captcha/asset/SSO categories)
flagged as `asset` class in the scope file so programs that forbid markers on
third parties (correctly) keep markers bound to program hosts only.

### B6 · Docs: the two-window contract
Write the workflow from "Proposed workflow" into `docs/spec/modes/bounty.md`:
operator browser = identity/exploration (no enforcement, human-grade), scoped
session = evidence (enforced, marked, ledgered). Tonight's live mapping:
operator Chrome held H1/Bugcrowd/Gmail sessions + program signups; the marked
Wolt session produced the injection ledger; Vinted (no marker requirement)
explored fine from either.

## Acceptance

- A new researcher can go from program brief → exploring in the operator
  browser → evidence pass with sealed ledger in ≤ 3 commands.
- No wall regression: bounty surfaces never see a headless default.
- Markers never leak to non-program hosts (existing requestHeaders host-binding
  tests stay green; asset-adoption preserves it).
- Every scope amendment and state transfer is ledger-auditable.

## Constraints

Restrict-only scope semantics, unknown-field refusal, and the cdpAttach
unenforced-egress acknowledgment (operator consent) are load-bearing; nothing
in this proposal weakens them. The operator browser must remain clearly
labeled as unenforced in every status surface it appears in.
