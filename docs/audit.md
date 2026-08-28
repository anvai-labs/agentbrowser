# Full audit: vision vs implementation (2026-08-26; remediation 2026-08-27)

**Status update (2026-08-27):** all P0s are closed. P0-2 (expiry leak),
P0-5 (capability truth) and the dead logger were fixed with the audit
itself; P0-3 (dialogs), P0-4 (engine-level egress with redirect
enforcement) and P0-1 (authn/tenancy) landed as dedicated commits, along
with P1-1 (/v1 versioning), P1-2 (per-session allowedHosts/blockedHosts),
P1-3 (maxBytes observation bound) and P1-8 (threat model:
docs/threat-model.md). The remaining P1s and P2s are re-prioritized
below.

Audited against `agentbrowser-mvp-spec.md` (the vision), the technical
design (TD-001..TD-026, all complete), ADRs 001-010, and the code as of
`9d8c817`. Every finding below was verified in code, not inferred.
Status legend: **P0** = security/correctness, address next; **P1** =
spec completeness; **P2** = polish.

---

## What the vision got (verified)

The core architecture holds and is tested: protocol-first versioned
schemas; engine-neutral `BrowserEngine` contract with a reference
implementation (FakeEngine) and a real one (Playwright ref store,
resolve/act through refs); semantic observations with revision-stamped
refs, diffs and continuation; staleness never guessed; SSRF defaults on
navigation; approval gates bound to high-risk elements; secrets redacted
at every output boundary; deterministic extraction with evidence hashes;
tracing/metrics/health/crash recovery; hardened read-only Docker; the
50-task benchmark gate at 100%; and the ADR-010 comparative data showing
real Chromium well inside every latency target.

---

## P0 findings

### P0-1 No authentication or tenancy boundary
Zero references to any auth in `packages/api/src/server.ts`. Anyone who
can reach the server can use any session and read any artifact.
**Vision:** refs scoped tenant+session+page; cross-tenant leakage is an
enumerated threat; `UNAUTHORIZED`/`FORBIDDEN` are protocol codes with no
producer. The spec scopes the *local* MVP as "trusted single-tenant"
(context isolation), so this is not a spec violation today — but it is
the single largest under-developed area, and the spec is explicit that
the hosted milestone must default to process-level isolation.
**Remedy:** bearer-token middleware (API keys per tenant), tenant
stamped onto sessions, artifact access scoped by tenant, and the
process-isolation engine mode for hosted deployments.

### P0-2 TTL/idle expiry leaks service state
`SessionCoordinator.runCleanup()` silently removes expired sessions,
but `AgentBrowserService` is never told: `pages`, `eventListeners` and
download-policy entries for expired sessions are only cleaned on
explicit `closeSession` (verified: cleanup exists only in
`closeSession`/`recoverFromCrash`). A long-running server with TTL
expiry grows without bound. The soak test misses this because it closes
explicitly.
**Remedy:** a periodic service-level sweep that reconciles its page
registry against `coordinator.getAllSessions()`, or an expiry callback
from the coordinator.

### P0-3 Dialogs are invisible and uncontrollable
**Premise corrected by evidence (fixture regression test):** with no
`page.on('dialog')` handler, Playwright auto-dismisses dialogs, so pages
do NOT deadlock today. The real, verified gaps: dialogs are never
surfaced (`dialog.opened`/`dialog.closed` events have no producer), a
confirm/prompt can never be *accepted* (the agent cannot answer), and
the protocol's `dismissDialog`/`acceptDialog` actions are unimplemented
everywhere.
**Remedy:** hold dialogs with an auto-dismiss grace (beforeunload
auto-accepts), emit dialog events, implement the two actions acting on
the held dialog.

### P0-4 Redirects and subresources bypass egress policy — architectural
The spec's invariant #7 is a network-level **choke point**: main
documents, redirects, subresources, fetch/XHR, WebSockets and downloads
all policy-checked. Today only the *initial navigation URL* is checked
in the service; Playwright then follows redirects internally (a public
URL 302-ing to `169.254.169.254` or an internal host is followed), and
subresources/XHR are never checked. `NetworkPolicy.checkRedirectChain`
and `checkResponse` exist, tested — and are wired to nothing.
**This is the one architectural shift the vision still requires:**
egress enforcement must move into the engine's network layer.
**Remedy:** inject the `NetworkPolicy` into `PlaywrightChromiumEngine`
and enforce via `context.route('**', ...)` per request (hostname +
redirect chain + response-size caps), keeping the service-level URL
check as fast-fail. DNS-resolution pinning (rebinding defense) is the
harder tail of the same invariant.

