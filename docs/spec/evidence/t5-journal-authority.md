# T5 C1b: intent and dispatch acknowledgment composition

Base: develop `aeb7fddb52a2956507d228000645b0efa3da6cf2` (PR #297).
Status: merged as PR #298 (`a1443c7`), reviewed head `d68f818` and tree `7424826`.
Normal hooks passed; pre-merge CI `36161742741` and post-merge CI `36162441704` passed 8/8.
Independent exact-head review returned CLEAN/SHIP.
Design: [C1b authority composition](../design/t5-journal-authority.md).

SessionAuthority now composes the existing journal facade with the existing control
ticket, pending-task set and dispatch helper. One phase-aware acknowledgment helper
owns retention, fresh-ACK checks, post-wait validation and static refusal diagnostics.
The application qualification is runtime-branded and bound to one exact journal
application scope. No registry, executor, package or installed dependency was added.

The initial selected tests failed before implementation: the baseline ignored the
descriptor, permitted publication and permitted legacy dispatch. The tests reuse the
existing memory-adapter conformance fixture and delay acknowledgments outside its
independent stored-state owner. They distinguish actual committed metadata from
callback execution and local dispatch status. An early test polling interval exceeded
the configured journal wait; replacing polling with explicit signals fixed fixture
timing without increasing production timeouts.

The first 37 integration cases and the complete 648-case control suite passed. They
cover both waits, delayed/lost acknowledgment, original-ticket drain, takeover, TTL,
same-ID replacement, sibling/nested effects, per-effect final guards, scope forgery,
reentrant guards, excluded browser/legacy dispatch, publication/refusal and unchanged
ephemeral behavior. Independent review requested four additional failing-first
hardening cases: ephemeral capture refusal, private thrown port diagnostics and
journal close during failure classification before/after an effect. All passed after
the owning boundary was hardened. The full workspace build and all 82 modular context
selections passed. The final focused suite has 46 passing cases, including valid
`existing`/`already_applied` ACK refusal, abandoned delayed-marker drain, and malformed
descriptor refusal before admission or I/O. Test synchronization uses the adapter's
explicit start/commit signals instead of wall-clock polling. Production-tree application acceptance
also passed without API or browser adapters/drivers. Independent review returned
CLEAN/SHIP. Normal hooks, exact-head review and both green CI runs are recorded
on PR #298; delivery identifiers appear above.

## Remaining gates at C1b delivery

The [C2/C3 packet](../design/t5-journal-application-terminal.md) now extends this
historical checkpoint with application guards and acknowledged terminal/replay.

At C1b delivery, ApplicationAuthority did not select the descriptor and journal-qualified
publication/duplicate replay refused. C2/C3 now extend those internal paths;
service/env/REST/SDK/CLI/MCP still have no new durability switch or capability. Separate
low-level control status remains ephemeral execution information, not a durable ACK
projection. The memory store cannot qualify filesystem or process-loss behavior.

C2/C3 now implement application-owned post-wait pins and terminal acknowledgment/replay
projection beside the existing record owner. Next: C4 shared runtime selection
qualification. Real storage and restart/recovery remain
J2–J4. T5 remains approximately 10%; finite milestone completion remains 3/9 (33%).
