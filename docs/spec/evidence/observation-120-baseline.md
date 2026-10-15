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
