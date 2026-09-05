# TD-BROWSER-8: Batched Page Snapshots, Action Plans, and Adaptive Modes

**Status:** Accepted — Phase 1 AND Phase 2 implemented (service plan executor +
snapshot + routes; `waitForLabel`, contract-honesty documentation, and the
payload-economics bounds below all shipped 2026-09-04)
**Context:** 2026-09-03
**Related:** [ADR-012](../adr/012-snapshot-plan-interaction-model.md)

## Problem

Measured on the dice.com drive (TD-BROWSER-6 verification): a 4-field login
plus navigation cost 6+ agent/LLM round-trips. Each `act` bumps the service
revision, invalidating every ref and forcing a full re-observe before the next
step. LLM reasoning happens once per element - O(fields) reasoning, O(fields)
payload, O(fields) wall clock. On churning SPAs (dice search) the strict
fingerprint gate rejected 5/5 immediate clicks: elements re-render faster than
the observe/act round-trip.

## Spec

### PageSnapshot (self-contained observation payload)

```json
{
  "url": "https://...",
  "title": "Login",
  "revision": 7,
  "mode": "stable",
  "fields": [
    {"ref": "e7_13", "role": "textbox", "label": "Email address"},
    {"ref": "e7_16", "role": "button", "label": "Sign in"}
  ]
}
```

`GET /v1/sessions/:sid/pages/:pid/snapshot` returns this in one call.

### Action plan (batch input)

```json
POST /v1/sessions/:sid/pages/:pid/plan
{"actions": [
  {"action": "fill", "target": {"ref": "e7_13"}, "value": "me@example.com"},
  {"action": "click", "target": {"ref": "e7_16"}}
]}
```

Executed server-side, sequentially, in one HTTP call. Response carries
per-step results (actionId/error), the failing step on abort, and the mode.

### Executor semantics

- **Stale tolerance**: a step failing STALE_TARGET re-observes once and
  retries with the same ordinal under the new revision prefix
  (`e{old}_{i}` -> `e{new}_{i}`) - deterministic on stable forms.
- **Target wait**: steps may declare `waitForLabel` (substring) +
  `waitMs`; the executor polls observations for the element to appear
  (dynamic pages: elements revealed by prior steps).
- **Abort semantics**: first hard failure stops the plan; the response
  reports every completed step so the caller knows the exact state.

### Adaptive modes (auto-toggled per page)

| Mode | Trigger | Behavior |
| --- | --- | --- |
| STABLE (default) | clean ref acts | deltas only; ordinal remap on the single allowed revision bump |
| VERIFIED | auto: churn score >= 3 stale failures on a page | ordinal remap additionally requires a role+label match against the pre-failure baseline before accepting it (never guesses) |

The score decays: a resolved stale-then-remap step decays its own bump
(Phase 2), so churn stays elevated only under genuinely sustained
instability, not as a one-way ratchet. Neither mode ever silently
substitutes a different element: a refused act is loud.

Doc correction (Phase 2): this row previously also claimed VERIFIED
mode inserts "observation before every step" and rides snapshots on
every response. Neither was ever built - VERIFIED changes only the
remap-matching strictness above. Proactive per-step re-observation under
churn remains a real, unclaimed idea for a future phase.

## Pressure-test matrix (acceptance - Phase 2 complete)

| Fixture | Requirement | Coverage |
| --- | --- | --- |
| Static 4/5-field form | plan of 5 steps in ONE call, all ok, 0 intermediate observations | `service.test.ts` |
| Click-revealed password field | plan with `waitForLabel: "Password"` succeeds | `service.test.ts` (FakeEngine) + `plan-real-chromium.test.ts` (real Chromium) |
| Re-rendering results list | executor either clicks or fails loudly per step; never mis-clicks; verified mode holds under sustained churn | `service.test.ts` |
| Payload economics | snapshot bytes/count bounded by `maxElements`/`maxBytes`; plan response carries per-step outcomes + `newRevision` as the final-state signal | `service.test.ts` + `server.test.ts` |

## Implementation record (Phase 1)

- `AgentBrowserService.executePlan(sessionId, pageId, steps)` with stale
  ordinal remap, per-step results, abort-on-first-hard-failure.
- `GET /v1/sessions/:sessionId/pages/:pageId/snapshot`,
  `POST /v1/sessions/:sessionId/pages/:pid/plan` routes; MCP `browser_plan`
  tool; SDK `SessionsClient.plan`.
- v1.7.1 additions: MCP `browser_snapshot` tool (the snapshot was
  service/route-only before — an MCP client had no way to reach it, breaking
  the snapshot→plan loop the TD is built around); `browser_plan` now declares
  `sessionId`/`pageId` as required schema fields (previously a call missing
  them proxied the literal string `"undefined"` to the REST API and failed
  there with a confusing 404); verified-mode remap now enforces the
  "never silently substitutes a different element" rule from the modes table
  above — a remap candidate must match the pre-failure element's role+label,
  else the plan aborts with `AMBIGUOUS_REMAP` instead of guessing.
- v1.7.1 review fixes on the above: the verified-mode baseline is looked up
  in the per-revision history by the failing ref's own revision prefix (the
  self-heal's re-observe replaces `lastObservation` mid-plan, which used to
  make every stale step after the first unremappable); the baseline is
  compared on its redacted form so labels embedding secrets still match
  their own element; a remap retry failure surfaces as the plan envelope
  rather than a thrown error; an empty candidate list (element gone) reports
  the honest `PLAN_STEP_FAILED` instead of a misleading `AMBIGUOUS_REMAP`;
  the snapshot payload shape is declared once as the SDK's `PageSnapshot`
  and reused by the MCP server.

## Implementation record (Phase 2, 2026-09-04)

- `waitForLabel` + `waitMs` on `ServiceActRequest`: a pre-step gate in
  `executePlan` polls raw engine observations (deliberately not the
  service's own `observe()`, which would consume a bounded history slot
  per tick and evict the mint-revision baseline verified-mode remap
  depends on) for an element whose name contains the substring, then
  resolves and fills in the step's target itself - a caller cannot know
  the ref of an element that doesn't exist yet when the plan is authored.
  A miss surfaces as a typed `PLAN_WAIT_TIMEOUT`, never a hang.
- Fixed a churn-decay asymmetry: a step that goes stale and then
  successfully remaps now decays its own churn bump, matching the
  primary (never-stale) success path. Previously only the primary path
  decayed, so a plan of several remapped-but-fine steps would ratchet
  churn upward forever and never cool back out of VERIFIED mode even
  once the page had genuinely stabilized.
- Payload economics: `getSnapshot`/the snapshot route accept
  `maxElements`/`maxBytes` (the Phase-1 `maxBytes` hardening never
  reached this route); `executePlan`'s response gains `newRevision` as
  the cheap final-state signal the acceptance table asked for.
- Contract honesty: `/plan` and `/snapshot` had been reachable since
  Phase 1 but were never in the OpenAPI document - invisible to any
  spec-generated client despite being this TD's headline features. Both
  are now fully documented, with `openapi.test.ts` enforcing
  operationId/summary/tag/path-param completeness. The CLI gains
  matching `snapshot` and `plan` commands (previously unreachable from
  the CLI at all).
- Pressure-test matrix: all four rows now have direct test coverage,
  including the first service-level test run against a real Chromium
  engine (not FakeEngine) for the click-revealed-field scenario.
