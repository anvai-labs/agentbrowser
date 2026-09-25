# T5 C2/C3: application guards and terminal acknowledgment

Base: develop `a1443c7` (PR #298).
Status: implemented internally; final candidate hooks and protected delivery pending.
Design: [application and terminal composition](../design/t5-journal-application-terminal.md).

## Changes and ownership

ApplicationAuthority derives trusted journal selection from its captured application
binding. Intent precedes preparation/consent. Its existing final authorization,
consent and binding/input guard runs again through the shared dispatch helper after
marker acknowledgment. Consumption remains once-only. Default ephemeral behavior,
read operations and all transport configuration remain unchanged.

SessionControl stores one acknowledged projection alongside the existing operation
record. Identity conflict includes acknowledgment-required selection in both directions.
The same publication lookup serves duplicate replay and explicit status. There is no
new executor, record registry, package or runtime dependency.

SessionAuthority's phase-aware helper now composes terminal persistence too. It freezes
execution facts, persists bounded terminal metadata, and permits successful output only
after fresh terminal acknowledgment. Uncertain outcomes refuse optimistic output.
Storage settlement retains the existing ticket; late ACKs cannot upgrade publication.
Application replay runs fresh authorization through an output-only guard outside any
ambient execution scope and cannot borrow a nested caller's ticket or consume consent.

## Failing-first and regression evidence

Before implementation, seven new core projection tests failed on the absent projection
APIs and missing selection conflict. The core suite then passed 23 cases. Three initial
terminal tests failed on optimistic no-dispatch success, absent marker-backed terminal
failure and downgrade to ephemeral replay. A separate application selection test proved
that the old constructor ignored requested journaling and executed without a store.

Review-driven tests then proved and fixed optimistic output for an unresolved effect,
unauthorized direct application replay, and a nested replay guard borrowing ambient
execution authority. These were observed RED before their respective fixes. The wider
application matrix was added as integration regression proof after the selection fix;
it is not described as a wholly failing-first suite.

The latest full control run passed 692 cases, including the 46 prior authority cases,
terminal/replay and application qualification. Tests reuse one extracted ACK-delay shim
and the existing memory adapter's independent stored-state observations. Protected drift
cases inspect both actual non-dispatch and revision-3 marker-backed failed terminal facts.
They cover consent/auth revocation, binding changes, takeover, session replacement,
detached input, final guard order, once-only consumption and replay without re-execution.
Terminal tests cover every ACK phase, timeout, before-write/after-commit/never-settling
storage, late ACK drain, expiry/replacement, terminal classification and publisher failure.
Existing lookup-expiry tests now intercept the shared publication accessor and retain
their original refusal assertions.

Control type-check, targeted formatting, documentation links and modular-context tests
passed. Production-tree application acceptance passed without API/browser packages.
The first sandboxed production deployment hit registry DNS restrictions; the authorized
rerun passed. Independent source review is clean. Exact-head hook and CI evidence belongs
on the final PR; pending delivery is not recorded as complete here.

## Remaining gates

C4 service/transport selection qualification, J2 concrete storage and Node/Bun packaging/
process-loss qualification, and J3/J4 historical recovery remain open. Memory-backed tests
prove composition, not crash durability. No result payload, consent token or raw input is
stored. Terminal evidence references are empty in this slice. No public durability mode,
release or milestone-percentage increase is claimed. T5 remains approximately 10%; finite
roadmap completion remains 3/9 (33%).
