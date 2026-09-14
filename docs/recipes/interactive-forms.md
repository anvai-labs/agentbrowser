# Recipe: Driving interactive forms

Long multi-section forms (application wizards, surveys, admin consoles) mix plain
text inputs with design-system widgets — custom comboboxes, virtualized dropdown
menus, React-controlled checkboxes — whose behavior differs from native controls in
ways the semantic observation alone does not show. This recipe collects the
patterns that survive those differences. Everything here uses invented data (a
"Work area" combobox with options "Design" and "Research"); substitute your own
destination.

## One section per plan

`browser_plan` self-heals a stale ref by re-observing and matching the original
element **by role and label**. On a form whose sections repeat labels ("Company" /
"Title" appearing six times, or twenty identical "Toggle" buttons), that match is
ambiguous, and a plan that runs long tends to abort mid-way on an element that was
perfectly valid when the plan started.

The reliable shape is small plans on a fresh observation:

1. `browser_snapshot` (or `browser_observe`) the section you are about to fill.
2. One `browser_plan` covering only that section's fields.
3. Re-observe; repeat for the next section.

Use `waitForLabel` for a field that an earlier step in the same plan reveals (a
sub-form opened by a toggle, an option menu opened by a click) instead of guessing
its ref ahead of time.

## Custom combobox widgets

A design-system combobox is usually a text input plus a rendered listbox of
options. Three properties matter:

- **Opening.** The menu opens on a click of the control (or its toggle affordance),
  not reliably from a programmatic fill. `fill` sets the input's value and fires
  input events, but the menu may stay closed.
- **Async options.** After the menu opens or the filter text changes, the options
  render 0.5–2 s later. An observation taken immediately after the click races the
  render and reports no options. Wait first: a `wait` action with
  `{"until": "selectorVisible", "selector": "[role=option]"}` (or `minElements`),
  or simply re-observe after a beat. Inside a plan, `waitForLabel` does the
  waiting for you.
- **Committing.** A typed value is *search text*, not a selection: custom widgets
  routinely discard it on blur. The selection is what a click on a rendered option
  performs. The dependable plan shape is:

```json
{"action": "click",    "target": {"ref": "e12_30"}},
{"action": "fill",     "target": {"ref": "e12_30"}, "value": "Research"},
{"action": "click",    "waitForLabel": "Research", "waitMs": 8000}
```

Afterwards the chosen option renders as the control's visible value (a
"single-value" chip in most design systems).

## Stray open menus

Menu failures are sticky. If an option click fails or targets the wrong element,
the previous menu is usually still open, and the *next* click you aim at a
different control can land inside the stale listbox — option labels are generic
("Yes", "No", month names), so a misclick commits wrong data quietly. After any
failed or ambiguous menu interaction, click a neutral element (the page heading)
or re-observe and confirm which listbox is open before retrying. Never retry a
dropdown option by an old ref.

## Verifying what actually got selected

The accessibility observation reports the *control*, not its value: a selected
combobox chip looks the same as an empty one, and widgets that render their state
as an image (a flag icon, a glyph) carry no text to find. When you need ground
truth, read the DOM: `browser_html` returns the page's current HTML inline, and
the selected value appears in the widget's value container (and as the chip text).
Grep it for the value you intended to select; do not infer success from a
click's `success` status alone.

For native checkboxes, `browser_observe` reports `checked` on checkbox and radio
elements. Note that React-controlled checkboxes often serialize no `checked` HTML
attribute — the DOM attribute's absence is not evidence of an unchecked box, so
prefer the observation's `checked` field (or `browser_html`) over scraping
attributes.

## Session hygiene on long flows

Sessions are ephemeral by default: TTL **3.5 hours**, idle timeout **10 minutes**,
both overridable per session at create time (and both operator-tunable server-side).
A long form flow should set both explicitly (`ttlMs: 86400000`, `idleTimeoutMs:
3600000` are the protocol maxima). Pages that keep no server-side draft lose
everything at expiry — re-entry means re-filling every section — so set the budget
before starting, not after the first loss. See
[operations](../operations.md#configuration) for the operator-side defaults.
