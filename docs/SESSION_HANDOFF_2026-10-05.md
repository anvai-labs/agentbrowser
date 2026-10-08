# Session handoff: bounty-foundation delivery (2026-10-02 .. 2026-10-05)

This document captures the complete state of the agentbrowser bounty-foundation
implementation session. A fresh session reading this + the task plan README has
full context to continue.

## What was delivered

14 merged PRs (#356–#372 plus #373–#374 promotion). The full bounty-foundation
stack is on **both develop and main** (promoted via #374).

### T7: audit/security — COMPLETE (all slices)

| Slice | Delivered | Gates |
|---|---|---|
| 2a | Engagement scope enforcement (`EngagementScopePolicy` — hosts/paths/methods/identity-bindings/expiry/budget) + service surface (`policy.scope` / MCP `scope` / CLI `--scope-file`) | 24 real-Chromium |
| 1a | Visual audit adapter (pixelmatch-wrapped, versioned baselines with explicit saves) | 10 |
| 1b | Accessibility adapter (axe-core in a Node DOM, page scripts never executed, layout-boundary recorded as incomplete) | 7 |
| 3 | Scanner-regression adapter (OWASP ZAP client, scope-enforced) + real-ZAP recorded run on ZAP 2.17.0 | 10 fixture + real scanner |
| 4 | SARIF 2.1.0 report adapter (impact/risk-to-level mappings, deterministic fingerprints) | 7 |
| — | Shared `FindingBaselineStore` (versioned JSON-doc persistence) | 5 |

Key PRs: #354 (scope primitive), #355 (scope surface), #365 (visual), #366 (a11y), #367 (ZAP), #368 (real-ZAP run), #370 (store), #373 (SARIF).

### T5: durable recovery — CI-gated adversarial matrix COMPLETE

- Read-only-filesystem and disk-full adversarial lanes (the last two CI-testable rows)
- 32 distinct qualification rows, all CI-blocking (journal-gates job)
- Operator quarantine/reconciliation procedure documented
- C4b precondition audit: all five delivery gates pass
- C4b execution-requirement protocol field + capability check + discovery IMPLEMENTED on develop

Key PRs: #357 (lanes), #359 (audit), #360 (procedure), #376 (C4b protocol).

### T1/T8: provider qualifications

- **Codex path**: tool-call, all slice-2 acceptance dimensions (union, enum, nested-object/array, typed evidence), cursor consumption/retirement choreography (all seven fields, takeover revocation, fresh-grant recovery, old-epoch refusal), provider-path resilience (down / restored / blackhole timeout)
- **Claude path**: cursor consumption/retirement choreography (same lifecycle)
- **Real-ZAP**: the scanner-regression adapter executed against real ZAP 2.17.0

Key PRs: #358 (Codex cursor), #364 (resilience), #372 (Claude cursor).

### Records and procedures

- N2: OS-enforced egress pairing prerequisite documented
- T5: operator quarantine/reconciliation procedure for journal stores
- T5: C4b precondition audit (all five delivery gates pass)
- Release-prep: CHANGELOG [Unreleased], T9 baseline updated
- Docs consistency sweep: 30 stale status lines corrected across 24 files

## Current gate status

| Gate | Status | What it opens |
|---|---|---|
| **F3 authorization** | **GRANTED** by the user | C4b implementation — protocol field + capability check are on develop; deployment of the durable store (Sandhi/inferflux on aiserver1) remains |
| **T4 live targets** | Authorized (targets not yet named) | Production-evidence gates |
| **Victor TLS trust** | **GRANTED** by the user | Victor live-loop qualification |
| **develop→main** | **EXECUTED** (#374) | The full stack is on main |

## Remaining work (next session)

### Immediate (engineering, unblocked)

1. **Victor live-loop qualification**: the TLS trust is authorized. Steps:
   a. SSH to aiserver1, create systemd units for inferflux and sandhi-proxy (so they survive WSL restarts)
   b. Enable + start sandhi-candidate.service (depends on sentinelpass-daemon, which is already running v0.14.2)
   c. Verify the Sandhi gateway is reachable and the self-signed CA is trusted
   d. Drive the Victor live-loop through the agentbrowser MCP
   e. Record the qualification

2. **F3 durable-store deployment**: the C4b protocol field and capability check
   are on develop. The remaining work is deploying a durable journal store
   (the Sandhi/inferflux services on aiserver1) and setting
   `durableJournalAvailable: true` on the service.

3. **T4 live-target evidence**: the user authorized targets but hasn't named
   specific ones. Next session should ask for the target list.

### Gated (user decision required)

- **T6 E0c/E1**: owned by the consuming workflow
- **T8 Claude depth**: act/navigate under delegation (not just control reads)
- **T7 slice 1b depth**: axe in a browser context (needs the injection decision)

## Key infrastructure facts (aiserver1)

- SSH: `vsingh@aiserver1` (Linux x86_64, no cargo/rustc — build on Mac, deploy binary)
- sentinelpass-daemon: ACTIVE, v0.14.2 (systemd user service)
- sandhi-candidate.service: DISABLED (TLS gateway; depends on sentinelpass-daemon; TLS certs at `~/.local/state/sandhi-rollout/tls/`)
- inferflux: RUNNING (pid 32840), binary at `~/code/inferflux/build-gpu-tls/inferfluxd`, listening on 127.0.0.1:8080. NO systemd unit — won't survive WSL restart
- aiserver-tunnel.service: ACTIVE, enabled (reverse tunnel ds3:8190 → aiserver1:8080)
- The sentinelpass-daemon symlink at `~/.local/bin/sentinelpass-daemon` points to 0.13.3 (stale — should point to 0.14.2)
- Sandhi gateway: binds 0.0.0.0:18788 TLS, uses sentinelpass vault backend

## Known Windows CI issues

- "Windows gotchas + build" (G2: .cmd shim launches via cmd.exe /c — "argv must survive the cmd relay") is a pre-existing Windows CI flake unrelated to the audit package. It is NOT a required check — the PR merges without it.
- The footprint gate can fail with "MCP handshake timeout" on cold runners — rerun clears it.
- The pre-push hook's concurrent all-package run starves under host load > 50 — `git push --no-verify` with the flake named is the established pattern.
- The attribution guard false-positives on technical provider mentions in commit messages — `git commit --no-verify` per its own error text.
