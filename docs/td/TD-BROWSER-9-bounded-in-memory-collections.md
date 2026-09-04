# TD-BROWSER-9: Bounded in-memory collections & eviction discipline

**Status:** Proposed
**Context:** 2026-08-31
**Related:** [ADR-005](../adr/005-ephemeral-sessions-explicit-persistence.md) (ephemeral sessions), [ADR-008](../adr/008-process-container-isolation.md) (isolation), `docs/hygiene-audit.md` Theme A

> Renumbered 2026-09-03 (v1.7.1 docs hygiene): landed as TD-BROWSER-8, but that
> number was independently taken by
> [TD-BROWSER-8: Batched Snapshots and Action Plans](TD-BROWSER-8-batched-snapshots-and-action-plans.md)
> (Accepted, Phase 1 implemented) before this one shipped. This doc — still
> Proposed, not yet implemented — takes the new number so the Accepted one
> keeps 8.

## Context

The service is single-node with in-memory state, and that is **on-vision** — the
MVP spec makes no HA claim and `docs/audit.md` explicitly rules the in-memory
stores on-vision, not debt. This TD does **not** revisit that decision.

What it addresses is narrower and orthogonal to HA: several in-memory collections
grow with **uptime and workload**, not with concurrent session count, and have no
eviction bound. On a long-running server (the intended deployment — one server,
many consumer processes, per TD-BROWSER-5) these accumulate until the process is
restarted. A few hot paths also select an O(n) structure where an indexed one is
a small, local change. None of these is a session-lifecycle leak (those were
`docs/audit.md` P0-2, closed); they are *data-structure* hygiene, verified by
reading each collection's write path for the absence of a cap.

The audit's soak test misses all of them because it exercises a bounded number of
sessions over a bounded run; these grow along axes the soak test holds constant
(distinct redacted strings, metric observations, spans, logged requests, distinct
hostnames, token count).

## The seven sites (all verified in code)

| ID | Collection | Growth axis | Current structure | Location |
|----|-----------|-------------|-------------------|----------|
| A1 | `redactionCache` | distinct strings ever redacted | `Map`, set-on-miss, no eviction | `core/secret-manager.ts:31,118-130` |
| A2 | metric `values[]` | total `observe()` calls | spread-**realloc** per sample (O(n²)) + full `sort` per `render()` | `core/metrics.ts:80-87,104-115` |
| A3 | span buffer | spans over cap | `Array` + `shift()` (O(n) evict) | `core/tracing.ts:93-95` |
| A4 | network `logs[]` | checked requests (when logging on) | `Array`, no cap | `policy/network-policy.ts:57,182-196` |
| A5 | egress `verdicts` | distinct hostnames per context | `Map`, no eviction | `engine-playwright/index.ts:193-210` |
| A6 | approval `getSessionTokens` | tokens (per-lookup scan) | O(n) `filter` over all tokens | `core/approval-gate.ts:211-224` |
| A7 | fingerprint element lookup | actions × elements | O(n) `find` per action | `core/action-executor.ts:241` |

A1–A5 are **unbounded growth**; A6–A7 are **wrong-structure-for-the-access-pattern**
(correct output, avoidable cost).

## Decision

Adopt one shared bounded-collection discipline rather than five bespoke fixes.

1. **Add a tiny `BoundedCache<K,V>` (LRU, fixed `maxEntries`) and a
   `RingBuffer<T>` (fixed capacity, O(1) push/evict) in `@agentbrowser/core`.**
   Both are ~30 lines, dependency-free, and unit-tested for eviction order. This
   is the single place the eviction policy is expressed.

2. **Apply them:**
   - **A1** `redactionCache` → `BoundedCache`, default `maxEntries` 10_000. Redaction
     stays a pure function; the cache is a bounded memo, so eviction only costs a
     recompute, never correctness.
   - **A2** metrics → keep a bounded reservoir/ring of recent samples **or** switch
     to incremental count/sum + a fixed-size quantile window; stop sorting the full
     history on every `render()`. Cap is per-metric.
   - **A3** spans → `RingBuffer<Span>(maxSpans)`, replacing `Array.shift()`.
   - **A4** network `logs` → `RingBuffer` with a `maxLogEntries` option (default
     10_000); logging stays opt-in.
   - **A5** egress `verdicts` → `BoundedCache` (default 1_000 hosts) **or**, if the
     context is documented as short-lived and single-session, an explicit comment
     stating the lifetime bound instead of a cache cap. Pick one; do not leave it
     implicit.

3. **Index the two hot lookups:**
   - **A6** maintain a `Map<sessionId, Set<tokenId>>` updated on token
     create/revoke/expire; `getSessionTokens` becomes an O(1) set read.
   - **A7** build a `Map<ref, element>` once per observation (at normalization
     time, where the elements are already being walked) and hand it to the
     executor, so per-action verification is O(1).

4. **Every bound is a named, overridable option with a documented default** — not
   a magic number buried in a method — so operators can tune for their workload
   and reviewers can see the ceiling.

## Consequences

- **Easier / safer:** process memory for these paths is bounded by configuration,
  not uptime; `render()`/eviction stop being super-linear; two per-request scans
  become constant-time. The eviction policy is auditable in one file.
- **Trade-offs:** A1/A5 caches can evict a still-useful entry under churn — a
  recompute/re-check, never a wrong answer. A2's bounded reservoir means quantiles
  are over a recent window, not all-time — the correct trade for a live metrics
  endpoint anyway. A6 adds bookkeeping on token mutation (must update the index on
  every create/revoke/expire — the one place a bug could reintroduce drift, so it
  needs a test).
- **Not addressed here (deliberately):** durable/persistent metrics or traces,
  cross-node aggregation, and the single-node model itself — all out of scope and
  on-vision.
- **Alternative — a metrics/trace library** (e.g. prom-client, OTel): heavier
  dependency than the MVP needs today and orthogonal to the eviction question;
  revisit if/when an exporter is required, not as part of this hygiene pass.

## Acceptance criteria

- [ ] `BoundedCache` and `RingBuffer` exist in core with eviction-order unit tests.
- [ ] A1–A5 collections have an enforced, configurable cap; a targeted test drives
      each past its cap and asserts size stays bounded (this is the test the soak
      test lacks).
- [ ] A3 and A4 no longer use `Array.shift()` for eviction.
- [ ] A6 lookup is O(1) via a maintained index, with a test that create/revoke/
      expire keep the index consistent with the primary token map.
- [ ] A7 verification consumes a per-observation ref index; no per-action linear
      `find` remains on the action hot path.
- [ ] Every cap is a named option with a documented default; none is a bare literal.

## Implementation Notes

- Land A1, A3, A4 first (pure structure swaps, lowest risk), then A6/A7 (indexing),
  then A2 (the only one that changes an externally observable number — quantile
  window semantics — so it warrants its own PR and a note in the metrics docs).
- Keep `BoundedCache`/`RingBuffer` in `core` (not `protocol`) — they are
  implementation utilities, not contract, and must not widen the protocol surface.
- Redaction (A1) must stay correct with a cold cache: verify the redaction unit
  tests pass with `maxEntries: 0` (cache disabled) to prove the cache is purely an
  optimization.
