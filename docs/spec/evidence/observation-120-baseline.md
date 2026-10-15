# Observation overhead baseline (F1)

Status: **recorded 2026-10-15** on develop `origin/develop` at the time of PR, before probe
batching (F2). The benchmark is committed: `node packages/benchmarks/dist/run.js observe [n]`
(`runObservationOverheadBenchmark` in `packages/benchmarks/src/compare.ts`).

## Workload

`/observe120` on the benchmark fixture server: 40 labelled text inputs, 40 password inputs with
values set, 40 buttons (122 interactive elements observed: the 120 controls plus the `main`
landmark and the `h1`). Two unmeasured warm-up observes, then `n` sampled `interactive` observes
through `AgentBrowserService` on the real Playwright Chromium engine (headless). Every run also
checks redaction: all 40 password fields must be observed with `valueRedacted: true`, and no
password value may appear anywhere in an observation; the runner fails otherwise.

## Baseline (10 samples per run, three runs)

| Run | mean ms | p50 ms | p95 ms | max ms | elements | secret leaked |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| 1 | 1388.4 | 1327.6 | 1635.4 | 1635.4 | 122 | no |
| 2 | 1374.7 | 1350.2 | 1625.0 | 1625.0 | 122 | no |
| 3 | 1417.0 | 1365.9 | 1741.8 | 1741.8 | 122 | no |

Host: AMD Ryzen 9 7950X (16 cores), Linux (WSL2), Node v24.21.0, headless Chromium from the
pinned Playwright. Within a session the runs agree to a few percent, but **between sessions on the
same hardware they drift by about 18%**: an independent reviewer measured 1130–1231 ms means on an
identical host and toolchain. These numbers are therefore a snapshot, not a reference to compare
later runs against. **F2 must compare develop and its branch interleaved in one session** (A, B,
A, B on the same host), and report the gain only beyond that run-to-run spread. The 1.15.2
record's earlier figure (~1.0 s mean on a different host and build) is not comparable either.

## F2: bounded-concurrency binding (2026-10-15)

Profiling the observe path on this fixture showed the sequential per-element binding loop was
~90% of each observation (1.07–1.34 s of 1.2–1.5 s): per element, `count()` + `elementHandle()`
(~5.5 ms), the per-element aria snapshot (~3.7 ms) and the identity check, each an awaited round
trip. The parallel enrichment pass (visibility, enabled, sensitivity) was only ~130 ms. F2 binds
with bounded concurrency (8), resolves each node with one `elementHandles()` round trip, keeps
every element's steps in order and its ordinal resolved in document order, and settles every task
before cleanup.

Interleaved A/B in one session (A = develop's engine, B = F2; 10 samples each; same host):

| Pair | A mean ms | B mean ms | redacted passwords (A/B) | secret leaked (A/B) |
| --- | ---: | ---: | --- | --- |
| 1 | 1161.4 | 486.2 | 40 / 40 | no / no |
| 2 | 1180.1 | 497.9 | 40 / 40 | no / no |
| 3 | 1229.9 | 549.1 | 40 / 40 | no / no |

About 2.3× faster, far outside the ~18% between-session drift, with identical redaction.

**Review follow-up (same PR).**

*Other engines.* The independent review reproduced the Chromium gain at 2.2–2.7×. It measured
Firefox 6059 → 3332 ms (about 1.8×) and WebKit 1966 → 1719 ms (about 1.1×), with no regression on a
5-element page in any engine.

*A capture race the concurrency exposed.* Under concurrency, a node could be renamed between
`elementHandles()` and its aria capture, and that capture then waited out the whole 5 s envelope.
`application-parity` failed 12 of 15 times on two cores.

Each element's capture is now bounded to 500 ms (`ELEMENT_CAPTURE_SLICE_MS`). After the fix that
test passes 15 of 15, and `observe-capture-slice.test.ts` pins the bound: an element renamed every
millisecond. That test takes 5,030 ms without the slice and stays under 2.5 s with it.

