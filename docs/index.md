---
hide:
  - navigation
---

# AgentBrowser

AgentBrowser is an **agent-native browser service**: AI agents drive a real
Chromium through a loopback REST/WebSocket service, a TypeScript SDK, a
compiled CLI, or an MCP stdio server — with the safety machinery enforced
*in the service*, not in the prompt.

Unlike traditional browser automation built for humans, AgentBrowser is
built around how agents fail:

- **Semantic observations over screenshots.** Accessibility-tree state,
  form values, and interactive elements, bounded to ~300 elements and byte
  budgets so an agent's context is not consumed by a 2 MB screenshot.
  Screenshots and PDFs are opt-in evidence, not the primary channel.
- **Stable element references.** Server-managed refs (`e<rev>_<ordinal>`)
  re-checked against page revision and fingerprint before every action;
  a changed page yields a typed `STALE_TARGET` that is never auto-retried.
- **Egress policy and SSRF defense.** Loopback, private ranges, and cloud
  metadata are denied by default; downloads are validated and capped.
  The layer is honestly partial — see the [threat model](threat-model.md)
  and the [comparison page](comparison.md).
- **Approval gates.** Single-use approval tokens bound to session, page
  revision, and fingerprint for high-risk actions.
- **Multi-tenancy.** Hashed tenant keys, per-route ownership checks,
  ephemeral isolated contexts.

## Quick start

```bash
# Install the service (Homebrew; npm and Docker also available)
brew install anvai-labs/tap/agentbrowser
brew services start anvai-labs/tap/agentbrowser

# Configure tenant keys (env contract of the service)
AGENTBROWSER_API_KEYS=key:tenant

# Drive it from an MCP client (the formula's caveats print the wiring)
brew info anvai-labs/tap/agentbrowser
```

Full operator guide: [Operations](operations.md). Tool-by-tool surface:
[MCP tool catalog](mcp-tool-catalog.md). Agent-facing usage patterns:
[CLI for agents](cli-agent-usage.md).

## Status

The original MVP is shipped and released (v1.x). The post-MVP program is
tracked as ten task packets, [T0–T9](spec/tasks/README.md): T0 (contract
catalog), T2 (shared execution) and T3 (QA regressions) are complete; T1,
T4, T5, T6 and T8 are active with named gates; T7 (audit/security) is active
with slices 2a, 1 and 3 delivered; T9 is a recurring release gate. The
[evidence index](spec/evidence/t0-foundation.md) records the qualification
behind every claim — the repo's discipline is that each claim is
adversarially reviewable.

## Honest positioning

How AgentBrowser compares with Chrome's own debug surfaces, Google's
chrome-devtools-mcp, and Anthropic's Claude browser integrations —
including what AgentBrowser is *bad* and *ugly* at:

**[AgentBrowser vs Chrome debug & Claude integrations](comparison.md)**

## Where to look

| If you want to… | Read |
| --- | --- |
| Understand the safety posture | [Threat model](threat-model.md) |
| Operate the service | [Operations](operations.md) |
| Drive it from an agent | [CLI for agents](cli-agent-usage.md) · [MCP catalog](mcp-tool-catalog.md) |
| Run headed/human-in-the-loop sessions | [Delegated sessions](delegated-sessions.md) |
| Follow the roadmap | [T0–T9 overview](spec/tasks/README.md) |
| Check a design decision | [Architecture decisions](adr/001-typescript-playwright-mvp.md) |
| Verify a shipped claim | [Evidence index](spec/evidence/t0-foundation.md) |
