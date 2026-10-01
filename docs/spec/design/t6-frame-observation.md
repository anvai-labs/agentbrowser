# T6 continuation: child-frame observation and ref binding

Status: design candidate, not implemented. Addresses the OVH Manager embedded
form handoff (docs/consumer-ovh-iframe-observation-2026-09-30.md): the
snapshot of a real embedded-application page exposed only the navigation shell
and an unnamed `[iframe]`; the primary content, form controls, and modal were
invisible, and acting on the iframe ref failed with the generic bind-safety
STALE_TARGET. No live OVH account is needed for any of this work — the
fixtures below are deterministic and local.

## Why this is foundation work, not a feature

Semantic observation and stable refs are the differentiator (ADR-003/004; the
published comparison's capability table). An entire class of real
applications — embedded managers, checkout widgets, payment frames — renders
their primary content in child frames. Until observation traverses them, the
differentiator is conditional, and every later task that assumes "observed =
complete" (T4 parity, T6 live gates, T7 evidence) inherits the hole.

## Ground truth in the current engine

- `observe()` captures ONE whole-body snapshot: `page.locator('body')`
  ariaSnapshot. Playwright renders child frames as bare `[iframe]` nodes
  without descending into their documents.
- The supplemental scans (`describeFileInputs`, `describeFormControls`) are
  likewise main-frame.
- Refs bind to exact DOM nodes (`binding.handle` ElementHandle +
  `isSameNode` identity re-check in `resolve()`). ElementHandles are
  frame-owned: `handle.evaluate` runs in the owning frame's context.
- **The main implementation item**: the binding-construction loop builds
  every stored locator via `this.page.getByRole(...)`/`this.page.locator(...)`
  — main-frame only. A frame-content element merged into the observed list
  would mint a handle but `locator.count()` to 0 on the stored locator and
  reproduce the exact no-binding STALE_TARGET. Frame-scoping must extend
  to the stored locator (frame-owned locator construction), not just the
  minted handle.
- The consumer's exact error — `STALE_TARGET: Observed target could not be
  bound safely; observe again.` — is the no-binding branch of `resolve()`.
  The `[iframe]` node was observed but is not bindable, and nothing
  distinguishes that from genuine staleness.
- Frame-navigation invalidation is LAZY: `onFrameNavigated` disposes only
  main-frame form-identity state and the revision counter is not tied to
  frame navigation. Stale child-frame refs die at `resolve()` time
  (detached handles, zero-count locators) — functionally satisfying the
  no-retargeting criterion, but implementers must not assume the revision
  machinery fires on frame navigation.

## Design

### 1. Frame traversal in observe (bounded)

After the main-frame snapshot, iterate `page.frames()` (child frames only)
in document order:

- Capture each frame's own ariaSnapshot (its body) and merge the parsed
  elements into the unified list, document order across frames. Refs stay
  deterministic per revision.
- Bounds: traversal depth ≤ 3 (nested iframes), total merged elements
  respect the caller's `maxElements` budget (frames compete for the same
  budget, main frame first), and frame capture draws from the remaining
  `SnapshotBudget` envelope with a reserved per-frame minimum slice so one
  slow main frame cannot starve frame capture entirely (starvation of
  frames is the accepted alternative on envelope exhaustion; the coverage
  block says which frames were truncated). An unbounded per-frame budget
  is explicitly rejected.
- Frame identity for the coverage block: URL origin + frame name where
  meaningful; srcdoc/about:blank frames fall back to name-then-ordinal
  identity.
- Each minted ref records its owning frame in the binding. `resolve()`
  needs no structural change — handle evaluation already runs in the
  owning context — but bindings now carry frame identity for diagnostics.
- Child-frame navigation and interaction inherit every existing context-wide
  control: the egress router and policy are context-scoped, so frame loads
  cannot bypass allowed-origin boundaries (gated by a test, not an
  assertion).

### 2. Coverage is surfaced, never implied

Any frame that cannot be inspected — snapshot timeout, detached mid-flight,
depth or budget truncation — produces a bounded `coverage` block on the
observation: frame URL origin + name (name/ordinal fallback for
srcdoc/about:blank), status (`timeout` | `unavailable` | `depth_exceeded` |
`budget_exceeded`), and a reason from the existing bounded vocabulary. A
stable shell with uninspectable frames must not look like complete task
coverage. This is the handoff's "surface explicit incomplete coverage and a
bounded reason". Touchpoints for the additive field: the engine's
`RawPageState`, the protocol's observation schema (optional-field precedent
— `degradedReason` — no version bump), the core observation normalizer
(which copies named fields explicitly), and the API projection.

### 3. Iframe nodes stop masquerading as actuable refs

The bare `[iframe]` node is excluded from bindable interactive refs and is
represented as a frame marker carrying the traversal outcome (its coverage
entry). Acting on a frame marker is a typed refusal — `frame_content`
diagnostic with the coverage reason — never the generic bind-safety
STALE_TARGET. This resolves the handoff's "distinguish an unbindable
observed element from a genuinely detached/stale target": detached targets
keep STALE_TARGET; unbindable/non-actuable observations get their own
diagnostic class.

### 4. Consistency across surfaces

Snapshot, observe (interactive/accessibility/content, including
`fileInputs` and `formControls` scans — frame-extended), extract, act,
plan, and autofill operate on the merged element list, so refs into frames
work everywhere without per-surface special cases. Duplicate labels across
frames disambiguate by ref (each frame's elements are distinct refs);
per-step verification and uncertain-mutation semantics are unchanged —
they ride the existing binding identity checks, now in-frame.

## TDD gates

Deterministic fixtures only (a local multi-frame page: same-origin iframe,
cross-origin iframe on a second localhost port, nested iframe, srcdoc
frame, a modal inside a frame, duplicate labels across frames — no
accounts, no external hosts):

1. Red: observe on the fixture omits same-origin frame content (the R4-style
   truth guard for this gap); then the merged list includes the frame's
   controls with bindable refs, bounded depth/budget honored.
2. Red: acting on the `[iframe]` node yields the generic bind-safety
   STALE_TARGET; then it yields the `frame_content` diagnostic with the
   coverage reason, and coverage lists an uninspectable frame with a bounded
   reason.
3. Red: a ref into frame A retargeted after frame replacement must not bind
   to a same-labelled control in frame B (frame-identity binding); STALE
   semantics preserved on frame navigation/detachment.
4. Frames cannot bypass egress: a child frame navigating to a policy-denied
   URL is blocked exactly like top-level (routing is context-scoped).
5. Per-step verification through frame refs: type into the frame's input,
   toggle an exact checkbox via ref, uncertain-mutation semantics intact.
6. Budget measurement: merged observation latency and element counts vs a
   top-level-only baseline, recorded as evidence per T9.

## Non-goals

No new execution capability inside frames; no cross-origin DOM piercing
beyond what Playwright's in-process frame handles already provide; no
change to ref format or the frozen observation schema beyond the additive
coverage block; no automatic retry of frame capture.

## Sequencing

Design review (this packet), then three slices: (1) traversal + merge +
binding with gates 1-2; (2) frame-identity/egress/verification gates;
(3) budgets + evidence. Slice 1 unblocks the consumer workaround gap;
slices land per T9 evidence discipline.

## Delivery status

- **Slice 1 DELIVERED 2026-09-30** (traversal + merge + frame-scoped
  binding): observe() walks child frames (depth ≤ 3, shared snapshot
  envelope, main frame first), merges their elements into one
  deterministic ref list, and binds through the owning frame's locator
  with per-frame (role, name) ordinals — duplicate labels across frames
  bind and act independently. Pinned on real Chromium: same-origin,
  cross-origin, srcdoc, and nested (depth 2) frames observe and act.
  Not yet in this slice, queued next: the coverage block and its
  protocol/normalizer touchpoints, the iframe-marker `frame_content`
  diagnostic, fileInputs/formControls frame-extended scans, the egress
  gate for frame navigation, per-frame snapshot-slice reservation, and
  the budget/latency measurement.
