# T5 C1a: per-call journal settlement

Base: develop `a06a31c745d81bc25500ff0b34e0c719f64ef1b2` (PR #296).
Status: merged in [PR #297](https://github.com/anvai-labs/agentbrowser/pull/297),
develop `aeb7fddb52a2956507d228000645b0efa3da6cf2`, preserving reviewed head
`d7e666255a4dd571e78ed3a19c6ca33d8b74ac26` and tree
`c89990126b8b7886e01603a036eb50c75de25167`. Normal hooks passed; pre-merge run
`36136596351` and post-merge run `36137604657` each passed 8/8. Not released.
Design: [journal composition](../design/t5-journal-contract.md).

The control-owned journal facade now exposes `JournalCall<T>.settled` on each of
its four data calls. Existing callers still await the bounded result. Future authority
composition can separately retain actual storage lifetime through the existing drain.
There is no new executor, task registry, package, dependency, public route, agent mode
or mandatory store. Native promises are decorated, not subclassed.

Seven initial regression cases failed because the original facade returned no
settlement signal; all 38 existing tests passed on that baseline. The new cases then
passed, covering all four methods, timeout with malformed late acknowledgment,
independent concurrent calls, pre-I/O refusals, cancellation and close. Additional
cases cover queued cancellation/capacity, immediate success and synchronous throw.
The review-requested timeout-abort race also passes when the adapter responds with
a valid result synchronously from its abort listener; observers see quarantine and
zero retained slots. The final facade suite has 49 passing cases and the unchanged
adapter conformance suite has 17.
Assertions inspect raw invocation counts, validation health and retained slot counts;
they do not treat elapsed caller waiting as storage completion. Late valid ACKs leave
quarantine intact; late malformed ACKs poison before settlement notification.

The signal resolves with no payload only after raw settlement, validation and slot
cleanup, or after a refusal that never invokes storage. Never-settling storage leaves
it pending. Ordinary `then`/async wrappers lose the extra property: future consumers
must capture the original call before awaiting it. Settlement alone neither proves
an acknowledged write nor authorizes execution.

Local checks: workspace build, control type-check and Biome pass. The complete control
suite passed all 611 cases through the final normal hooks.
The production-tree application acceptance passed without API/browser adapters or
drivers. All 26 package-acceptance unit tests, 907 relative documentation links and
82 modular context selections pass. Running `cli-outcome-acceptance.mjs` directly
only imports its exports and is not counted as live CLI qualification. No browser
or transport behavior changes in this internal slice. Independent review returned
CLEAN/SHIP on the exact committed head; delivery evidence is recorded above and in the PR.

This slice does not yet connect SessionAuthority, hold session tickets for journal
work, publish durable status or recover across restarts. Next: C1 intent/dispatch and
C2 application pins, including cancellation/takeover/replacement at every storage
wait; C3 terminal/replay and C4 qualification follow. J2 real storage/process-loss
qualification and J3/J4 recovery remain separate. T5 stays approximately 10%; the
finite milestone count stays 3/9 (33%).
