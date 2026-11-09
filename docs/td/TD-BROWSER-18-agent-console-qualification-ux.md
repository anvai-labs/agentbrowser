# TD-BROWSER-18: Agent-Driven Console & Dashboard Qualification — Semantic-Layer Gaps

**Status:** Proposed — eight gaps recorded from two days of production dogfooding; each is small, none blocking
**Context:** 2026-11-07/08
**Related:** [ADR-034](../adr/034-cross-machine-operator-attach.md) (operator attach),
[ADR-013](../adr/013-headed-sessions-and-walled-logins.md) (headed sessions),
[TD-BROWSER-11](TD-BROWSER-11-session-initial-page-race.md) (races),
[TD-BROWSER-14](TD-BROWSER-14-compact-identifiers.md) (refs)

## Context — what we drove

A two-day identity-product dogfood drove, through agentbrowser: an OIDC issuer's
owner console (13 reviewed passkey-gated mutations), a React SPA qualification
suite (disposable preview, headless engine sessions), and a live Cloudflare zone
dashboard (creating a Configuration Rule through its custom React widgets). The
operator-attach path (SSH tunnel to the Mac service, CDP 9333) carried every
platform-authenticator ceremony. Everything below is an observed papercut, in
roughly the order it cost us time.

## The gaps

1. **`act select` on custom comboboxes reports an actionability timeout.**
   Cloudflare's settings rows and the issuer console's member selects are custom
   widgets; `selectOption` waits the full 30 s and fails with a generic timeout.
   We dropped to playwright-core for exactly these controls. Ask: detect
   "not a native `<select>`" up front and say so; better, implement combobox
   driving (open → list options → pick) under the same `act select`.

2. **Refs go stale after every mutation (STALE_TARGET) — an act→observe→act
   helper is missing.** Each fill bumps the revision, so the caller re-observes
   between every step. The `plan` command exists but requires refs up front.
   Ask: `act` option `--reobserve` (or a `plan` that re-resolves names between
   steps) so a five-field form is five calls, not ten.

3. **Observations don't expose widget state.** `observe`/`snapshot` name the
   switch but not `aria-checked`; we read state via `page.evaluate` in the
   engine. Ask: a `state` enrichment (`--include state`) covering checked,
   disabled, hidden, expanded for roles that carry them.

4. **Idle-expired sessions silently destroy session-scoped credentials.** A
   10-minute idle default expired mid-ceremony and orphaned a passkey bound to
   the dead context (recoverable only by an operator-side credential reset).
   `--mode bounty` (1 h idle) mitigates. Ask: on idle expiry, if the session
   created browser-profile-scoped state, log a loud warning; document the
   credential-binding consequence next to the TTL flags.

5. **API-key auth takes the key ID, not the secret.** `--api-key` wants the
   `api-…` identifier; passing the secret yields UNAUTHORIZED with no hint.
   Ask: accept either form, or say which one was expected.

6. **Unlabeled controls need geometric escape hatches.** Cloudflare's settings
   rows ("+ Add") have no accessible name; only engine-level bounding-box
   matching could reach them. Ask: a first-class locator — "the interactive
   element nearest text X" / "in the same visual row as text X".

7. **`--include attributes` is rejected** ("Expected union value") while the
   help lists it — help/docs drift between the CLI and the service schema.

8. **Service-spawned browsers cannot use platform authenticators (macOS).**
   Every WebAuthn ceremony died instantly (NotAllowedError) until we attached
   to the operator Chrome. Ask: a short callout in the service README and CLI
   help at `session create`: passkey ceremonies need ADR-034 operator attach,
   not spawned sessions.

## Non-goals

No new trust or policy surface here — every item is usability or diagnostics
for flows the API already supports.
