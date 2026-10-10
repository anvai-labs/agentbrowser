# AgentBrowser UI-automation gaps observed while configuring a GitHub App (2026-10-10)

Field evidence from a real consumer task: creating + configuring a GitHub App
(`agentbrowser-winget-publisher`) through github.com settings UI — cookie-seeded
headless session, CLI-only, released v1.16.0 build. Each gap below cites the
concrete failure from that session. This is the input list for the next
post-1.16 improvement packet (extends ADR-021 form-controls enrichment).

## G1 — Unnamed/uniquely-named custom controls need row context (highest value)

GitHub's permission editor renders ~40 repository permissions as Primer
`action-menu` triggers, EVERY one accessible-named exactly
`Access: No access` (122 page-wide across sections). Selecting "Contents" and
"Pull requests" required: raw-HTML artifact fetch → regex-mapping
`<strong>label</strong>` rows in document order → index-aligning to
formControls-minted refs → clicking by index → verifying state via the
visible "Selected" badge in another HTML fetch. An agent should not need HTML
forensics for a labeled row.

**Fix (additive):** when formControls mints a `role:"control"` element, attach
`context?: string` — the nearest enclosing row label (`<strong>`, `<label>`,
`<dt>`, or `aria-labelledby` target) plus optional section heading — so the
element reads `name: "Access: No access", context: "Contents — Repository
permissions"`. New optional `PageElement.context` (protocol + engine + testkit
passthrough); observe renders `context` in brackets; autofill label matching
MAY match context as a fallback. No existing name semantics change.

## G2 — `extract format:"forms"` missed all 122 custom controls

The forms extraction returned the native inputs but zero of the action-menus
that `observe --include formControls` mints. The two surfaces disagree.
**Fix:** forms extraction consumes the same enrichment path as formControls
(plus values), so both list the same controls.

## G3 — React/lazy surfaces never mount under headless observation

Two hard failures: (a) the app settings "Private keys" section never entered
the DOM — window scroll, targeted element scroll, keyboard PageDown/End all
failed to trigger its lazy mount (absent from a 1.1 MB HTML capture);
(b) the org Install-App form never hydrated (chrome + footer only, 46
elements, after direct URL + settle waits). GitHub's React settings shell
degrades specifically under the headless a11y environment.

**Fixes (disclosed, never silent):**
- `observe --reveal-lazy`: opt-in probe that scrolls the page (and each tall
  container) once, waits for DOM growth, then re-snapshots — reports what
  mounted. Not a default: it mutates scroll state.
- A `degradedReason: "hydration-pending"` signal when the DOM holds react
  roots/skeletons but the interactive count is implausibly low — the
  empty-snapshot heuristic generalized.

## G4 — Per-keystroke revision churn during multi-field form fill

Every `act fill` re-rendered GitHub's form and staled sibling refs; the task
needed an observe→fill loop per field. `autofill` exists for exactly this but
its matcher targets native inputs/selects. **Fix:** extend autofill's
label-matching to use G1 `context` and accept formControls-minted refs, so
labeled custom pages fill in one server-side batch with one revision bump.

## G5 — State verification round-trips

Confirming a menu change required a full-page HTML artifact + regex (the
"Selected" badge hunt). With G1 (names carry row context) + values surfaced
("Access: Read and write" already appears in the minted name), verification
collapses to one scoped observe. Guidance should also steer to
`--since-revision` diffs for post-mutation checks.

## G6 — Scroll ergonomics drift between surfaces

CLI `act scroll <dir> <amount>` is positional with no `--delta-y` (MCP schema
names deltaX/deltaY), and container-targeted scrolling did not move GitHub's
inner settings pane. **Fix:** align flag names across CLI/MCP; document +
support scroller-of-target semantics; include G3's reveal probe as the
reliable alternative.

## G7 — Credential downloads need the private-file handoff

The `.pem` key generation downloads a file; the guessed downloads API shape
was wrong and downloads to a shared folder are the wrong destination for
secrets. **Fix:** `download collect --output /private/path` following the
cookie-export discipline (exclusive create, 0600, receipt-only stdout).

## Priority

G1+G2 as one packet (engine formControls naming + forms-extract parity, with
tests + FakeEngine parity); G3 probe next; G4 rides G1; G6/G7 small polish.
Evidence transcript: this session's GitHub App configuration exercise
(sandesh-style consumer loop against github.com, 2026-10-10).
