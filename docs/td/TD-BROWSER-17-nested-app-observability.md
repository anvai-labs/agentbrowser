# TD-BROWSER-17: Nested-app (cross-origin iframe / shadow-root) content observability

**Status:** open (repro archived 2026-11-09)
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
3. **Documented fallback recipe** in `cli-agent-usage.md`: screenshot +
   `clickAt` on image coordinates, plus the `Runtime.evaluate` deep-walk
   helper pattern for same-origin iframes (the part that works today).

## Verification

- Re-run the Cloudflare ZT repro after implementation: `observe` must return
  the tunnel table rows as actionable refs; the warning fires on the
  unobservable variant.
- Regression guard: standard single-frame pages must produce byte-identical
  snapshots (no ref-namespace churn for `f1_`-prefixed top-document refs).
