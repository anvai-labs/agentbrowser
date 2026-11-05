# Use your login safely

TD-BROWSER-16 / ADR-025. The cookie handoff lets an agent work inside a session that carries your
login, without the agent ever seeing a cookie value. This guide is the operating manual and the
honest boundary of what it protects.

## The threat boundary, first

- **The agent must not run as the server's or the operator's OS user.** If it does, no protocol
  here helps: same-user processes read each other's memory and files. Run the server and the
  operator's terminal as one user, the agent as another, with no access to the operator's display.
- **On disk, the login profile is protected only by file permissions** (POSIX `0700`, Windows an
  owner-DACL). It must sit outside synced and backed-up paths — the default profile root is the OS
  private per-user state directory (`XDG_STATE_HOME` or `~/.local/state`, `LOCALAPPDATA` on
  Windows); override with `AGENTBROWSER_LOGIN_PROFILE_DIR` only to somewhere equally private.
- **Session cookies are dropped when the login browser closes.** Chromium keeps session cookies
  for a live profile only; closing the login browser ends them. Persistent cookies remain in the
  profile until you `operator login-browser reset`.

## The supported layout

```
one OS user:  the server (agentbrowser-server)  +  the operator's terminal
another user: the agent (SDK/CLI/MCP client)
```

The operator authenticates with a **human-operator key** from a file
(`AGENTBROWSER_OPERATOR_KEYS_FILE`, `key:tenant` lines, one tenant, requires API keys to be
configured) or a no-echo prompt in the CLI (`--operator-key-file`). The key is never an
environment variable. There is no OS-keychain integration yet — the file's permissions are the
protection.

## The loop

1. **The operator signs in.** `agentbrowser operator login-browser open` opens a headed Chromium
   on the operator's own persistent profile — no debugging port, your real browser walls, your
   real binary. Sign in as usual; the profile keeps the session.
2. **The agent asks.** The agent calls `cookie_handoff` (MCP), `client.sessions.cookieHandoff()`
   (SDK), or `session cookie-handoff <id> --domain example.com` (CLI) with **exact domains**.
   Floors refuse anything unsafe: the session must be isolated (not delegated), at `about:blank`,
   egress-enforced, service-worker-free, hold no cookies for the domains, and its **entire host
   allowlist must lie inside the requested domains** — `allowedHosts: [example.com]` is the rule;
   a broader allowlist refuses the handoff.
3. **You decide.** The first call returns an approval request (token id, domains, cookie counts —
   never values or names). Decide with `agentbrowser operator approve <session> <token>`, adding a
   lease if you choose: `--lease hosts=example.com minutes=30 actions=100`.
4. **The transfer.** On your approval the server re-reads the login browser, **marks** the
   session, registers every cookie value as a session secret, removes WebRTC peer connections
   from every frame, and writes the cookies in. The mark precedes the write, so a racing export
   is refused, never served unmarked cookies. Afterwards cookie, HTML and download export refuse
   (`HANDOFF_COOKIES_NOT_EXPORTABLE`).

## Working inside a marked session

A marked session (`credentialSource: "operator"` in its view) fails closed:

- **High-risk actions** (transactions, external messages, account-security, destructive) always
  need an `act.reviewed` decision — no rule or lease can allow them through.
- **Unknown-effect actions** need the same decision, **unless your lease covers the page's host**
  — within the lease they run, one count per action, until its expiry or count. `read`/
  `write-local` classification rules keep routine controls routine.
- **`autofill`** runs only inside a covering lease (each field write spends one count);
  **`application.execute`** is refused outright.

## What is guaranteed, and what is not

Guaranteed: the agent never receives a cookie value or name (counts only); exports refuse in a
marked session; the transfer is one operator decision per attempt, single-use, bound to the
session, domains and policy version; WebRTC cannot leak the local network from the marked
session; your marking cannot be forged by the agent.

Not guaranteed: the sites' own account authority (the agent can act as you *within* the domains
you granted — that is the point); a compromised server process (it holds everything by design);
the profile's on-disk secrecy beyond file permissions; zero-day browser escape.

## One-time copy

The handoff is a one-time copy into one session: no local storage of credentials anywhere, no
re-seeding from an export (exports refuse), and a second handoff for other domains needs its own
decision. Close the login browser when you are done; session cookies drop with it.

## Extracting a seed from your own Chrome (`seed-from-cdp`)

ADR-033 / P1-6c. When the flow you need is not the protected handoff but a plain seed file you
control, `agentbrowser seed-from-cdp` exports one from an **already-open** operator Chrome:

```bash
# open your Chrome with a debugging port, sign in, then:
agentbrowser seed-from-cdp --domain vinted.com --out ~/.config/agentbrowser/vinted-seed.json
agentbrowser seed-from-cdp --context incognito --browser-context 24AF --domain vinted.com --out seed.json
```

What it does — and refuses to do:

- Connects only to a **loopback** CDP port (`--port`, default 9222); the version probe is
  bounded and never follows a redirect.
- Selects the **default** context or one explicitly identified **incognito** context — several
  open incognito contexts require `--browser-context`; it attaches only to a tab whose host
  matches your domain filters, and reads **tab-context `Network.getCookies`** (browser-wide
  storage reads miss session cookies and are never used as a substitute).
- Never starts a browser, never reads the profile database, never touches
  passwords/localStorage/IndexedDB, and never widens past your domain filters.
