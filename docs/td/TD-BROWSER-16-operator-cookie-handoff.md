# TD-BROWSER-16: Operator cookie handoff

**Status:** Planned (after TD-BROWSER-15 phase 4)
**Decision:** [ADR-025](../adr/025-operator-cookie-handoff.md)

## Problem

An agent can use the operator's existing login in two ways today:
- **drive the operator's own profile** (`cdpAttach`), whose egress is uncontained;
- **receive the cookie values itself** (export, then seed).

ADR-025 adds a server-internal transfer into a contained session instead. This TD is the plan.

## Prerequisites

- **TD-BROWSER-15 phase 4:** the policy file, the `Authorizer` seam, and opt-in Cedar. The handoff
  is enabled only by a Cedar `cookie.handoff` grant; no legacy variable enables it.
- **TD-BROWSER-15 phase 0:** the CDP-attach refusals live in the floor module, so the handoff reuses
  them rather than duplicating them.

## Phases

Each phase is its own PR with its own adversarial review, test-first.

### Phase 1: the export mark (no new capability yet)

- Session state gains `credentialSource?: "operator"`, shown in the session view.
- `getSessionCookies`, and every route, SDK method, CLI command and MCP tool built on it, refuse
  for a marked session with a new protocol error `HANDOFF_COOKIES_NOT_EXPORTABLE`.
  The error is added to `ErrorCodeEnum` and mapped to HTTP 403.
- **Tests:** a session marked directly (test hook) refuses on every export surface; unmarked
  sessions are unchanged.

### Phase 2: the read side (engine)

- The engine contract gains
  `readOperatorCookies(domains): Promise<{ cookies; skipped }>`, implemented by `engine-playwright`
  only. Other engines refuse with the existing capability error.
- **Connection:**
  - It uses the startup-configured endpoint and the same admission as attachment: loopback only,
    floor refusals first.
  - It opens its own short-lived `connectOverCDP` connection, reads the default context's cookies
    filtered by URL, and closes the connection.
  - It does not create pages, does not adopt tabs, and does not write.
  - It shares the attached-session reservation, so a handoff and an attached session never hold
    two connections at once.
- **Filtering and normalization** reuse the CLI cookie-file handoff helpers:
  - registrable-domain matching;
  - attribute preservation and the `__Host-` / `__Secure-` handling;
  - partitioned and expired cookies skipped and counted;
  - bounds of 20 domains and 1000 cookies, checked before any write.
- **Values** are registered with the destination session's `SecretManager` at read time.
- **Tests:** against the existing pre-commit CDP smoke, with an independent Chrome on a disposable
  profile and a local cookie fixture:
  - domain matching (exact, subdomain, sibling-suffix rejection);
  - attribute preservation;
  - partitioned and expired counts;
  - the bounds;
  - the operator browser is unchanged afterwards: the same cookies, no new tabs;
  - the connection is closed;
  - no value appears in any log, error or trace line (a scan of all captured output).

### Phase 3: the operation (service, policy, approval)

- **Route:** `POST /v1/sessions/{sessionId}/cookies/handoff` `{ domains, approvalToken? }`.
- **Refused unless:**
  - the destination is isolated (not `cdpAttach`, not remote CDP);
  - it is not delegated;
  - it has not navigated;
  - its `policy.allowedHosts` exists and covers every domain.

  Each refusal has its own `floor.handoff.*` id.
- **Policy:** one Cedar `cookie.handoff` decision per domain, with the destination session as
  principal. Any deny fails the whole handoff and names the denied domains and rule ids.
- **Approval:**
  - The first call returns `APPROVAL_REQUIRED` with a token bound to the session, the sorted domain
    set and the policy version.
  - With API keys configured, the decision must come from an operator principal (the reviewed path).
  - The token is single-use; a changed domain set or policy version invalidates it.
- **On success:**
  - the cookies are written with the same `addCookies` path session creation uses;
  - the session is marked `credentialSource: "operator"`;
  - the response carries counts only;
  - an `info` audit log records the session, domains, counts, token id, policy version and rule
    ids.
- **Tests:**
  - every refusal;
  - partial policy denial fails the whole handoff;
  - token binding (domains changed, policy version changed, token reused);
  - an agent credential cannot approve when keys are configured;
  - the export mark is set, and export is refused afterwards;
  - an end-to-end run on the local fixture: the handed-off session sees the authenticated
    response, and the agent never received a value.

### Phase 4: surfaces and docs

- **Clients:** SDK `client.sessions.cookieHandoff()`; CLI `agentbrowser session cookie-handoff
  <session> --domain <d>…` (it handles `APPROVAL_REQUIRED` like `act`); an MCP `cookie_handoff`
  tool, present only in modes that already allow credential handoff.
- **`GET /v1/policy`** (TD-BROWSER-15 phase 5) lists `cookie.handoff` in the capability summary,
  per domain where it is granted.
- **Docs:** a guide section on using your login safely, covering:
  - when to hand off and when to attach;
  - the required `allowedHosts`;
  - verifying the login after navigating;
  - that it is a one-time copy;
  - that local storage is not carried.

  The threat model gains a cookie-handoff entry.
- **ADR-025 status → Accepted** when phase 3 ships.

## Non-goals

- Syncing, writing back to the operator's browser, or refreshing cookies.
- Local storage or IndexedDB transfer.
- Handoff into `cdpAttach` or remote-CDP sessions.
- Reading browser cookie databases from disk.

## Risks

- **A page on a handed-off domain reads script-visible cookies.** Mitigated by the mandatory
  `allowedHosts`, which bounds where they can be sent, and by `SecretManager` redaction of anything
  echoed into observations.
- **Approval fatigue.** Every handoff needs a decision, by design. Grants are per domain, so an
  operator can deny the domains that should never move.
- **CDP endpoint exposure.** Unchanged from attachment: a loopback-only endpoint, a dedicated
  profile per the operator guidance, and floor refusals for hosted and multi-tenant deployments.
