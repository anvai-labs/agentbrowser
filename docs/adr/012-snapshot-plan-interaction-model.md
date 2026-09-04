# ADR-012: Snapshot-Plan Interaction Model with Adaptive Modes

**Status:** Accepted
**Context:** 2026-09-03
**Related:** [ADR-009](009-mcp-high-level-tools.md), [TD-BROWSER-6](../td/TD-BROWSER-6-headed-sessions-and-credential-handoff.md), [TD-BROWSER-8](../td/TD-BROWSER-8-batched-snapshots-and-action-plans.md)

## Context

The observed dice.com flow (TD-BROWSER-6 verification) exposed the cost model
of per-element interaction: a 4-field login plus navigation cost 6+ agent/LLM
round-trips, because every `act` bumps the revision and invalidates every
element ref, forcing a re-observe before each next step. On an agent the
round-trip is LLM reasoning + HTTP + payload; N fields means 2N+ round-trips
where one decision should suffice.

## Decision

Replace per-element turns with **one self-contained page snapshot in, one
action plan out**:

1. **Snapshot** (`GET .../pages/:pid/snapshot`): a single self-contained
   payload - url, title, revision, and every interactive element as
   `{ref, role, label, value}`. One call gives an LLM the whole decision
   surface. No per-element exposure.
2. **Plan** (`POST .../pages/:pid/plan`): a list of actions executed
   server-side in one call. Per-step results return together with the final
   state. The LLM reasons once; the browser executes; one response.
3. **Adaptive modes, auto-toggled per page**: the service scores churn per
   page (stale-ref failures vs clean ref acts). Stable pages run SNAPPY
   (deltas, optimistic ordinal-remapped refs, no full re-observe). Volatile
   pages (churn score crosses threshold) auto-toggle VERIFIED: an observation
   is inserted before every subsequent step and a fresh snapshot rides the
   response. The toggle decays back when steps run clean. No human picks the
   mode; the page's observed behavior does.
4. **Dynamic pages**: plan steps may declare `waitForLabel` (bounded poll for
   an element to appear after a prior step, e.g. a password field revealed by
   "continue"). Elements that appear from interactions are bound by the next
   snapshot - never assumed.

## Consequences

- Form-size latency becomes O(1) agent round-trips instead of O(fields).
- Stale-ref strictness stays for single acts; inside plans the executor
  remaps refs by ordinal across one revision bump (deterministic on stable
  forms) and fails loudly when remapping cannot be proven.
- The strict-fingerprint limitation on continuously re-rendering pages
  (dice search) remains an engine-level gap, tracked separately; the plan
  executor's bounded re-observation is the service-level mitigation.
