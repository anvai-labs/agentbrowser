# ADR-025: Policy-Gated Cookie Handoff from the Operator's Browser

**Status:** Proposed (2026-10-13)
**Related:** [ADR-005](005-ephemeral-sessions-explicit-persistence.md) (explicit persistence),
[ADR-006](006-network-egress-policy-ssrf.md) (egress policy),
[ADR-007](007-approval-tokens-side-effects.md) (approval tokens),
[ADR-013](013-headed-sessions-and-walled-logins.md) (walled logins),
[ADR-020](020-inline-html-verification.md) (HTML is not secret-redacted),
[ADR-024](024-server-policy-engine-cedar.md) (policy engine),
[operator CDP attachment](../spec/design/operator-cdp-attach.md),
[CLI cookie-file handoff](../spec/design/cli-cookie-file-handoff.md),
[TD-BROWSER-16](../td/TD-BROWSER-16-operator-cookie-handoff.md) (implementation plan)

## Context

Agents often need a site the operator is signed in to. "Signed in" here means signed in within a
**Chrome profile the operator has exposed for remote debugging**. Since Chrome 136, regular Chrome
refuses remote debugging on the default user-data directory, so this is a dedicated profile, not
the operator's everyday one (operator-cdp-attach.md).

Today an agent can use that login in two ways, and each gives something up:

1. **Operator CDP attachment** (`cdpAttach: true`) drives that profile directly. Only the initial
   explicit navigation is checked. Redirects, subresources, page scripts, WebSockets and downloads
   are not contained.
2. **Export, then seed** (TD-BROWSER-6) puts cookies into an isolated session. But the values pass
   through the agent's context and transcript. Export from an attached profile is refused outright
   (`PROFILE_COOKIE_EXPORT_UNSUPPORTED`).

What's missing is the operator's login inside a contained session **without the cookie values
passing through AgentBrowser's cookie surfaces to the agent**, with the operator, not the agent,
deciding each transfer.

## Decision

### 1. What is guaranteed, and what is not

**Guaranteed:**
- The agent names domains. Cookie values never appear in AgentBrowser's cookie surfaces, requests,
  responses, logs, traces, errors or events, and cookie export is refused for the destination
  session from then on (§4).
- **Each transfer is approved by a human operator credential the agent does not hold** (§5).

**Not guaranteed, and stated so:**
- **Account authority is the real asset.** Once seeded, the destination session can do anything
  the operator's account can do on the allowed hosts. An agent could, for example, mint an API
  token in the site's UI and read it from the page. Hiding cookie values defends against transcript
  leakage and accidental disclosure. **It is not a defence against a hostile agent.** What bounds
  a hostile agent is the operator's decision to approve, the exact host allowlist (§3), and the
  mandatory approval tightening (§4).
- **Value-level redaction is exact-match and partial.** HTML export (ADR-020), screenshots,
  console output, or a page that reflects a cookie in encoded form can surface a value. §4 refuses
  the surfaces that would carry one wholesale, and lists the rest as residuals.

### 2. A server-internal, read-only transfer

```
POST /v1/sessions/{sessionId}/cookies/handoff
{ "domains": ["github.com"], "approvalToken": "..." }
→ { "transferred": 7, "skipped": { "partitioned": 1, "expired": 0 }, "domains": ["github.com"] }
```

**Enablement is separate from attachment.**
- A dedicated `AGENTBROWSER_HANDOFF_CDP_ENDPOINT` (loopback HTTP only, parsed exactly like
  `AGENTBROWSER_CDP_ENDPOINT`) enables the handoff **without** enabling `cdpAttach`.
- It does **not** require `AGENTBROWSER_CDP_ALLOW_UNENFORCED_EGRESS`. That acknowledgement accepts
  uncontained egress, which is the opposite of this feature.
- The attachment floor's admission conditions still apply: not hosted, a single authenticated
  tenant, a loopback listener and peer.

**The read touches nothing.**
- The server opens a **raw browser-target CDP WebSocket** to the endpoint, sends one
  `Storage.getCookies`, and closes it.
- It does not use Playwright's `connectOverCDP`. That call auto-attaches to every operator tab
  (`Target.setAutoAttach`, `Runtime.enable`, an init script in a utility world), and without
  `noDefaults` it also changes the default context's download behaviour and focus emulation.
- It opens no page, attaches no target, writes no cookie and changes no setting.
- It is independent of any attached session. A second read-only connection coexists with one,
  so no reservation is taken.

**Filtering is server-side, by cookie domain.** `Storage.getCookies` returns every cookie in the
profile. Playwright's URL-filtered `cookies(urls)` would silently drop host-only cookies on
subdomains and path-scoped cookies, because it matches upwards from a URL. The server filters
instead, with the relation defined in §3.

### 3. Exactly the handed-off sites, in both directions

