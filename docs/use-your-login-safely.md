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
