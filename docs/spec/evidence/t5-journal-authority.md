# T5 C1b: intent and dispatch acknowledgment composition

Base: develop `aeb7fddb52a2956507d228000645b0efa3da6cf2` (PR #297).
Status: internal implementation and independent adversarial review complete;
normal hooks and protected delivery pending.
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
CLEAN/SHIP. Normal hooks, exact-head review
and CI delivery are recorded with the final PR candidate.

## Remaining gates

This is internal composition, not runtime durability. ApplicationAuthority does not
select the descriptor; service/env/REST/SDK/CLI/MCP have no new switch or capability.
Journal-qualified run publication and duplicate replay refuse before C3. Separate
low-level control status remains ephemeral execution information, not a durable ACK
projection. The memory store cannot qualify filesystem or process-loss behavior.

Next: C2 application-owned post-wait authorization, consent and binding/input pins;
C3 terminal acknowledgment and replay projection beside the existing record owner;
C4 shared runtime selection qualification. Real storage and restart/recovery remain
J2–J4. T5 remains approximately 10%; finite milestone completion remains 3/9 (33%).
