# Benchmarks (TD-025)

Run with `pnpm bench` (or `pnpm --filter @agentbrowser/benchmarks <bench|tasks|soak|all>`).
CI runs the full suite as a release gate on every push to `main`/`develop` and every pull request.

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

## Comparative benchmark (ADR-010 gate data)

`pnpm bench:real` compares engines on deterministic local fixture pages
(no external network): the latency trio plus a ref-driven agent loop
(navigate -> observe -> fill by ref -> verify) scored on exact success.
The benchmark service allows loopback for the fixture origin only;
private ranges and metadata stay blocked.

Baseline (2026-08-26, Apple Silicon dev machine, 50 iterations):

| Engine               | sessionCreate p50/p95 | observation p50/p95 | action p50/p95 | ref-loop        |
| -------------------- | --------------------- | ------------------- | -------------- | --------------- |
| playwright-chromium  | 3.3 / 8.6 ms          | 6.9 / 23.3 ms       | 0.7 / 1.9 ms   | 50/50, ~80 ms/loop |
| playwright-chromium (engine-level egress on, 2026-08-27) | 4.1 / 6.9 ms | 5.8 / 8.1 ms | 0.9 / 2.3 ms | 50/50, ~102 ms/loop |

Real Chromium sits comfortably inside every spec target (350/1000,
150/500, 100 ms p50) - including with the engine-level egress choke
point active (every request proxied and policy-vetted, redirects
per-hop), which costs roughly 20% on the full agent loop. Session
creation is context-only (no page), which is why it is far under budget;
observation cost is dominated by the aria snapshot. The ADR-010 decision
therefore has no latency-based pressure: any Rust-engine investment must
be justified on task success or cost per task, not on these dispatch
overheads. CI runs `bench:real` in the Benchmarks job; the gate is the
ref-loop success rate (deterministic), latencies are informational.

### Obscura row (spec §17.2 backend #3, informational)

`bench:real` adds an Obscura row when the pinned binary is present
(`node packages/engine-obscura/scripts/fetch.mjs`); CI's Benchmarks job
runs without the binary, so the row appears in local runs only and the
gate stays Chromium-only.

Obscura v0.2.1 (2026-08-29, Apple Silicon dev machine, 5 iterations;
the 30 s-per-observation cost makes deeper sampling impractical):

| Engine  | sessionCreate p50/p95 | observation p50/p95 | action p50/p95 | ref-loop |
| ------- | --------------------- | ------------------- | -------------- | -------- |
| obscura | 1.2 / 1.7 ms          | 30247 / 30866 ms    | 0.4 / 0.5 ms   | 0/5      |

The numbers are the honest §17.2 finding, and the root cause is a
single upstream gap, not service overhead: the service always installs
a request policy, and under Obscura's Fetch interception (a)
`ariaSnapshot` times out at Playwright's 30 s default every call - the
observation then falls back to a name-less scrape (hence 0/5: the loop
selects fields by name) - and (b) denials are not enforced at all. With
no interception, raw Obscura navigations load in ~10 ms and aria
snapshots take 30-50 ms. Full probe details and the gap list:
`docs/engines.md`. Verdict for ADR-010: **no task-success case for
Obscura v0.2.1 today**; re-evaluate when upstream fixes Fetch
interception (the CI truth guard will flag it).