**Requested domains must be registrable.**
- Each requested domain must be a registrable domain, or a host under one, according to the
  **Public Suffix List, private section included** (a pinned `tldts`).
- A public suffix is refused. That covers `com` and `co.uk`, and also `github.io`, `vercel.app`,
  `herokuapp.com` and `blogspot.com`, so one request cannot sweep every tenant's cookies under a
  shared hosting suffix.

**Which cookies match.** A cookie matches a requested domain D when its domain, with any leading dot
removed, equals D or is a subdomain of D, **and** lies within D's registrable domain. So:
- requesting `github.com` matches cookies for `github.com`, `.github.com` and host-only
  `gist.github.com`;
- requesting `gist.github.com` matches cookies for `gist.github.com` but not the parent
  `.github.com`. A parent-domain cookie is reached only by requesting the parent.

**The destination's allowlist must lie inside the handed-off sites. This is the inverse of
"covers".** The handoff is refused unless all of the following hold:
- the session's `policy.allowedHosts` exists, and **every** entry is an **exact host** (no
  `.suffix` entries) within the requested domains;
- likewise for `policy.scope.allowedHosts` (engagement scope) and the service's per-request
  `allowedHosts`, if set.

An allowlist such as `[".com"]` or `["github.com", "attacker.example"]` is therefore refused, and
the session cannot reach a host the cookies were not handed off for. Exact hosts also keep a
dangling subdomain under a suffix entry from becoming attacker-controlled script inside the
allowlist.

**Attributes are preserved exactly.**
- `Secure`, `HttpOnly`, `SameSite`, path, expiry (session cookies stay session cookies), and the
  `__Host-` / `__Secure-` handling that session creation already applies.
- Nothing is widened or dropped to make the import succeed.
- Two cookies that differ only in host-only versus `.domain` scope are **distinct** cookies, and
  both are kept.

### 4. The destination: contained, quiet, and marked before it is written

**The handoff is refused unless the destination session meets all of these:**
- **Egress-enforcing engine.** It is isolated: not `cdpAttach`, not remote CDP, and on an engine
  whose egress the choke point enforces.
- **Not delegated.**
- **No egress exceptions.** `allowServiceWorkers` is off (service-worker requests bypass the choke
  point, ADR-019), and the WebSocket policy is the default deny.
- **Fresh.**
  - It has **not committed a navigation** to anything but `about:blank` on any page or popup.
  - It **holds no cookies for the requested domains.** This prevents identity mixing and cookie
    tossing through create-time `cookies`.

**One per-session lock covers the whole sequence:**
1. check the conditions;
2. read from the operator's browser;
3. **mark** the session `credentialSource: "operator"`;
4. write the cookies.

The mark comes **before** the write, so no concurrent export can see the cookies unmarked. The
"fresh" conditions are rechecked under the lock.

**A marked session:**
- refuses cookie export on every surface (REST, SDK, CLI, MCP) with
  `HANDOFF_COOKIES_NOT_EXPORTABLE`;
- refuses HTML export (`html`, which ADR-020 leaves unredacted) and download collection, with the
  same code;
- has `policy.approval.transactions` and `externalMessages` forced to `required`, so
  account-changing actions on the operator's identity need an approval each time;
- has its cookie values registered for redaction, **per session** (below);
- shows `credentialSource` in the protocol session view (ADR-015).

**Per-session secret registration is new.** Today's `SecretManager` is one immutable,
process-wide instance with a memoizing cache. Phase 1 of TD-BROWSER-16 adds per-session
registration that:
- applies only to that session's observations, logs and traces, never across sessions;
- ignores values shorter than 8 characters or with negligible entropy, so a cookie value `1` or
  `en` never redacts every occurrence in the process;
- invalidates the redaction cache on registration.

**Residuals, accepted and documented:**
- **Screenshots and PDFs** are pixels.
- **Console output** carries whatever the page logs.
- **POST, PUT and PATCH redirect hops** are not re-checked (ADR-006). A 307 or 308 open redirect
  on an allowed host can carry a body off-host.
- **WebSockets opened by workers** are not covered by the page WebSocket deny.
- **WebRTC/STUN and DNS prefetch** are not routed. Handoff-capable sessions launch with Chromium's
  `--force-webrtc-ip-handling-policy=disable_non_proxied_udp`.
- **Browser connections are not DNS-pinned.**

### 5. Approval by a human operator credential the agent never holds

Today any valid API key authenticates as `actor: "operator"`, and an agent configured with a key
can approve its own `APPROVAL_REQUIRED`. The only `agent` principals are delegated-session grants.
The reviewed path (`approval.review: "operator"`) exists only for delegated sessions and only for
page actions. None of that can gate a handoff.

So the handoff introduces **a separate operator-approval credential.**
- `AGENTBROWSER_OPERATOR_KEYS` is a set of keys, distinct from `AGENTBROWSER_API_KEYS`.
- A key from it authenticates as `actor: "human-operator"`, and is accepted **only** on approval
  decision routes. It cannot create sessions or act, so it is never useful to configure in an
  agent.