### P0-5 Capabilities overclaim
`PlaywrightChromiumEngine.capabilities()` advertises `compact_dom`/`visual`
observation modes and 17 action types; the stack delivers 3 modes and 5
actions (executor's supported set). A client negotiating on
capabilities gets a silent mismatch — the exact anti-pattern ADR-009
and the spec's "no silent fallback" rule exist to prevent.
**Remedy:** capabilities must report the delivered truth from a single
shared source; unknown actions already fail typed (`INVALID_REQUEST`),
so aligning the advertised list is a small, honest fix.

---

## P1 findings (spec completeness)

| # | Gap | Vision reference | Notes |
| - | --- | ---------------- | ----- |
| 1 | Unversioned routes (`/sessions`, not `/v1/sessions`) | §13.1 | All REST paths in the spec are `/v1/*` |
| 2 | Per-session `allowedHosts`/`blockedHosts` unenforced | §13.2 policy | Field accepted, ignored; only SSRF defaults run |
| 3 | `maxBytes` observation bound unused | §10 | Accepted everywhere, truncates by element count only |
| 4 | Wait conditions beyond navigate `waitUntil` | §11.1 | `settled`, deadlines + completion reasons not implemented |
| 5 | In-page downloads via engine events | §10 | Fetch-by-URL only (documented MVP cut) |
| 6 | Short-lived artifact authorization | §13.1 | Tied to P0-1; artifacts currently open |
| 7 | Schema-constrained extraction (model adapter) | §12.2 | Deterministic extractors done; pluggable provider missing |
| 8 | Threat model never written | TD-006, Phase 0 exit, CLAUDE.md | P0 roadmap item, still absent |
| 9 | `maskSensitive` screenshots unimplemented | §12/§16 | Accepted, ignored |
| 10 | Response-size caps unwired | §17 threats | `checkResponse` tested, never called |
| 11 | `text[]` content mode + frames | §10 | Content mode returns elements only; top frame only |

## P2 findings (polish)

- CLI lacks `press`, `scroll`, and `extract` commands (API/SDK/MCP have
  them).
- `bin.ts` constructs a `StructuredLogger` and never passes it to the
  service — production currently has no operation logging.
- SDK `SessionRequest` (tenantId-based) has drifted from the protocol
  `SessionRequest` (engine required); reconcile at the protocol level.
- MCP `browser_observe` does not expose `maxBytes`.
- Expiry events (session TTL) are not emitted to the event stream.

---

## Architectural assessment

**Decisions that held up:** protocol-over-implementation; the
engine-neutral contract with FakeEngine as reference; the service as
revision authority (refs, diffs, staleness all coherent); secrets
redaction at output boundaries; single-node in-memory state — the spec
explicitly scopes the MVP to single-node with no HA claims, so the
in-memory stores are *on-vision*, not debt.

**Shifts still required by the vision:**
1. **Egress into the engine network layer** (P0-4) — the only place the
   spec's choke-point invariant can actually be enforced.
2. **Tenancy milestone** (P0-1) — bearer/API-key authn, tenant scoping,
   then process-per-session isolation for hosted mode (spec: context
   isolation is explicitly *not* a hostile multi-tenant boundary).

**No shift needed** for: event streaming (pump model is sound),
extraction (adapter slot is clean), telemetry, or the revision model.

---

## Remaining work (post-remediation priorities)

**All P1 and P2 items are closed (2026-08-28).** Landed: wait conditions
with deadlines and completion reasons (§11.1); in-page download
interception with bytes, events and collect endpoint (§10);
schema-constrained extraction with a deterministic default and pluggable
model adapter (§12.2); maskSensitive honest-warning; response-cap
enforcement at the choke point; `text[]` content mode; CLI parity
(press/scroll/dialogs/extract); protocol/SDK SessionRequest
reconciliation; expiry events on the stream; time-boxed artifact tokens.

Residuals (named, deferred by design - see docs/threat-model.md): frames
observation, DNS-rebinding pinning, WebSocket upgrade interception,
pixel-level screenshot masking, process-per-session isolation.
