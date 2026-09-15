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
## Date triplets and masked fields

Month/Day/Year triplets on such portals are often backed by scripts that
reformat on every input event. A plan that fills `Month` = `2`, `Day` = `30`
back-to-back can bleed: the day script fires while the month is still being
composed, and the auto-advance moves focus mid-keystroke. Fill one field per
plan step and verify:

```json
{ "action": "fill", "target": { "ref": "e4_12" }, "value": "2", "expectValue": "2" }
```

On Chromium, `expectValue` reads a native input/textarea after one fill.
A mismatch fails with `VALUE_MISMATCH`; it never refills automatically or echoes
expected/actual values. Success reports `result.verified: true`. Re-observe and
inspect application state before deciding on another write. This readback is
not proof of a durable save. Unqualified engines refuse the option before writing.
Fields that add their own separators ("02 / 30 / 2024") need the separator-tolerant
final value as `expectValue`, or verify via the form's own review screen instead.

## Honeypot fields

Anti-bot forms carry bait inputs labeled "leave this empty" or hidden text
fields ("for robots only"). Never fill a field merely because a form looks
incomplete — fill only refs whose observed label you can justify. A filled
honeypot is the strongest bot signal a portal has.

## Audit every autofill-parsed entry

Resume-upload autofill parses stylized documents badly: titles land in company
fields, section headings become employer names, entries duplicate or vanish.
After the parse, re-observe and audit **every** parsed row against the source
document; fix swapped fields by ref; delete garbage rows via their remove
buttons. A plain-text-styled resume variant parses far more reliably than a
formatted one.

## Back-navigation can discard sibling entries

In multi-entry subforms (work history blocks), navigating **back** past a step
can silently drop entries you already added, even ones that rendered in a
review screen moments earlier. Rule: after any back-navigation, re-observe and
count the entries you believe exist; re-add missing ones before continuing.
Prefer forward-only flows: complete a section, save forward, and never return.

## networkidle on long-polling portals

`until: "networkidle"` can time out on portals with persistent connections
(telemetry, websockets) that never go quiet. Prefer `until: "settled"` after
navigation, `selectorVisible` for a known element, or `minElements` for a list
you expect to render.

## Create-account ambiguity

Sign-up flows can fail silently (password policy, existing account) and
redirect to a login screen with only a generic "wrong email or password" —
which is also what an existing account produces. Disambiguate with the
password-reset email flow: if the reset confirmation arrives, the account
exists — complete the reset and sign in; if nothing arrives, retry creation
with a policy-compliant password.
