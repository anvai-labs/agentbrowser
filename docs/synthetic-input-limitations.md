# Synthetic Input Limitations: What `isTrusted: false` Costs and What Works

**Status:** Shipped pattern (1.8.x); trusted-input path deliberately deferred
**Related:** [ADR-013](adr/013-headed-sessions-and-walled-logins.md) (walled logins),
[Human handoff](human-handoff.md) (the in-loop alternative)

## The limitation

Every input event AgentBrowser delivers — clicks, keys, fills — is a *synthetic* event
dispatched through Playwright. The browser marks such events `isTrusted: false`, and
`isTrusted` is read-only: page JavaScript cannot be blamed for this, and no launch
flag, user agent, or fingerprint scrub changes it. Any page that checks the flag can
silently ignore the input while *appearing* to accept it — a no-op submit is
indistinguishable from a successful one until you observe the result.

This is not an edge case. It is load-bearing web security: payment confirmations,
enterprise SSO, bot walls, and a long tail of form handlers test `isTrusted` (or a
vendor SDK that does) precisely to tell a person from a script.

Observed live during the 1.8.5 smoke: multi-step application flows where every
synthetic interaction worked until the final submit control, which no-opped on
synthetic click but accepted a real Enter keypress, and flow steps whose handlers
rejected synthetic clicks outright.

## What works today, in order of preference

1. **Navigate to the link's `href` instead of clicking the link.** Observations carry
   link `href`s; for plain navigation, `navigate` to the captured URL is deterministic
   and immune to click handlers entirely. This is the first thing to try whenever the
   target is an `<a>`.
2. **Click the real submit control rather than pressing Enter.** Form handlers that
   check `isTrusted` on *keyboard* events are rarer than ones checking clicks — and a
   submit control's handler is the one the page's authors most often wired to accept
   genuine interaction of either kind. Prefer `act click` on the button; use the
   `press` action with `key: "Enter"` on the field's ref as the fallback, not the
   default.
3. **Observe the outcome; never assume.** A synthetic action that was silently
   swallowed still returns `success` — the event *was* dispatched. The only truth is
   the next observation: new URL, new elements, revision bump. Where an action is
   critical, use `observe: 'after'` and check for the expected effect before
   proceeding.
4. **Attach files through `upload`, never by clicking the picker.** File
   attachment needs no synthetic click on a file input at all:
   [ADR-018](adr/018-upload-action.md) sets the file list through the browser's own
   machinery (the target ref is optional — hidden file inputs usually have no ref).
   The result reports the attached files as evidence; verify the page accepted them
   by observation, same rule as everything else.
5. **Hand the step to a human.** When the control refuses synthetic input
   categorically (payment confirmations, MFA, turnstile-class walls), that step is not
   an automation problem — it is a
   [human handoff](human-handoff.md).

## Why the trusted-input path is deferred

A CDP `Input.dispatchMouseEvent` / `Input.insertText` path *does* produce trusted
events — they enter through the browser's input pipeline, the same as a physical
device. It is technically available in Chromium and could be built. It is deferred on
purpose:

- **It breaks the engine-neutral contract.** CDP input is Chromium-only. Safari
  ([ADR-011](adr/011-safari-via-safaridriver-webdriver.md)) and any future engine
  would need an equivalent, and WebDriver's `Perform Actions` produces untrusted
  events there. The workaround surface (below) is engine-neutral; a trusted-input
  engine path is not.
- **It is a stealth feature wearing a utility costume.** Trusted synthetic input is
  exactly what bot farms pay for. Shipping it — even gated — puts AgentBrowser on the
  wrong side of the walls [ADR-013](adr/013-headed-sessions-and-walled-logins.md)
  declines to fight, and invites an arms race the project has explicitly opted out of.
- **It interacts badly with the egress/routing stack.** A raw CDP session attached
  alongside Playwright's sits outside the route/permission plumbing and would need its
  own threat-model pass (input injection *is* code execution on the page).
- **The demand is mostly served already.** The failure modes the 1.8.5 smoke actually
   hit were resolved by href navigation, submit-control clicking, and one human step —
   not by a need for universally trusted events.

Revisit when: a real workload is blocked by an `isTrusted` check that no workaround
satisfies *and* the workload cannot tolerate a human step. The design would start from
a per-session opt-in (`trustedInput: true`), a Chromium-only capability flag, and an
explicit policy surface — not a silent fallback.

## The one-line summary

Synthetic input is honest input: it says so in every event, the page can check, and
some will refuse. Route around it with real URLs and real controls, verify outcomes by
observation, and hand the irreducible human steps to a human.
