# R5b1 close-cause qualification

Scope: unreleased source candidate based on merged develop `752da5e`. See the
[design](../design/session-close-causes.md). This packet does not change installed
1.11.0 binaries and does not claim engine-disconnect classification.

## Failing-first and focused evidence

Protocol tests first rejected missing close-cause and terminal schemas. Coordinator
tests first failed because no terminal lookup existed. API tests first failed because
live remaining lease and authorized post-close details were absent. The shared client
projector test first failed because no strict terminal-detail reader existed.

The candidate now pins TTL equality, strict idle expiry, TTL precedence, explicit and
policy causes, first-trigger preservation after cleanup failure, invalid-clock cleanup,
frozen allowlisted records, time/global/per-tenant bounds, collision refusal and stale
captured-context fencing. HTTP tests cover live remaining-lease derivation, matching
tenant disclosure, cross-tenant indistinguishability and revoked delegated credentials.
CLI and MCP tests use the shared projector and withhold arbitrary sibling details.

Focused qualification before the final smoke includes 92 coordinator tests, 15
protocol diagnostics tests, 27 API diagnostics/coexistence tests, 38 API edge tests,
129 CLI tests and 84 MCP inspection/server tests. The API edge suite's two loopback
tests initially received sandbox `EPERM`; the unchanged tests passed when rerun with
loopback permission. The whole workspace type check, 895 documentation links across 229 Markdown files, 11
context-selection tests and the generated MCP catalog check pass.

The built headed Chromium research smoke passes authenticated REST, SDK, CLI and MCP
inspection, explicit-close projection and lazy TTL/idle projection. It also preserves
the existing 13/52 MiB extraction fixtures and complete evidence hashes. The final run after integration with the merged
operator-attachment packet passed and is recorded in `/private/tmp/r5b1-headed-smoke-final.log`. No merge or release is
represented by this evidence document.

## Remaining limits

Retention is in memory and disappears on restart. A terminal record explains the
observed logical-session transition; it is not durable audit history and cannot prove
who initiated an external browser shutdown. `engine_disconnected`, `engine_crash` and
`operator_window_closed` are not produced by this packet. R5b2 needs a typed engine
session signal and the same captured-context fence. T5 journal runtime composition,
automatic recovery and replay remain separate gated work.
