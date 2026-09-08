# Human Handoff: Working a Session With a Person in the Loop

**Status:** Shipped pattern (1.8.x)
**Related:** [ADR-007](adr/007-approval-tokens-side-effects.md) (approval tokens),
[ADR-013](adr/013-headed-sessions-and-walled-logins.md) (headed sessions / walled logins),
[TD-BROWSER-6](td/TD-BROWSER-6-headed-sessions-and-credential-handoff.md) (credential handoff),
[TD-BROWSER-10](td/TD-BROWSER-10-session-extension-loading.md) (extension loading / password-manager autofill),
[Synthetic input limitations](synthetic-input-limitations.md)

Some steps of a workflow cannot be automated: the password box, the MFA prompt, the
"approve this purchase" dialog, the turnstile. The designed answer is not to fake a
human — it is to hand the wheel to one, briefly and safely, and take it back. This doc
is the operating loop for that handoff and the rules that keep it from corrupting the
session.

## The loop

1. **Automate up to the wall.** Observe, fill, act. The agent does everything that does
   not require a human or a trusted input event.
2. **Stop at the approval gate or the credential step.**
   - High-risk actions refuse with `APPROVAL_REQUIRED` and a `tokenId`
     ([ADR-007](adr/007-approval-tokens-side-effects.md)). The token is single-use,
     short-lived (TTL), and bound to the exact action — the human approves out of band,
     the client retries with `approvalToken`.
   - Credential entry happens in the **headed window**: launch the session with
     `headless: false` ([ADR-013](adr/013-headed-sessions-and-walled-logins.md)) and let
     the person type. The agent must never read, store, or type a password.
     Headed windows launch the machine's real branded Chrome automatically
     ([ADR-016](adr/016-branded-chrome-first-headed-launches.md)) — extensions
     like password managers work there; `AGENTBROWSER_CHROME_PATH` still pins
     a specific binary (wrapper scripts included).
3. **The human works.** They may click, fill, navigate, open popups — none of it goes
   through the stack, so the stack does not see any of it.
4. **Re-observe before acting again. Non-negotiable.** Every human interaction can
   invalidate what the agent last saw. Element refs are revision-checked
   ([ADR-004](adr/004-stable-element-refs-revision-checking.md)): acting on a stale ref
   refuses with `STALE_TARGET` instead of firing blind. A fresh `observe` after the hand
   off is the only safe path back.
5. **Take it back and finish.** Export seeded cookies
   (`GET /v1/sessions/{id}/cookies`) if the flow should be reusable, then continue or
   close.

## The rules that bite

**Credentials never pass through the agent.** Not in prompts, not in `act` values, not
in logs. The human types them into the headed window, or the session is created with
seeded cookies from a login the human already did. This is a hard rule, not a
preference: it keeps secrets out of the control plane, the event ledger, and every
downstream copy of both.

**Re-observe after every human interaction.** The revision gate will catch most
mistakes, but "most" is not the contract — a human can return the page to a visually
identical state with different controls underneath. Observation is cheap; acting on a
guess is not.

**Raise the idle timeout before a long handoff.** While the human works in the headed
window, the session looks idle to the server. The default idle timeout (10 minutes)
will reap the session mid-handoff. Pass a larger `idleTimeoutMs` at session creation
(or keep activity flowing) whenever a person is going to be in the loop.

**The headed window is the session.** Closing the window ends the engine's
browser, the event stream ends, and the service reaps the session — there is
no detach/reattach. A replacement session is a fresh context: seeded cookies
are the only way it inherits a login, so export them
(`GET /v1/sessions/{id}/cookies`) *before* the human closes anything worth
keeping. A periodic `GET /v1/sessions/{id}` from the driving client doubles as
an idle keepalive during long human-only stretches.

**Password-manager autofill is possible without exposing secrets.** The human
unlocking their vault and autofilling inside the headed window is
credential entry that never touches the control plane — same trust shape as
typing. There is no request-level extension surface today
([TD-BROWSER-10](td/TD-BROWSER-10-session-extension-loading.md) documents the
`AGENTBROWSER_CHROME_PATH` wrapper workaround — rarely needed since
[ADR-016](adr/016-branded-chrome-first-headed-launches.md) detects branded
Chrome automatically — and the design questions a first-class surface must
answer).

**Popups are pages too.** SSO and payment flows open popup windows. Popups are
auto-adopted: they appear in `GET /v1/sessions/{id}/pages` with the `openerPageId` of
the window that opened them, and they are fully operable (observe/act) like any other
page. Follow the human across windows through the same page list. One exception:
popups opened with `rel="noopener"` (or `window.open(..., "noopener")`) have no
opener linkage, so adoption cannot attribute them — they never appear in the page
list and the agent cannot observe or operate them. If a handoff flow opens one, the
human completes it in that window; have them return to an observable page before the
agent resumes, and re-observe.

**Anticipate `isTrusted`.** After the human's part is done, the agent's remaining
clicks may still hit controls that reject synthetic events —
[synthetic input limitations](synthetic-input-limitations.md) covers which controls and
what works around them.

## What this is not

- It is not an approval *chat* flow: the MCP server has no interactive
  approval-request channel today. `APPROVAL_REQUIRED` surfaces as a tool error; the
  human approves out of band; the client retries with the token (see the MCP
  integration notes in [ADR-007](adr/007-approval-tokens-side-effects.md)).
- It is not a persistence mechanism: sessions are ephemeral by default
  ([ADR-005](adr/005-ephemeral-sessions-explicit-persistence.md)). If the handoff
  produced something worth keeping — an authenticated context — it must be exported
  (cookies) before the session closes.
- It is not stealth: a headed window driven partly by Playwright is still a CDP-driven
  window, and walls that fingerprint the CDP connection will still flag it
  ([ADR-013](adr/013-headed-sessions-and-walled-logins.md)). For those walls the
  prescribed route is a fully human login plus cookie seeding.
