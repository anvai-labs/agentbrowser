# Benchmarks (TD-025)

Run with `pnpm bench` (or `pnpm --filter @agentbrowser/benchmarks <bench|tasks|soak|all>`).
CI runs the full suite as a release gate on every push.

## What is measured

- **Latency benchmarks** evaluate the MVP spec targets (section 17.1)
  against the deterministic FakeEngine, which isolates the service's
  dispatch overhead - exactly what the "excluding site/network" targets
  describe. The same harness can measure a real engine by injecting one.
- **Agent task benchmark**: 50 deterministic tasks across ten spec
  categories (extraction, navigation, forms, staleness recovery,
  pagination, approval boundaries, diffs, secret redaction, typed errors,
  lifecycle). MVP gate: at least 45/50.
- **Churn soak**: repeated create/navigate/observe/act/close cycles with
  a cleanup audit (no surviving sessions or engine sessions, no crash
  entries, bounded RSS growth).

## Baseline (FakeEngine, 2026-08-25, Apple Silicon dev machine)

| Benchmark          | p50       | p95       | Target              |
| ------------------ | --------- | --------- | ------------------- |
| sessionCreateWarm  | < 1 ms    | < 1 ms    | 350 / 1,000 ms      |
| observation        | < 1 ms    | < 1 ms    | 150 / 500 ms        |
| actionDispatch     | < 1 ms    | < 1 ms    | 100 ms p50          |

(These measure service overhead only. Real-Chromium numbers are
site-dependent and are not part of the CI gate.)

- Agent tasks: **50/50** (gate >= 45); 125 actions, ~84 KB observations.
- Soak, 1000 cycles: 21 ms, RSS growth 13 MB, zero leaked sessions,
  zero leaked engine sessions, zero crash entries.

The task-success gate is the regression tripwire: an agent-visible API
change that drops the score below 45 fails CI.
