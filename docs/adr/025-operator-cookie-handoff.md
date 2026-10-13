# ADR-025: Operator Login Browser and Policy-Gated Cookie Handoff

**Status:** Proposed (2026-10-13)
**Related:** [ADR-005](005-ephemeral-sessions-explicit-persistence.md) (explicit persistence),
[ADR-006](006-network-egress-policy-ssrf.md) (egress policy),
[ADR-007](007-approval-tokens-side-effects.md) (approval tokens),
[ADR-013](013-headed-sessions-and-walled-logins.md) (walled logins),
[ADR-019](019-explicit-service-worker-opt-in.md) (service workers),
[ADR-020](020-inline-html-verification.md) (HTML is not secret-redacted),
[ADR-024](024-server-policy-engine-cedar.md) (policy engine),
[operator CDP attachment](../spec/design/operator-cdp-attach.md),
[CLI cookie-file handoff](../spec/design/cli-cookie-file-handoff.md),
[TD-BROWSER-16](../td/TD-BROWSER-16-operator-cookie-handoff.md) (implementation plan)

## Context

Agents often need sites the operator is signed in to. Today there are two ways to use a login, and
each gives something up:

1. **Operator CDP attachment** (`cdpAttach: true`) drives a Chrome the operator started with a
   remote-debugging port. Only the initial explicit navigation is checked; redirects, subresources,
   page scripts, WebSockets and downloads are not contained.
2. **Export, then seed** (TD-BROWSER-6) puts cookies into a contained session. But the values pass
   through the agent's context and transcript.

**A debugging port cannot be the source of a protected login.** A TCP port on `127.0.0.1` has no
per-user access control. Any local process, under any OS user, can connect to an unauthenticated
CDP port and read every cookie with `Storage.getCookies`. A local coding agent with a shell can do
exactly that. So no design that reads from an operator-started debugging port can keep cookies away
from such an agent.

## Decision

### 1. A login browser that AgentBrowser launches, with no port

The server gains an **operator login browser**:
- **It is headed Chrome on one persistent login profile.** The profile directory is owned by the
  server's OS user with mode `0700` (`AGENTBROWSER_LOGIN_PROFILE_DIR`, defaulting under the
  server's data directory).
