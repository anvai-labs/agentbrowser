# ADR-021: Form-Controls Enrichment for ARIA-Invisible Widgets

**Status:** Accepted (2026-09-15)
**Related:** [ADR-009](009-mcp-high-level-tools.md) (tool catalog),
[ADR-018](018-upload-action.md) (fileInputs enrichment precedent),
[ADR-012](012-snapshot-plan-interaction-model.md) (observation model)

## Context

The accessibility observation is the product's semantic surface, but it can only
report what the underlying snapshot emits: role-carrying elements. Application
portals built on div-based widget libraries render required controls (dropdown
triggers, tiled selectors) as styled `div`/`span` containers with click handlers
and **no role attribute**. Those controls are real, visible, and clickable - and
completely invisible to `browser_observe`, so agents cannot mint refs for them
and must fall back to manual workarounds mid-flow.

The existing precedent is `include:["fileInputs"]` (ADR-018): hidden file inputs
are equally invisible to the snapshot, and the fix was a token-gated enrichment
that mints refs and binds them through a scoped CSS locator. The same shape
applies here, with two differences: the candidate set is broader (several
selectors, potentially hundreds of matches on heavy pages), and the controls
have no per-element semantic snapshot to gate on.

## Decision

Deliver `include:["formControls"]`:

- One batched `evaluateAll` over a narrowed candidate selector (elements with
  `aria-haspopup`, `data-automation-id`, or inline click handlers, and no role
  attribute), deduplicated against the ARIA-bound set by position: candidates
  carry no role attribute, so anything the snapshot covers through an explicit
  role is excluded at the selector level.
- Minted elements take the fixed synthetic role `control` (one addition to the
  interactive-role list, stable for fingerprint and remap matching); the tag is
  preserved in `attributes`.
- Bindings use `.nth(unionIndex)` over the same candidate selector - the index
  is the element's position in the full match list, so it never renumbers.
- Evidence degrades to the whole-page document snapshot by design: div widgets
  re-render too often for per-element semantic snapshots to be stable, and the
  resolve gate already refuses unbound evidence with `STALE_TARGET` rather than
  acting on a changed page.
- A hard cap (200 per observation) guards against unbounded candidate sets.
- `tryRemap` re-observes with the tokens of the last observation, so a stale
  control ref can heal like any other.

## What this does not claim

- `control` is not a semantic role: the name is heuristic (aria-label, label
  text, visible text, automation attribute, id - in that order) and may be a
  placeholder such as "Select One". Identifying which control is which is the
  caller's job (click and observe the revealed options).
- A `control` ref observed is not a promise it can be acted on: invisible
  controls observe but act refuses with `TARGET_NOT_VISIBLE`, and the
  document-evidence gate refuses after DOM changes, same as every ref.
- Remap heals only within the same synthetic role and name: two identically
  named widgets refuse with a candidate count rather than guessing.

## Consequences

- Long-form flows on widget-library portals become automatable end to end
  without manual mid-flow intervention; the recipe documentation
  ([interactive forms](../recipes/interactive-forms.md)) is updated alongside.
- The candidate selector is intentionally bounded and narrowed; operators can
  audit it in the engine source. Adding new candidate shapes is an engine
  change, not a caller change.
