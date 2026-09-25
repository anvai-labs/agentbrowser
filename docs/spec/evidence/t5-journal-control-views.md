# T5 C4a: shared acknowledged control views

Base: develop `e4b5e74` (PR #299).
Status: implemented internally; final hooks and protected delivery pending.
Design: [control views and selection seam](../design/t5-journal-control-views.md).

## Change

One private SessionControl projection helper now serves active control views and explicit
publication. Journal views omit the operation before intent ACK and retain acknowledged
marker facts until terminal ACK. busy/state/epoch remain live. Explicit lookup still
refuses before intent ACK; trusted live execution diagnostics remain available separately.
There is no wire schema, new map, executor, dependency, storage adapter or public selector.

## Verification

Four new core cases failed before the implementation: pre-intent disclosure and three
marker/terminal-classification cases. Initial authority regression checks also failed on
pre-intent disclosure and live completion during terminal ACK pending/timeout. Their early
assertion failures left held calls unreleased and produced secondary unhandled rejections;
those are not counted as separate defects. The corrected suite drains those calls cleanly.

After the fix, all 27 focused core cases and all 694 control cases passed. Two additional
authority takeover cases qualify pending intent and terminal ACK; they were added as
regression coverage, not separately claimed failing-first. Five older status expectations
were deliberately changed from live execution to ACK bounds; diagnostic assertions and
independent stored-state/effect checks remain. Snapshot isolation and ordinary ephemeral
views are covered. Tests reuse the existing controllable journal fixture.

Independent source/test review found no blockers and verified all outward status/lifecycle
paths converge on the core view, while duplicate replay/explicit lookup use publication.
Full core regression passed 394 cases. Production-tree application acceptance passed
without API/browser packages (the initial sandboxed registry DNS failure required an
authorized network retry). Documentation checks passed 935 relative links and all
11 modular-context tests. Final hook, exact-head review and protected CI evidence belongs
on the delivery PR.

## Remaining scope

C4b selection/transport qualification, J2 concrete Node/Bun storage/process-loss acceptance,
and J3/J4 recovery remain open. The design records their shared contract and ordering;
it does not advertise or enable them. T5 stays approximately 10%, finite tasks 3/9 complete.
No release, restart or Homebrew update is included in this internal checkpoint.
