# TD-BROWSER-17: Nested-app (cross-origin iframe / shadow-root) content observability

**Status:** implemented (2026-11-09) — ask 1 (frame-qualified refs), ask 2
(degradation marker), ask 3 (fallback recipe) all landed; shadow-root
content folding and the placeholder-iframe case (a frame whose document
never receives content — no traversal can read it; the marker covers it)
remain known limitations (repro archived 2026-11-09)
**Source:** first production use of cross-machine operator attach
([ADR-034](../adr/034-cross-machine-operator-attach.md)) — driving the
Cloudflare Zero Trust dashboard.

## Repro

Target: `https://one.dash.cloudflare.com/{account}/networks/tunnels` (Zero
Trust console). CDP-attached operator Chrome, semantic observation and
`document.body.innerText` both return **sidebar navigation only** — the main
content pane is invisible. DOM inspection shows a single inline iframe
(`src` empty, `readyState: complete`) whose `body` is an empty
`<html><body></body></html>` while the pane visibly renders for the human.
The same class of nested-app surfaces: Cloudflare ZT, GCP console panes,
Azure Portal blades.

Likely mechanics: the pane is a portaled cross-origin (OOPIF) child frame or
shadow-root-subtree that top-document CDP evaluation cannot reach; the empty
inline iframe is a placeholder that never receives content in this state.

## Impact

- `observe`/`snapshot`/`act` degrade to sidebar-only: the agent sees the page
  shell and cannot read or drive the functional pane.
- Workaround today: `screenshot` + coordinate interaction (works, but loses
  semantic refs, scope accounting, and the snapshot staleness contract).

## Ask

1. **Recursive frame traversal**: attach to child frames as CDP targets
   (`Target.getTargets` / flatten-session) and fold OOPIF/shadow content into
   `observe`/`snapshot` with frame-qualified refs (e.g. `f2_e17_3`), so act
   can route a ref to the owning frame's session.
2. **Honest degradation marker**: when the top document carries a non-empty
   iframe set whose content is unobservable, `observe` should emit a
   `nested_content_unobservable` warning (today the empty-iframe placeholder
   reads as "nothing here", which sent the agent down a wrong path twice).
   **Landed** (ask 2, additive only — no refs minted, element lists
   unchanged). Detection (`packages/engine-playwright/src/nested-content.ts`)
   fires when either branch holds:
   - a child frame (OOPIF or same-origin) contributed zero observed elements
     while a bounded probe shows it holds real content (same
     `AGENTBROWSER_EMPTY_DOM_MIN_*` thresholds as
     `empty-snapshot-nonempty-dom`), or
   - every child frame is an empty placeholder **and** a large visible
     inline iframe slot (≥ 200×150 CSS px) renders where the pane should be
     **and** the top-level observation is sparse (≤
     `AGENTBROWSER_NESTED_UNOBSERVABLE_MAX_TOP_ELEMENTS`, default 20).
   Hidden/zero-size analytics frames and unknown (unprobed) frame documents
   never fire it; frames skipped for budget/depth/timeout, still-loading
   frames, and frames with a declared `src` still sitting at a provisional
   `about:blank` read as unknown too (adversarial-review hardening: a
   navigation in flight probes identically to the repro placeholder, and
   must stay silent). A zero-element top document stays the
   SPA-not-mounted diagnosis for BOTH branches — enforced in code, not
   just this note. Precedence: `aria-snapshot-timeout` >
   `nested_content_unobservable` > `empty-snapshot-nonempty-dom`. Note the
   semantic overlap with ask 1: once recursive traversal folds a frame's
   content, that frame contributes elements and the marker stops firing —
   the marker is the honest "we could not fold it" signal, not a frame
   detector.
3. **Documented fallback recipe** in `cli-agent-usage.md`: screenshot +
   `clickAt` on image coordinates, plus the `Runtime.evaluate` deep-walk
   helper pattern for same-origin iframes (the part that works today).

## Verification

- Re-run the Cloudflare ZT repro after implementation: `observe` must return
  the tunnel table rows as actionable refs; the warning fires on the
  unobservable variant.
- Regression guard: standard single-frame pages must produce byte-identical
  snapshots (no ref-namespace churn for `f1_`-prefixed top-document refs).
  Scope note (adversarial review): byte-identity is pinned for NO-iframe
  pages only. On pages WITH iframes, child-frame refs changed namespace
  from unprefixed to `f<index>_e<rev>_<n>`; held refs fail closed
  (TARGET_NOT_FOUND, remap-eligible), and the published
  `REF_PATTERN.source` grew the optional qualifier — consumers pinned to
  the pre-change pattern need updating. Detached-mid-observation frames
  degrade to the unprefixed namespace (disclosed in code; the binding
  still carries the owning frame).

## Implementation record

### Ask 1 — frame traversal + frame-qualified refs (landed 2026-11-09)

Recursive frame traversal itself predates this record (T6 slices 1/1b/2:
child-frame snapshots merged into `observe`, frame-scoped binding, frame
coverage blocks, egress pinning). What this change adds is the
**frame-qualified ref grammar** so a ref names its owning frame and every
surface can tell top-document content from embedded-application content:

- Grammar (ADR-004 extension, SSOT in `packages/protocol/src/types.ts`):
  `REF_PATTERN = /^(?:f\d+_)?e\d+_\d+$/`. A child-frame element mints
  `f<index>_e<revision>_<ordinal>`; the qualifier is the frame's index in the
  engine's frame list (`page.frames()`), where **0 is the main frame and is
  never prefixed** — top-document refs stay `e<revision>_<ordinal>`.
  `parseRef` returns `frame` only when the qualifier is present.
- Regression guard honored: single-frame pages observe to unprefixed,
  sequential, revision-stable refs — byte-identical to the pre-frame grammar
  (pinned in `frame-observation.test.ts`).
- Routing: `act`/`resolve` key the binding store by the full qualified ref;
  the binding already carries the owning frame, so a qualified ref dispatches
  into its frame with no core changes. Core's staleness gate (`parseRef`)
  reads the revision through the qualifier: a frame-qualified ref from an
  older revision reports `STALE_TARGET`, never `INVALID_REQUEST`.
- Surfaces: OpenAPI/MCP schemas embed the new pattern from the SSOT; the CLI,
  MCP and API ref validators accept qualified refs and their error messages
  name both forms.
- Staleness across frames is **conservative and unchanged in shape**: there
  is one page revision (no per-frame revisions). Frame content participates
  through the existing binding-identity change detection — a mutation inside
  any observed frame bumps the page revision and re-mints every ref
  (qualifier preserved), so a stale frame ref fails closed like any other.

Known limitation (same class as the original repro): Playwright's frame list
includes OOPIF frames and the cross-origin fixture is observed and acted
through, but the original Cloudflare ZT pane rendered into a placeholder
iframe whose document never receives content — no traversal can read a frame
that has no document. Ask 2's honest degradation marker covers that case.
Shadow-root content folding remains out of scope (coordinate fallback per
ask 3).
