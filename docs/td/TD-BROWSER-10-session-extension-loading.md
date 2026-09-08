# TD-BROWSER-10: Session Extension Loading (Password-Manager Autofill in Headed Sessions)

**Status:** Proposed — workaround documented, first-class surface undecided
**Context:** 2026-09-08
**Related:** [ADR-013](../adr/013-headed-sessions-and-walled-logins.md) (headed
sessions / walled logins),
[TD-BROWSER-6](TD-BROWSER-6-headed-sessions-and-credential-handoff.md)
(credential handoff), [Human handoff](../human-handoff.md)

## Context — observed in a real headed-login flow

A headed human-in-the-loop login (job-board testbed, 2026-09-08) expected the
operator's password-manager browser extension (SentinelPass: extension +
native-messaging host + local vault daemon) to autofill the credential step,
the way it does in the operator's own browser. It could not, for three
independent reasons — two are agentbrowser's, one belongs to the extension
vendor:

1. **No extension surface.** `SessionRequest` exposes `engine`, `headless`,
   `viewport`, `locale`, `timezoneId`, `cookies`, `policy`, timeouts — nothing
   that reaches `launch()` args or `--load-extension`. There is no supported
   way to load a browser extension into an agentbrowser session.
2. **Headed fallback never uses a branded binary here.** `headedChromiumOptions()`
   overrides `executablePath` only when `AGENTBROWSER_CHROME_PATH` exists; its
   default (`/opt/google/chrome/chrome`) is a Linux path, so on macOS every
   headed session runs the bundled Chromium. Even if a user configures the
   branded binary, the engine's arg set is fixed
   (`['--disable-blink-features=AutomationControlled']`) and cannot gain
   extension flags.
3. **Vendor-side breakage:** the native-messaging manifests
   (`com.passwordmanager.host.json`) referenced the host binary by *relative*
   name without deploying the binary next to the manifest, so
   `connectNative` fails even in the operator's own Chrome. (Filed upstream;
   not an agentbrowser defect.)

## Why this matters

The credential-handoff loop ([human-handoff](../human-handoff.md)) says the
human types the password into the headed window. That stays true — but
browser-side autofill is *still* the human's hand on the keyboard as far as
the control plane is concerned: the secret never transits agentbrowser, the
event ledger, or any client. A password manager in the headed window is a
usability win with zero control-plane exposure, and it is what the human
would do in a real browser.

## Current workaround (verified live, 2026-09-08)

`AGENTBROWSER_CHROME_PATH` accepts any executable, so a wrapper script gives
full launch-arg control without touching the product:

```bash
#!/bin/bash
# ~/Library/Application Support/<vendor>/ab-chrome-wrapper.sh
exec "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" "$@" \
  --load-extension="$HOME/Library/Application Support/<vendor>/chrome-extension" \
  --disable-extensions-except="$HOME/Library/Application Support/<vendor>/chrome-extension"
```

Start the server with `AGENTBROWSER_CHROME_PATH=<wrapper>`; headed sessions
then launch branded Chrome with the extension. Verified working end to end
(extension process flags confirmed via `ps`; note the wrapper also silently
fixes finding (2) for operators who want the branded binary).

Notes that cost time and belong in any first-class design:

- Unpacked extension IDs are path-derived **unless** the manifest carries a
  `key` — a `key`-pinned ID stays stable across any load path, which is what
  keeps the native-host `allowed_origins` allowlist valid.
- Native-messaging manifests are resolved per *binary branding* (bundled
  Chromium reads the `Chromium` dirs, branded Chrome reads the `Chrome`
  dirs), not per profile.
- Extensions do not load in the headless pool (headless shell); this is a
  headed-only feature by construction.

## Risks the first-class surface must answer

- **Egress gate bypass.** `installEgress` gates page and worker requests via
  Playwright routing. Requests made from an extension's own process context
  (service worker / native messaging) do not traverse the same routed path —
  an extension is a plausible egress path *around* the policy gate. First-class
  extension loading needs an explicit story here (deny by default, policy
  opt-in per tenant, or documented exclusion), not a silent gap.
- **Scope.** The env-var wrapper is server-wide: every headed session gets the
  extension. A request-level option (`extensions: string[]`) is per-session,
  but then any tenant could demand arbitrary code into a shared process —
  so it wants a server-start allowlist (e.g. `AGENTBROWSER_ALLOWED_EXTENSION_PATHS`)
  intersected with the request.
- **Evidence hygiene.** Extension-injected DOM must not corrupt observation
  evidence any more than any other page content does — no special handling
  expected, but the regression net (target-identity tests) should run with a
  loaded extension once.

## Alternatives considered

- **`launchArgs` passthrough** — strictly more powerful and strictly more
  dangerous (every `--load-extension` exploit class opens up); rejected in
  favor of a narrow `extensions` option if/when built.
- **CDP trusted input** (the F11 deferral,
  [synthetic-input-limitations](../synthetic-input-limitations.md)) — solves
  `isTrusted` rejection, not credential entry; orthogonal.
- **Status quo** — the wrapper works, is zero product risk, and is already
  documented here. First-class support is a convenience/hardening play, not a
  correctness one.

## Non-goals

- Shipping or bundling any extension.
- Headless-pool extension support.
- Weakening the egress posture to accommodate extensions.
