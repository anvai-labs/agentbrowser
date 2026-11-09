# ADR-034: Cross-machine operator Chrome attach (remote-login browsing topology)

**Status:** Accepted (pattern documented; service-env improvement proposed)
**Context:** 2026-11-09
**Related:** [ADR-025](025-operator-cookie-handoff.md) (operator cookie handoff),
[ADR-006](006-network-egress-policy-ssrf.md) (egress boundary),
[ADR-017](017-default-port-5709.md), `docs/cli-agent-usage.md` §Browse sites
where the human is already logged in, `docs/operations.md` env table.

## Context

The highest-value agent workflows attach to a **human's already-authenticated
Chrome profile** (cloud managers, billing portals, SSO surfaces where a fresh
login cannot be automated: WebAuthn ceremonies, 2FA, bot walls). The operator
Chrome and the agent driver usually live on **different machines**: the profile
is on the human's laptop/desktop, the agent runs on a server or workstation.
First production exercise (2026-11-08/09, driving the OVHcloud US manager and
Cloudflare dashboards from a Linux driver against a macOS operator Chrome)
surfaced four friction points, each of which cost a failed attempt:

1. **`cdpAttach` is daemon-local by design** — it attaches to the
   startup-configured profile on the daemon's host; there is no endpoint
   parameter. Correct remote topology was not obvious from the tool surface.
2. **Homebrew service regeneration** — adding
   `AGENTBROWSER_CDP_ENDPOINT`/`AGENTBROWSER_CDP_ALLOW_UNENFORCED_EGRESS` to a
   `brew services`-managed plist is silently wiped by `brew services restart`
   (the formula regenerates the plist), leaving the operator with a daemon that
   still refuses attach (`ENGINE_UNSUPPORTED`) and no visible cause.
3. **Auth split confusion** — `operator.keys` authenticates operator routes
   only (login browser, approvals, leases); session creation needs an **API
   key** whose tenant binding must match `--tenant`. A valid operator key
   presented as a session bearer yields `UNAUTHORIZED` with no hint.
4. **Multi-host wiring** — the daemon must run on the Chrome host; the agent
   drives it over a forwarded daemon port; the CDP port itself is only needed
   when daemon and Chrome differ, or when running a *second* daemon instance
   against a tunneled CDP endpoint.

## Decision

- **Document the canonical cross-machine topology** (done:
  `docs/cli-agent-usage.md`): daemon co-located with the operator Chrome;
  agent → daemon over an authenticated forwarded port; CDP endpoint stays
  loopback on the Chrome host.
- **Productize the attach environment** (proposed, this ADR's action item):
  the two `AGENTBROWSER_CDP_*` variables should be settable through the
  supported service-management path rather than plist hand-edits — concretely,
  the Homebrew formula should read an operator override file (e.g.
  `~/.config/agentbrowser/service.env`, owner-only, documented in
  `operations.md`) merged into the service environment at start. Hand-editing
  generated plists must never be the only way.
- **Improve the `UNAUTHORIZED` and `ENGINE_UNSUPPORTED` error surfaces** to
  carry the distinguishing hint: "operator keys authenticate operator routes
  only — use an API key bound to the tenant for session creation" and
  "cdpAttach requires the service-side env; if your daemon is
  service-managed, see the override-file mechanism".
- **Session-create response gains a self-identifying line** (attachment kind,
  daemon host/profile hint) so an agent can verify *which* Chrome it is
  driving before navigating — today only `diagnostics.attachment: cdp_attach`
  distinguishes it, with no host identity.

## Consequences

- Easier: agents can reach authenticated surfaces without credential sharing;
  the human stays in the loop for WebAuthn/2FA by design.
- Harder: the forwarded daemon port is an authenticated remote-control surface
  on the LAN — API keys become mandatory in this topology (they already are
  when `AGENTBROWSER_API_KEYS` is set); documentation must warn against
  forwarding 5709 unauthenticated.
- Trade-off: the override-file mechanism adds one service-startup read path
  (owner-only file, fail-open if absent — the plist remains the base).
- Alternatives considered: tunneling raw CDP and driving it without
  agentbrowser (loses semantic observation, scope ledger, approvals);
  cookie-seed handoff per ADR-033 (works for cookie-auth surfaces, loses
  WebAuthn/session-bound flows — the exact surfaces that motivate attach).

## Rationale

Co-design input from first production use: every friction above produced a
wrong-path attempt before success. Recording the topology as an ADR (not only
a runbook section) makes the multi-host attach a *supported shape* rather than
an emergent hack, and binds the three UX fixes to it.
