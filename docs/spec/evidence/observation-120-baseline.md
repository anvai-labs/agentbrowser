# Observation overhead baseline (F1)

Status: **recorded 2026-10-15** on develop `origin/develop` at the time of PR, before probe
batching (F2). The benchmark is committed: `node packages/benchmarks/dist/run.js observe [n]`
(`runObservationOverheadBenchmark` in `packages/benchmarks/src/compare.ts`).

## Workload

`/observe120` on the benchmark fixture server: 40 labelled text inputs, 40 password inputs with
values set, 40 buttons (122 interactive elements observed, counting the form chrome). One warm-up
observe, then `n` sampled `interactive` observes through `AgentBrowserService` on the real
Playwright Chromium engine (headless). Every run also checks redaction: no password value may
appear anywhere in an observation (`secretLeaked` must be false; the runner fails otherwise).

## Baseline (10 samples per run, three runs)

| Run | mean ms | p50 ms | p95 ms | max ms | elements | secret leaked |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| 1 | 1388.4 | 1327.6 | 1635.4 | 1635.4 | 122 | no |
| 2 | 1374.7 | 1350.2 | 1625.0 | 1625.0 | 122 | no |
| 3 | 1417.0 | 1365.9 | 1741.8 | 1741.8 | 122 | no |

Host: AMD Ryzen 9 7950X (16 cores), Linux (WSL2), Node v24.21.0, headless Chromium from the
pinned Playwright. Absolute numbers are host-specific; F2 compares against a run on the same host.
The 1.15.2 record's earlier figure (~1.0 s mean on a different host and build) is not comparable.
