# T5 J1-B1/B2 journal contract evidence

Base: develop `5eae01dca6c83be75dea3f3a8aea154dd1b0eef7` (PR #284).
Status: implementation candidate; exact-head review, hooks and CI pending.
Design: [journal contract and integration gates](../design/t5-journal-contract.md).

This packet adds a storage-neutral validating facade, immutable metadata types and
adapter conformance tests in control. It does not connect a store to SessionAuthority,
service configuration or REST/SDK/CLI/MCP. No actual persistence, restart recovery or
public durable guarantee is delivered.

The first 18 facade tests failed against a refusal stub, then passed. They cover
keyed fingerprints, hostile input, wrong namespace/fence/identity/revision ACKs,
timeout/abort with retained raw I/O, late ACK quarantine and close ownership.
A separate failing-first key-binding test showed namespace metadata could not detect
different key material under the same key ID; the raw namespace now carries a
domain-separated HMAC verification value for atomic descriptor comparison.

Independent review found two lifecycle failures. A late successful open was discarded
without closing its exclusive handle, and a known fenced handle still allowed further
raw calls. Both failed in regression tests before repair. Additional tests exposed the
same cleanup leak when the late open returned malformed namespace or method metadata;
a captured close capability now releases that abandoned owner exactly once.

Additional cases cover saturation without raw calls, actual-I/O-before-close ordering,
immutable configuration/capability/input capture, queued cancellation, sanitized throws
and rejections, terminal-as-dispatch ACK refusal, mismatched evidence and lookup keys,
and admission space for maximal terminal growth. The conformance suite separately
observes stored transitions rather than treating facade output as proof of storage state.

The adapter suite exposed a separate acceptance/retention error: new-intent expiry
initially poisoned the entire handle and prevented accepted records from completing.
`admission_expired` now refuses new work while retaining accepted transitions until the
fixed retention horizon. Permanent ownership/retention loss still seals the handle.

Final review also required operation-aware acknowledgment reasons: admission expiry
returned for dispatch, terminal commit or lookup is malformed and now poisons the handle.
All three forged-response tests failed before repair. The conformance matrix independently
checks fingerprint-only conflict, exact reserves at later revisions, and before-write,
committed-with-lost-ACK and never-settling faults across all three mutations. A replacement
owner after fencing can observe retained terminal facts and verify an exact terminal retry
without repeating an effect.

Local validation: 38 facade tests, 17 reusable adapter conformance cases and the complete
control suite (600 tests) pass. Control type-check, test-support type-check, Biome,
826 documentation links and all 82 context selections pass. Full hooks, exact-head
review and CI delivery references remain pending.
Memory-model conformance cannot establish filesystem durability, process-loss behavior
or SQLite ownership. Those remain J2/J4. T5 remains approximately 10%; the finite
milestone count remains 3/9 (33%).
