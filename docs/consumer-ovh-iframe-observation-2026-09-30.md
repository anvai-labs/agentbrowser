# OVH Manager embedded form observation gap — 2026-09-30

Status: reproduced in AgentBrowser CLI 1.14.0, headed Chromium on macOS.
Root cause not fully isolated. This is a browser automation handoff, not an
OVH permissions diagnosis. No product fix is included in this report.

## Reproduction and observed behavior

1. In an authenticated OVH US Manager session, navigate to
   `https://manager.us.ovhcloud.com/#/public-cloud/pci/projects/<project-id>/users/onboarding`.
2. Run `snapshot SESSION PAGE --max-elements 180`.
3. Capture a screenshot and compare the visible content with the snapshot.

The screenshot shows the complete Users & Roles onboarding page, including
"You have not created any OpenStack users yet", a Create User button, and
three tutorial cards. The snapshot reports a stable page but exposes only
the navigation shell and an unnamed `[iframe]`; the primary content and
Create User control are missing. Increasing the element budget did not
recover the embedded content. The same symptom appeared on Object Storage
onboarding in this session.

Clicking the observed iframe ref failed with:
`STALE_TARGET: Observed target could not be bound safely; observe again.`
This does not establish that the document changed. The engine also uses that
error for an observed element without a binding. Repeated observation cannot
be assumed to solve a missing-frame traversal capability.

After reaching the form by keyboard, the snapshot at `/users/onboarding/new`
still omitted the visible modal, its User description input, Next button,
role checkboxes and Validate button. No reusable semantic refs were available
for these controls. Screenshot inspection confirmed that the native keyboard
actions reached the intended controls.

## Verified temporary workaround

Use `act press`, `act type-text`, and screenshots to inspect keyboard focus
and resulting form state. This is slower and less robust than semantic refs.

In this particular page state, Shift+Tab from the initial document reached the
last tutorial link. Six more reverse tabs reached Create User; Enter opened
Add user. Tab reached User description, `type-text` entered the description,
and two tabs reached Next. Enter opened Edit roles. From Validate, five reverse
tabs reached ObjectStore operator; Space selected it. A screenshot confirmed
that ObjectStore operator alone was checked, with Administrator and all other
roles unchecked.

These tab counts are observations, not a portable recipe. Verify focus and
selected roles before any submission, and reconcile the user inventory after
an ambiguous result. Do not retry creation based only on an action receipt.

## Engineering investigation and acceptance criteria

- Investigate `packages/engine-playwright/src/index.ts`, particularly `observe`
  (whole-body `ariaSnapshot`), supplemental form discovery, ref binding and
  `resolve`. Current source inspection shows observation beginning at the
  main page body; this is a lead, not a proven complete root cause.
- Add deterministic fixtures for same-origin, cross-origin, nested and
  about:blank/srcdoc frames, including a modal and duplicate labels across
  frames. No live OVH account or credentials should be needed for tests.
- Bind each child ref to the exact frame/document identity. Frame navigation,
  replacement and detachment must invalidate stale refs without retargeting
  to another frame or a same-labelled top-level control.
- Apply existing authority/egress restrictions to child-frame navigation and
  interaction. Frame traversal must not bypass allowed-origin boundaries.
- Cover snapshot, observe (including formControls/fileInputs), extract and
  act/plan/autofill consistently. Bound traversal depth, total element count
  and observation time; avoid an unbounded budget per frame.
- If a visible frame cannot be inspected, surface explicit incomplete coverage
  and a bounded reason. A stable shell must not imply complete task coverage.
- Distinguish an unbindable observed element from a genuinely detached/stale
  target in diagnostics and consumer guidance.
- Verify semantic user-description entry and exact checkbox selection through
  refs in fixtures, including per-step verification and uncertain mutations.
- Measure latency and element budgets against a top-level-only baseline.

## Evidence handling

The live screenshots and raw browser artifacts remain temporary operator-local
evidence; they are not committed because they contain account/project details.
Do not attach cookies, session URLs, credentials, API Console generated curl
commands, or raw form-control dumps to a public issue. The API Console can place
bearer credentials in non-password textareas, so ordinary password-field
redaction alone is insufficient.

Related: [consumer Google navigation handoff](consumer-google-account-navigation-2026-09-29.md).
