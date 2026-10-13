# ADR-025: Policy-Gated Cookie Handoff from the Operator's Browser

**Status:** Proposed (2026-10-13)
**Related:** [ADR-005](005-ephemeral-sessions-explicit-persistence.md) (explicit persistence),
[ADR-006](006-network-egress-policy-ssrf.md) (egress policy),
[ADR-007](007-approval-tokens-side-effects.md) (approval tokens),
[ADR-013](013-headed-sessions-and-walled-logins.md) (walled logins, cookie seeding over CDP
races), [ADR-024](024-server-policy-engine-cedar.md) (policy engine),
[operator CDP attachment](../spec/design/operator-cdp-attach.md),
[CLI cookie-file handoff](../spec/design/cli-cookie-file-handoff.md),
[TD-BROWSER-16](../td/TD-BROWSER-16-operator-cookie-handoff.md) (implementation plan)

## Context

Agents often need a site the operator is already signed in to. Today there are two ways to use
that login, and each gives something up:

1. **Operator CDP attachment** (`cdpAttach: true`) drives the operator's real Chrome profile, so
   the login is simply there. But the profile is outside network containment: only the initial
   explicit navigation URL is checked. Redirects, subresources, page scripts, WebSockets and
   downloads are not contained, and an authenticated profile can exfiltrate data through any of
   them (operator-cdp-attach.md, "Network semantics").
2. **Cookie export and seeding** puts selected cookies into an isolated, fully contained session.
   This is the TD-BROWSER-6 loop: `GET /v1/sessions/{id}/cookies`, then `cookies` on create, or the
   CLI's `--cookies-file`. But the cookies come out of the browser through whoever runs the
   export. For an agent, that means **the cookie values pass through the agent's context**, where
   they can be logged, echoed into a transcript, or exfiltrated by a prompt-injected page. Export
   from an attached profile is refused outright (`PROFILE_COOKIE_EXPORT_UNSUPPORTED`), because
   profile cookies are shared credentials.

What's missing is a governed path that combines the two: **the operator's existing login inside a
contained session, with no cookie value ever reaching the agent.**

## Decision

### 1. A server-internal transfer: the agent names domains, never sees values

A new operation copies cookies from the operator's attached browser into an **isolated** session
that already exists:

```
POST /v1/sessions/{sessionId}/cookies/handoff
{ "domains": ["github.com"], "approvalToken": "..." }
→ { "transferred": 7, "skipped": { "partitioned": 1, "expired": 0 }, "domains": ["github.com"] }
```

- The server connects to the startup-configured CDP endpoint (`AGENTBROWSER_CDP_ENDPOINT`).
  - It **reads** cookies from the attached default context, filtered to the requested domains.
  - It writes them into the destination session's own context.
- **Cookie values never appear in the request, the response, logs, traces, errors or events.**
  - The response carries counts per reason only.
  - Values are registered with the session's `SecretManager` the moment they are read, so if a page
    echoes one, observations and logs redact it like any other registered secret.
- **Nothing in the operator's browser is touched:**
  - no page is opened, no tab is adopted;
  - no cookie is modified;
  - the connection is closed once the read completes;
  - no state flows back.

The same operation is exposed as SDK `client.sessions.cookieHandoff()`, CLI `agentbrowser session
cookie-handoff <session> --domain github.com`, and an MCP tool, `cookie_handoff`.

### 2. The destination must be contained, and scoped to those domains

The handoff is refused unless all of the following hold for the destination session:

- **It is isolated.** It is not `cdpAttach` and not a remote-CDP pool context. Its egress goes
  through the choke point under its policy.
- **It is restricted to the handed-off sites.** The session's `policy.allowedHosts` must exist, and
  every requested domain must fall within it.
  - Cookies are only ever sent to their own domains, but a page on that domain can read
    non-`HttpOnly` cookies from script and send them anywhere its egress allows.
  - An explicit allowlist bounds where a page could carry them.
- **It has not navigated yet,** so the first request already carries the operator's state. This
  matches cookie seeding at creation and avoids mixing two identities in one context.

**Cookie export stays shut for that session.** A session that received a handoff is marked
`credentialSource: "operator"`. From then on, `GET /v1/sessions/{id}/cookies` and every surface
built on it refuse with `HANDOFF_COOKIES_NOT_EXPORTABLE`. This is what keeps values out of the
agent's reach: without the mark, the agent could hand off and immediately export.

### 3. Exactly the requested domains, with nothing widened

The domain filter follows the rules of the CLI cookie-file handoff:
- **`domains`** are registrable hosts.
  - A requested `github.com` matches cookies for `github.com` and `.github.com`, and host-only
    cookies set on its subdomains.
  - It never matches a sibling site that merely shares a suffix.