- Writes a versioned `agentbrowser-cookie-seed/v1` file **created exclusively with mode 0600**
  (an existing path is refused), with provenance (source, context, context digest for incognito,
  extraction time, domain filters) and derived cookie classes. Bounded to 1 MiB / 1000 cookies;
  expired rows are omitted with a counted warning. Import it with
  `session create --cookies-file`.

The port is **not** a credential boundary — anything that can reach it can read that browser's
state, exactly as ADR-025 explains for the login browser. Fingerprint-bound cookies
(`cf_clearance`, `datadome`) may not transfer to another browser context: extract immediately
before use and verify authentication; cookie presence is not a challenge bypass.

## Reseeding a live session whose login went stale

If the seed goes stale mid-session, configure `authRotation` on the scope (P1-6a) and the scope
status will surface the reseed-needed hint when a refresh bounce is followed by an auth
rejection. The answer is a **live reseed** (ADR-033 / P1-6b) — the operator renews the cookies
without destroying the session:

```bash
agentbrowser session reseed SESSION --cookies-file ~/.config/agentbrowser/vinted-seed.json   --expected-revision 3
```

What the server does, in order: records the authorization durably in the engagement ledger
(expected revision, seed digest, domains) → refuses new browser input for the window → waits
(bounded, `--quiescence-timeout-ms`, default 5 s) until no request has an unsettled response —
a held long-poll refuses the reseed with nothing changed → invalidates pending approvals,
prepared operations and action leases **before** the write → registers the new values as
secrets and marks the session operator-credentialed (cookie export refuses from then on) →
clears and installs the jar as one engine-owned step → records completion and re-arms the
rotation advisory. Scope accounting (budget spent, pacing, expiry, exclusions, revision) is
preserved verbatim — renewal is never a fresh grant. A failed replacement stops the session's
traffic rather than replaying anything under old authority.

## When something goes wrong

### The login browser is slow to open

A server started by `launchd` — which is how `brew services` runs it — opens the login
browser **much** more slowly than the same server started from a shell. Measured on one
macOS machine, with a warm cache and an empty profile:

| | shell-started server | `launchd`-started |
|---|---|---|
| your branded Chrome | 1.1 s | 23 s |
| the bundled Chromium (`AGENTBROWSER_PREFER_BUNDLED=1`) | 3.6 s | 6.1 s |

A large profile adds more, because Chrome's startup work scales with the state it has to
load. The root cause of the `launchd` penalty is not yet established; what matters
operationally is that it is normal, and that it is bounded and visible rather than silent:

- Every open logs its elapsed time (`login browser opened in 1.2s`). Past 10 s it logs a
  warning instead. Under `brew services` these land in
  `$(brew --prefix)/var/log/agentbrowser-server.log`.
- The launch budget is `AGENTBROWSER_LOGIN_LAUNCH_TIMEOUT_MS` (default 120000, accepted
  range 5000–600000). Raise it if your logged open time approaches it. Playwright's own
  default of 30 s was the previous, unconfigurable behavior, and 23 s left too little room:
  exceeding the budget aborts the launch after Chrome has already drawn its window, which
  looks exactly like a window that opened and then stopped responding.
- If you would rather have the faster open than the branded binary, set
  `AGENTBROWSER_PREFER_BUNDLED=1`. The trade-off is real: a login wall is likelier to
  accept your own Chrome than a Chrome for Testing build, which is the whole reason the
  login browser prefers branded ([ADR-016](adr/016-branded-chrome-first-headed-launches.md),
  [ADR-025](adr/025-operator-cookie-handoff.md) §1).

### `LOGIN_PROFILE_IN_USE`, and recovering a changed hostname

Chrome guards a profile with its own `SingletonLock`, a symlink whose target is
`<hostname>-<pid>`. The server **reads** that lock and never deletes it: removing a live
owner's lock would put two Chromes on one cookie database and lose the logins.

- **Another Chrome really is open on this profile.** Close it, then open the login browser
  again.
- **A Chrome wedged or was killed.** Kill the process, then remove `SingletonLock`,
  `SingletonSocket` and `SingletonCookie` from the profile directory.
- **The lock names a different hostname.** Chrome only breaks a stale lock from the *same*
  host, so a laptop whose `.local` hostname changed with the network leaves a lock no
  Chrome will clear. The refusal names the recorded host and this host; remove those same
  three `Singleton*` files once you are sure no Chrome is using the profile.

The profile directory is `AGENTBROWSER_LOGIN_PROFILE_DIR`, defaulting under the OS per-user
state root (`~/.local/state/login-profile` on Linux and macOS, `%LOCALAPPDATA%` on Windows).

### `LOGIN_BINARY_CHANGED` / `LOGIN_BINARY_DOWNGRADED`

The profile records which browser binary last wrote it, and refuses to open with an older
one — Chrome's downgrade handling can move a profile aside and lose the logins, and on
Windows App-Bound Encryption ties cookie decryption to one binary.

Most changes are adopted automatically and need nothing from you: a Chrome that updated
itself in place, and the one-time switch from the bundled Chromium to your branded Chrome.
Both are logged. You see a refusal only when the new binary is genuinely **older** than the
one that wrote the profile, or when the binary at the same path changed while reporting the
same version — which is a replacement, not an update.

Recovery is `operator login-browser reset`, which **deletes the profile and every login in
it**. Before doing that, check whether the binary is simply the wrong one: if your branded
Chrome is older than the bundled Chromium that was in use before, pointing
`AGENTBROWSER_CHROME_PATH` at a current Chrome, or setting
`AGENTBROWSER_PREFER_BUNDLED=1`, keeps the profile intact.
