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
| Accessible name | matches Chromium's own AX name (pinned): `aria-labelledby` targets, then `aria-label`, then rendered text (hidden, `aria-hidden`, script/style excluded; a nested `aria-label` replaces its text; img `alt`; `<br>` as a space; `::before`/`::after`), then `title`. An empty summary is still targetable with name `""` |
| Not minted | a summary with a **valid** explicit `role` (already in the snapshot under it; an empty or unknown role is minted, as Chromium still exposes it); a second `summary`; content of a closed `details`; a `details` with no `summary` (the default control lives in a shadow root); summaries in **closed** shadow roots |
| Interaction | `click` the ref, or `press` Enter / Space on it, toggles it; re-observe for the new state and refs |
| Protections | refs are revision-bound; an act also re-checks the parent `details` snapshot, so a disclosure **toggled by page script** since the observation is refused as `STALE_TARGET`; approval and redaction apply unchanged |
| Hostile pages | the scan runs in the page's JavaScript world, so its output is untrusted page data like any name. A page that breaks built-ins only degrades the scan: `observe` still succeeds and reports `disclosure scan failed` in its coverage |
| Limits | at most 200 rendered summaries per frame; more is reported as `disclosures capped at 200 of N`. Summary rows follow the snapshot's rows (no depth), so `scopeRef` on a container does not include them |
| Approval rules | a rule keyed on `role: "button"` does not match `html-summary`; key on `name` (and `hostname`) or on `role: "html-summary"` |
| With `include:["formControls"]` | an `aria-haspopup` summary (menu pattern) is minted once, as `control` with its row context |
| Pinned by | `packages/engine-playwright/src/disclosure-summary.test.ts` (real Chromium): name parity with Chromium, expanded state, click, keyboard, nested, unnamed, roles, frames, stale and script-toggled refs, hostile page, cap |

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
