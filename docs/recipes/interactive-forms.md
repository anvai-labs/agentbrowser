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

## Interactive controls with no ARIA role

Some widget triggers are built as `div` or `span` containers with click
handlers and no ARIA role attribute. They are visible on screen and clickable,
but `browser_observe` never reports them. Pass
`include:["formControls"]` to mint refs for these controls; then click the
resulting ref and the options render as `role=option` elements you can select
from refs.

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

### Keyboard-only widgets

Some portals' dropdowns and multi-selects ignore clicks on rendered option rows —
the click toggles the menu open/closed but never commits, and `press` of `Enter`
on a highlighted row is the only thing that writes state. The working pattern:

1. Click the control to open the menu.
2. Walk with `ArrowDown` (or `ArrowUp`) until the target row is highlighted.
3. Press `Enter` to commit.

Two traps: the **highlight starts at the currently committed value**, not at the
first row — an empty control starts at "Select One", but a prefilled control
starts wherever its value sits, so a fixed number of downs from the top of the
list overshoots. And virtualized menus render only a window of rows; `ArrowDown`
loads more as it goes. Re-observe after opening and after long walks.

One `press` per action bumps the revision and invalidates the ref; use
`count` (Chromium engine; other engines refuse the option) to deliver the
whole walk segment — or the whole walk, if you know the offset — in a
single action:

```json
{"action": "click", "target": {"ref": "e30_41"}},
{"action": "press", "key": "ArrowDown", "target": {"ref": "e30_41"}, "count": 5},
{"action": "press", "key": "Enter"}
```

Multi-select chips ("N items selected") commit the same way. Removing a chip
that is already selected is the same keyboard contract — focus the chip, `Delete`.

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

A cheap commit probe for dropdowns: once committed, the trigger control's
accessible **name usually includes the chosen value** ("State Illinois Required"
vs "State Select One Required"). An uncommitted widget keeps its placeholder name
even when its menu render made it look selected — "Select One" in the name means
not committed, regardless of what the open menu displayed. This catches the
common failure where a click on an option row looked successful but wrote
nothing.

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

These spinbutton fields usually take **digits, not display text** — a month
field backed by `1`–`12` rejects `July` outright and normalizes `9` into its
display form. Phone-number fields similarly want raw digits and add their own
punctuation. Feed the numeric form and let the widget format it.

On Chromium, `expectValue` reads a native input/textarea after one fill.
A first read that disagrees is re-read once after a short settle, because late
async normalization (masking, formatting) can race the readback. A still-
mismatched value fails with `VALUE_MISMATCH`; the write is never replayed.
For non-sensitive fills the error details carry `expected` and `actual` — the
normalization the widget applied is visible without a separate HTML round trip.
Credential fills — passwords, security answers, anything you would not paste
into a log — should set `sensitive: true`; the flag keeps the value out of
mismatch details, and password inputs get that treatment even without it.
Success reports `result.verified: true`. This readback is not proof of a
durable save: a later full-block re-render (see the next section) can still
discard committed values. Unqualified engines refuse the option before writing.
Fields that add their own separators ("02 / 30 / 2024") need the separator-tolerant
final value as `expectValue`, or verify via the form's own review screen instead.

When a value lands wrong anyway (a bleed mid-correction), fix it with `fill`
and re-verify rather than arrow keys: targeted `press` sequences on spinbuttons
are fragile because focus placement on re-rendered widget clusters is unreliable,
and each individual press's revision bump invalidates the ref for the next one.

## Locale selectors reset dependent blocks

Country, region, or locale selectors frequently **re-render every dependent
block** on change: an address form re-rendered after the country changes comes
back empty, wiping street/city/postal fills that verified moments earlier.
Choose the country **first**, then fill the dependent fields, and re-verify the
whole block before saving. If a late selector change is unavoidable, treat every
dependent field as wiped and refill it — do not trust the pre-change verifications.

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