- A key may not appear in both sets; startup refuses that.
- **Without operator keys, the handoff is disabled (floor).** There is no unattended or self-approved
  mode, so the earlier "local no-keys" case cannot occur. CDP admission refuses no-keys mode
  anyway.

**A non-act approval request kind.**
- `ApprovalRequest` gains `kind: "cookie.handoff"`, fingerprinted by
  `(sessionId, sorted domains, the operator browser's cookie count per domain at read time)`.
- `APPROVAL_REQUIRED.details` carries `{ kind, sessionId, domains, counts }`. It never carries
  cookie names or values.
- The decision is made with the operator key on the existing decision route
  (`session approval-decide`). The retry then carries the token, and the token is single-use.
- A change in the domain set, or a cookie count change between approval and execution,
  invalidates it.

**Cedar decides, the floor still holds.**
- Action `cookie.handoff`, resource `Host`, one decision per requested domain.
- The ADR-024 baseline grants it to no one. Operators grant per tenant and per domain.
- A denial of any domain fails the whole handoff.
- No policy can remove the approval step.

### 6. Differences from the CLI cookie-file handoff

This handoff reuses the CLI handoff's **attribute** rules, but not its input rules, because the
input here is a live browser, not a file a person chose:

| Rule | CLI file handoff | Operator handoff |
|---|---|---|
| Partitioned cookies | Refused unless `--cookies-skip-unsupported` | Skipped and counted. The operator asked for a site, not for a specific cookie |
| Expired cookies | Refused | Skipped and counted; the browser jar can legitimately hold them |
| Bounds | 1 MiB of input, 1000 cookies | 20 domains, 1000 cookies, 1 MiB of total name and value bytes. Checked before anything is written |
| Domain filter | None (it was designed but never implemented) | The §3 relation, backed by the Public Suffix List |

The domain matcher and cookie normalization move into `packages/core`. Both the CLI and the
service can then use them without importing the CLI package.

### 7. Agent surfaces

- **SDK:** `client.sessions.cookieHandoff()`.
- **CLI:** `agentbrowser session cookie-handoff <session> --domain <d>…`.
- **MCP:** a `cookie_handoff` tool with an optional `approvalToken`.
  - The first call returns `APPROVAL_REQUIRED` with its details. The agent tells the operator,
    who decides with their own key outside the agent, and the agent retries with the token.
  - The tool appears only in modes whose profile carries a new **`session.credential`**
    capability, defined in `packages/protocol/src/mode-profile.ts`.

## Consequences

- **The operator's login works inside a contained session.** The host allowlist is exact, egress
  exceptions are off, and approval tightening is on. The cookie values stay out of the agent's
  transcript.
- **A human decides every transfer,** with a credential the agent cannot hold. That is new
  infrastructure, `AGENTBROWSER_OPERATOR_KEYS`, and it is useful beyond this feature.
- **New surface:**
  - the route, SDK method, CLI command and MCP tool;
  - `AGENTBROWSER_HANDOFF_CDP_ENDPOINT` and `AGENTBROWSER_OPERATOR_KEYS`;
  - `credentialSource`, `HANDOFF_COOKIES_NOT_EXPORTABLE` and the `floor.handoff.*` refusals;
  - the `cookie.handoff` approval kind and Cedar action;
  - the `session.credential` mode capability;
  - per-session secret registration.
- **New dependency:** `tldts`, with a pinned Public Suffix List.
- **Depends on ADR-024** for the per-domain grant. It ships disabled until ADR-024's policy file
  exists, and no legacy variable enables it.

## Alternatives considered

- **Export to the agent, then seed** (today's loop, applied to attached profiles). Values pass
  through the agent's transcript. Rejected.
- **Approval by any API key, or by caller confirmation.** The agent holds that key, or is the
  caller, so it would approve itself. Rejected for the separate operator credential.
- **Playwright `connectOverCDP` for the read.** It attaches to operator tabs and changes browser
  settings. Rejected for a raw `Storage.getCookies`.
- **URL-filtered `cookies(urls)`.** It drops subdomain host-only and path-scoped cookies. Rejected
  for server-side domain filtering.
- **"Requested domains fall within `allowedHosts`".** That check runs in the wrong direction:
  `[".com"]` would satisfy it. Rejected for "the allowlist lies within the handed-off domains,
  exact hosts only".
- **Reading Chrome's cookie database from disk.** It is encrypted with OS-keychain keys, locked
  while Chrome runs, and its format changes between releases. Rejected.
- **Adopting the operator's tab or profile.** That is `cdpAttach`, with uncontained egress.
  Rejected.
- **Continuous sync or write-back.** Logouts and token refreshes would race in both directions,
  and the destination could write into the operator's profile. Rejected; this is a one-time copy.
