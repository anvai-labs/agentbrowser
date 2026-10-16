# Observation gotchas

Where what `observe` reports differs from the browser's own accessibility tree, how AgentBrowser
handles it, and how to target the control. This page is also the evidence base for the engine
review ([ADR-010](adr/010-rust-engine-gated-by-benchmarks.md)): each row records whether the gap
comes from the browser or from the observation layer.

```
 page DOM ──▶ browser accessibility tree ──▶ Playwright ariaSnapshot ──▶ AgentBrowser observe
              (Chromium: correct roles)       (computes roles itself)     (+ DOM enrichment scans)
                                                   ▲ most gaps start here
```

## Catalog

| # | Markup | Browser AX tree | Playwright snapshot | `observe` today | Status |
| --- | --- | --- | --- | --- | --- |
| G-01 | `<details><summary>Label</summary>…</details>` | `DisclosureTriangle "Label"`, focusable, `expanded` | no node: the text folds into the parent `group` | role **`html-summary`**, name `Label`, `expanded`; a bindable ref | **fixed** (next release) |

## G-01 · native disclosures (`details` / `summary`)

| Question | Answer |
| --- | --- |
| Symptom | `observe` showed `{role:"group", value:"Label"}`, so no control could be targeted by name |
| Cause | HTML-AAM gives `summary` **no ARIA role** (computed role `html-summary`); Playwright's snapshot computes ARIA roles and drops it |
| Regression? | No. The behaviour is the same on Playwright 1.62.1 (AgentBrowser ≤ 1.17.0) and 1.64.0 (1.17.1–1.19.0) |
| Fix | the first `summary` of each `details` is minted as role `html-summary`, never forced to `button`, with its accessible name and `expanded` from `details.open` |
| Accessible name | `aria-labelledby`, then `aria-label`, then the subtree text (image `alt` included, `aria-hidden` excluded); an empty summary is still targetable with name `""` |
| Not minted | a summary with an explicit `role` (already in the snapshot under that role); a second `summary`; content of a closed `details` (not rendered); a `details` with no `summary` (the browser's default "Details" control is in a shadow root) |
| Interaction | `click` the ref, or `press` Enter / Space on it, toggles it; re-observe for the new state and refs |
| Protections | the usual ones: refs are revision-bound (an older ref is refused), action approval and redaction apply unchanged |
| Pinned by | `packages/engine-playwright/src/disclosure-summary.test.ts` (real Chromium): name, expanded state, click, keyboard, nested, unnamed, explicit-role, frames, stale refs |

```sh
agentbrowser --json observe <session> <page> | jq '.elements[] | select(.role=="html-summary")'
agentbrowser act click <session> <page> <ref>     # expand or collapse
```

## Adding a gotcha

| Step | What to record |
| --- | --- |
| 1 | Minimal markup and the `observe` output |
| 2 | The browser's own AX node (Chromium: `Accessibility.getFullAXTree` over CDP) |
| 3 | Which layer drops or changes it (browser, Playwright snapshot, or AgentBrowser) |
| 4 | Releases checked, so it is not called a regression without evidence |
| 5 | The supported targeting mechanism, and the test that pins it |