- **It is launched and controlled over `--remote-debugging-pipe`,** a private pipe pair inherited
  from the server process (Playwright's persistent-context launch uses it). **No port is opened.**
- **Only the operator opens it.** The open and close operations are accepted only from the operator
  credential (§4). The operator signs in to sites in that window, once, and the logins persist in
  the profile across server restarts, except session cookies, which Chrome drops when it closes. This
  is explicit, operator-owned persistence (ADR-005).
- **It is not a session.** It has no session id, refs or pages exposed to any agent surface, and no
  agent operation can navigate, observe or act in it.
- **One pinned binary.** The login browser always launches the same `executablePath`, resolved
  once at enablement (ADR-016's branded-Chrome selection, or `AGENTBROWSER_CHROME_PATH`), and
  refuses if that binary's version has moved backwards. A profile is never opened by an older binary
  than the one that last wrote it. Chrome's downgrade handling can move a profile aside and lose the
  logins, and on Windows, App-Bound Encryption ties cookie decryption to one binary.
- **The handoff reads only while the login browser is open.** There is no headless read of a
  closed profile. That would mean a second binary or mode, a profile-lock race, and lost session
  cookies, which Chrome drops when it closes. Since the operator must be present to approve a
  handoff anyway, "open it" is part of that step. A closed browser returns `LOGIN_BROWSER_CLOSED`.
- **Lifecycle.**
  - Closing the last login window exits Chrome. The server notices the context closing and marks
    the browser closed; it never relaunches by itself.
  - A second `open` while one is running is a no-op.
  - A profile directory locked by a Chrome started by hand (Chrome's `ProcessSingleton`) is refused
    with `LOGIN_PROFILE_IN_USE`.
  - A stale `SingletonLock` after a crash is taken over by Chrome on the same host. The guide
    documents the manual recovery for a changed hostname.
- **Its own browsing is not contained.** The login browser is the operator's own browsing, like any
  browser: its egress does not go through the choke point.
- **Enablement:** `AGENTBROWSER_LOGIN_BROWSER=1`, plus the operator credential.
- **Floor conditions:** not a hosted deployment, a single authenticated tenant, and a display on
  the server host.

**The trade-off, chosen deliberately:** logins in a Chrome the operator started themselves are not
reused. The operator signs in again, once, in the login browser. In return, no port exists for
anyone to read.

### 2. What is guaranteed, and the threat boundary

**Guaranteed, within the boundary below:**
- The agent names domains. Cookie values never appear in AgentBrowser's cookie surfaces, requests,
  responses, logs, traces, errors or events.
- Cookie export, HTML export and download collection are refused for the destination session.
- Each transfer is approved with an operator credential the agent does not hold.

**The boundary.** The agent must be confined to AgentBrowser's tool surfaces (REST, SDK, CLI, MCP),
or else must not run as either of these OS users:
- **the server's OS user,** which owns the login profile directory and the server's environment;
- **the operator's OS user,** which holds the operator key.

An agent running as either one can read the profile's cookie store or the key directly. The guide
says this first.

**The supported layout is server and operator as the same OS user, with the agent as a different
one.** A headed window launched by another OS user cannot realistically appear on the operator's
macOS or Windows desktop. The agent's user must also have no access to the operator's display
(`DISPLAY`, `xhost`, X11 or Wayland sockets), because a process on that display can screenshot the
login window or inject input into it.

**On disk, the profile is protected only by file permissions.** Playwright launches Chrome with
`--password-store=basic` (Linux) and `--use-mock-keychain` (macOS), so the cookie database is
encrypted with a fixed, publicly known key, which is equivalent to plaintext. So:
- the profile is owner-only, as described in §1;
- the default directory is outside synced and backed-up paths, and the guide says to keep it there;
- using the OS keychain instead, by dropping those two switches with `ignoreDefaultArgs`, is a
  later option. It needs qualification in service contexts.

**Not guaranteed, and stated so:**
- **Account authority is the real asset.** A seeded session can do anything the account can do on
  the allowed hosts, such as minting an API token in the site's UI and reading it from the page.
  What bounds a hostile agent is:
  - the operator's decision to hand off;
  - the exact host allowlist (§3);
  - **operator review of actions** (§5), within whatever classification rules and lease the
    operator chose.

  None of these is automatic.
- **Redaction is exact-match and partial.** Screenshots and PDFs are pixels, console output carries
  whatever the page logs, and a page can reflect a value in encoded form.

### 3. The transfer

```
POST /v1/sessions/{sessionId}/cookies/handoff
{ "domains": ["github.com"], "approvalToken": "..." }
→ { "transferred": 7, "skipped": { "partitioned": 1, "expired": 0 }, "domains": ["github.com"] }
```

**Reading.** The server reads the open login browser's context through its pipe connection, with
Playwright `cookies()` and no URL filter, and then filters server-side. A URL-filtered
`cookies(urls)` read is never used: it drops host-only cookies on subdomains, and path-scoped
cookies.

**Domains and matching** use the Public Suffix List, private section included (a pinned `tldts`):
- **Registrable domains only.** Each requested domain must be a registrable domain, or a host under
  one. Public suffixes are refused (`com`, `co.uk`, `github.io`, `vercel.app`, `herokuapp.com`,
  `blogspot.com`).
- **Matching.** A cookie matches requested domain D when its domain (leading dot removed) equals D
  or lies under it, within D's registrable domain.
  - Requesting `github.com` matches `github.com`, `.github.com` and host-only `gist.github.com`.
  - Requesting `gist.github.com` does not pull in the parent `.github.com`.
- **Attributes are preserved exactly.** That covers `Secure`, `HttpOnly`, `SameSite`, path, expiry,
  and `__Host-` / `__Secure-` handling. Host-only `github.com` and `.github.com` are distinct
  cookies.
- **Skipped and counted:** partitioned cookies (`partitionKey` or `partitionKeyOpaque` present) and
  expired cookies.
- **Bounds:** 20 domains, 1000 cookies, and 1 MiB of name and value bytes, checked before any write.

**The destination's allowlist lies inside the handed-off sites.** Every entry of `policy.allowedHosts`,
`policy.scope.allowedHosts` and the per-request `allowedHosts` must be an **exact host** within the
requested domains: no `.suffix` entries, no other hosts. An allowlist such as `[".com"]` or
`["github.com", "attacker.example"]` is refused. `scope.pathRules[].hostSuffix` must lie within the
requested domains too.

**The destination must also be:**
- isolated, on an egress-enforcing engine;
- not delegated;
- free of service workers;
- on a deployment whose WebSocket policy is the default deny (an engine-wide setting);
- **fresh:** no committed navigation other than `about:blank` on any page or popup, and no cookies
  for the requested domains.

**One per-session lock** covers the sequence:
1. check the conditions;
2. check policy;
3. check approval;
4. read and recheck "fresh";
5. **mark** the session `credentialSource: "operator"`;
6. register the values, switch to reviewed actions, inject the WebRTC removal;
7. **write**.

The mark comes before the write, so no concurrent export ever sees the cookies unmarked.

**A marked session:**
- refuses cookie export, HTML export and download collection with
  `HANDOFF_COOKIES_NOT_EXPORTABLE`;
- shows `credentialSource` in the protocol session view (ADR-015);
- registers the values for redaction **per session**:
  - values under 8 characters or with negligible entropy are ignored;
  - the redaction cache is invalidated on registration;
  - nothing is redacted in other sessions;
- has `RTCPeerConnection` and `webkitRTCPeerConnection` removed in every frame by an init script.
  While the login browser is enabled, the shared Chromium also launches with
  `--force-webrtc-ip-handling-policy=disable_non_proxied_udp`.

**Residuals, documented:**
- **POST, PUT and PATCH redirect hops** are not re-checked (ADR-006).
- **Worker-opened WebSockets** are not covered by the page WebSocket deny.
- **WebRTC over TCP** from workers.
- **DNS prefetch** is not routed.
- **Connections are not DNS-pinned.**
- **GET navigations are not approval-gated,** and logout or confirmation links exist.

### 4. The operator credential

- **Keys.** `AGENTBROWSER_OPERATOR_KEYS_FILE` holds `key:tenant` entries, read from a file, never
  an inline variable.
  - Each tenant must equal the deployment's single API-key tenant. Ownership checks apply as for
    API keys.
  - A key in both sets aborts startup.
- **What the keys can do.** They authenticate as `actor: "human-operator"`, and **only** on routes
  flagged as operator routes:
  - deciding the new approval kinds;
  - opening and closing the login browser;
  - granting a lease (§5).

  They cannot create sessions or act, so configuring one in an agent is useless.
- **The CLI never takes the key from an environment variable.** An agent's shell, running as the
  operator's user, could read one from the environment, shell profile or `/proc`. The CLI's operator
  commands read the key from the OS keychain (macOS Keychain, Windows Credential Manager, Linux
  Secret Service) or from a no-echo prompt.
- **Without operator keys, the handoff and the login browser are disabled.** This is a condition of
  the operations, not of startup.

**Approval kinds and their decision path.** `ApprovalRequest` gains `kind`; existing act requests
are `kind: "act"`, unchanged.
- **`cookie.handoff`** is bound to `(kind, sessionId, sorted domains, policy version)`.
  - The first, unapproved call reads the profile for the Cedar-granted domains, and returns
    `APPROVAL_REQUIRED` with `{ kind, sessionId, domains, counts }`. Cookie names and values never
    appear.
  - That call counts toward the session's existing pending-approval quota, so it cannot be repeated
    without limit.
  - Counts are informational, not bound: sites rotate cookies constantly. Execution fails only if a
    requested domain went from some cookies to none.
- **`act.reviewed`** (§5) reuses the ADR-007 act binding: page, revision, target fingerprint,
  action and parameters.
- **A separate resolve-and-decide path.** Both new kinds are decided only by a `human-operator`
  principal, on their own path. The existing decision routes go through the delegated
  reviewed-approval context (`reviewContext`), which requires a delegated session. The view shows
  the kind, domains and counts, or the act description, and never cookie names.
- **Cedar:** action `cookie.handoff`, resource `Host`, one decision per domain. The ADR-024
  baseline grants it to no one. No policy can remove the approval step.

### 5. Actions in a marked session: fail closed, with the operator's lease

With no operator classification rules, almost every click, fill, type, press and select has an
`unknown` effect (`ActionRiskPolicy` classifies only `hover`, `scroll` and `wait` as `read`). So:

- **High-risk effects always need an `act.reviewed` decision,** whatever any rule or lease says.
  These are `transaction`, `external-message`, `account-security` and `destructive`. A per-rule
  `decision: "allow"` on such an effect is overridden.
- **`unknown` effects need an `act.reviewed` decision by default**, with `unknownRisk` forced to
  `required`. Two operator-only ways make sessions workable:
  - **Classification rules.** Per-host `approvalRules` that classify routine controls as `read` or
    `write-local` are honoured as they are today. The guide ships examples.
  - **A lease.** When deciding a handoff (or later, on the operator route), the operator may grant
    `{ hosts, expiresInMs ≤ 4 h, maxActions ≤ 500 }`. Its `hosts` must lie within the session's
    exact allowlist.
    - Within it, `unknown`-effect actions on those hosts run without review. High-risk effects
      never do.
    - The lease is recorded in the audit log, and the session view shows its remaining time and
      count.
    - **The agent cannot request, extend or widen a lease.** No agent-facing route accepts lease
      fields.
- **A stale `act.reviewed` token is refused like any stale act token.** It is bound to the
  revision, and a live page can move on while the operator decides, so the agent re-requests. The
  lease is the usability answer for busy pages.
- **Write paths outside `act`:**
  - **`autofill`** never calls the approval check. In a marked session it runs only within an
    active lease covering the page's host. Each field write counts as one leased `unknown` action.
    Without a lease it is refused.
  - **`application.execute`** is refused in a marked session.
  - Any future write path must declare its approval behaviour for marked sessions before it ships.

### 6. Agent surfaces

- **SDK:** `client.sessions.cookieHandoff()`.
- **CLI:** `agentbrowser session cookie-handoff <session> --domain <d>…`. Operator commands
  (`agentbrowser operator login-browser open|close`, `operator approve <token> [--lease …]`) read
  the operator key from the keychain or a prompt.
- **MCP:** a `cookie_handoff` tool with an optional `approvalToken`. The agent relays the
  `APPROVAL_REQUIRED` details to the operator and retries. The tool appears only in modes whose
  profile carries the new `session.credential` capability (`packages/protocol/src/mode-profile.ts`).
  There is no MCP tool for the login browser or for operator decisions.

## Consequences

- **The operator's logins work inside a contained session.** There is no readable debugging port,
  the host allowlist is exact, and each transfer and each unleased action is the operator's
  decision.
- **New surface:**
  - the login browser, which is engine work: the Playwright engine gains a pipe-connected
    persistent context, and today it has none;
  - an owner-only profile directory on Windows. This is a new
    `DirectorySecurity` with inheritance, created atomically; the CLI's single-file writer does
    not cover a directory tree;
  - `LOGIN_BROWSER_CLOSED` and `LOGIN_PROFILE_IN_USE`;
  - `AGENTBROWSER_LOGIN_BROWSER`, `AGENTBROWSER_LOGIN_PROFILE_DIR` and
    `AGENTBROWSER_OPERATOR_KEYS_FILE`;
  - the `human-operator` principal and its operator routes;
  - the `cookie.handoff` and `act.reviewed` approval kinds and the lease;
  - `credentialSource` and `HANDOFF_COOKIES_NOT_EXPORTABLE`;
  - the `session.credential` mode capability;
  - per-session secret registration;
  - the route, SDK method, CLI commands and MCP tool.
- **New dependency:** `tldts`, with a pinned Public Suffix List.
- **Depends on ADR-024** for the per-domain grant, and ships disabled until ADR-024's policy file
  exists.
- **A persistent login profile on disk** holds real credentials. It is owner-only, documented, and
  removable with `agentbrowser operator login-browser reset`.

## Alternatives considered

- **Read cookies from an operator-started debugging port.** Any local process can read that port.
  Rejected (see Context).
- **The same, plus a per-user firewall rule** (`nftables --uid-owner`, macOS pf `user`). It works on
  Linux and macOS but has no Windows equivalent, needs root setup, and fails open if the rule is
  missing. Rejected in favour of the pipe.
- **Export to the agent, then seed.** Values pass through the agent's transcript. Rejected.
- **Approval by any API key, or by caller confirmation.** The agent holds the key, or is the caller.
  Rejected for the separate operator credential.
- **Reviewing only high-risk effects.** Without operator rules nothing is classified high-risk, so
  the gate would be empty. Rejected for fail-closed `unknown` plus an operator lease.
- **An opt-out the agent can request.** The agent would ask for it. Rejected.
- **Reading Chrome's cookie database from disk.** It is locked while Chrome runs, and its format
  and encryption change between releases and platforms. Rejected; the server reads through the
  browser it controls.
- **Reading a closed profile headlessly.** That needs a second binary or mode, races the profile
  lock, and loses session cookies. Rejected; the login browser must be open.
- **Continuous sync or write-back.** Logouts and token refreshes would race in both directions.
  Rejected; this is a one-time copy.