- **Attributes are preserved exactly:** `Secure`, `HttpOnly`, `SameSite`, path, expiry (session
  cookies stay session cookies), and the `__Host-` and `__Secure-` prefix rules. Nothing is widened
  or dropped to make the import succeed.
- **Partitioned cookies are skipped and counted.** The protocol has no partition key, and
  converting a partitioned cookie to an unpartitioned one would change its scope. **Expired**
  cookies are skipped and counted too.
- **Bounds:** at most 20 domains and 1000 cookies per handoff (the CLI handoff's cookie bound),
  checked before anything is written. A handoff that would exceed them writes nothing.

### 4. Approval is mandatory and floor; policy can only narrow it

Transferring credentials is a high-risk effect. Under ADR-024's layers:

- **Floor:**
  - every handoff needs a single-use **approval token**, as ADR-007 defines it;
  - the token is bound to the destination session, the sorted domain set, and the policy version;
  - **no policy can make a handoff unattended.**
  - The CDP-attach floor refusals also apply in full: no hosted deployment, a single authenticated
    tenant, a loopback endpoint and listener, and no delegated session as the destination.
- **Cedar:** action `cookie.handoff`, resource `Host` (one decision per requested domain),
  principal the destination session.
  - The baseline grants it to no one, so an operator opts in per tenant and per domain, for
    example "tenant `local` may hand off `github.com`".
  - A denied domain fails the whole handoff, naming the denied domains and their rule.
- **The first call** returns `APPROVAL_REQUIRED` with a token. The caller obtains the operator's
  confirmation and retries with it.
  - **With API keys configured, the decision must come from an operator principal.** That is the
    reviewed-approval path (`session approval-decide`), so an agent's own credentials cannot
    approve a transfer of the operator's login.
  - In local no-keys mode the token records caller confirmation, as ADR-007 states for every
    approval today.

**Audit.** Each handoff logs at `info`:
- the destination session, the domain set and the counts;
- the approval token id, the policy version and the rule ids.

It never logs values or names.

### 5. What it does not do

- **It does not keep the two browsers in sync.** A transfer is a one-time copy. Cookies the site
  later refreshes in the destination are not written back, and later operator logouts do not
  reach the destination.
- **It is not a login proof.** A seeded session can still meet a sign-in wall (ADR-013). The agent
  verifies the authenticated UI after navigating, with no automatic retry loop.
- **It does not open the operator's tabs to the agent,** and does not relax CDP attachment's
  containment for sessions that use `cdpAttach` directly.
- **It carries no local storage or IndexedDB.** Many sites keep sign-in state there as well.
  Extending the handoff to storage is a separate decision with its own scoping problems.

## Consequences

- **The operator's login becomes usable inside a contained session.** That gives
  containment-grade egress, an explicit host allowlist and full observation, without the cookie
  values entering the agent's context.
- **New surface:**
  - the handoff route, SDK method, CLI command and MCP tool;
  - the `credentialSource` session mark and the `HANDOFF_COOKIES_NOT_EXPORTABLE` error;
  - the `cookie.handoff` Cedar action and the token's domain binding.
- **Depends on ADR-024** for the per-tenant, per-domain grant. Until ADR-024's policy file exists,
  the handoff is **disabled**. There is no legacy-variable way to enable it, so it cannot ship
  ahead of its gate.
- **It reuses existing parts:**
  - the attached-browser connection and its floor;
  - cookie normalization and the `__Host-` handling from session creation;
  - the CLI handoff's filtering and bounds;
  - `SecretManager` redaction;
  - approval tokens.

  No second automation stack, cookie store or credential vault is added.

## Alternatives considered

- **Export to the agent, then seed** (today's loop, applied to attached profiles). The values pass
  through the agent's context and transcript, where a prompt-injected page can steer them out.
  Rejected; this is the gap the ADR closes.
- **Read Chrome's cookie database from disk.** It is encrypted with OS-keychain keys that vary by
  platform, locked while Chrome runs, and its format changes between releases. Rejected for the
  supported CDP read of a running browser the operator has deliberately exposed.
- **Adopt the operator's existing tab or profile for the agent.** That is CDP attachment itself,
  with its uncontained egress. Rejected as the answer to "use my login safely".
- **A browser extension in the operator's browser.** A new installed component with its own update
  and permission story. Rejected.
- **Continuous sync between the two browsers.** Logouts and token refreshes would race in both
  directions, and the destination could write back into the operator's profile. Rejected; this
  handoff is a one-time copy into a contained session.
- **Allowing handoff into a session without `allowedHosts`.** Script-readable cookies could then
  travel to any host the default policy allows. Rejected.
