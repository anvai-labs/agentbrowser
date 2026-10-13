# TD-BROWSER-16: Operator cookie handoff

**Status:** Planned (after TD-BROWSER-15 phase 4)
**Decision:** [ADR-025](../adr/025-operator-cookie-handoff.md)

## Problem

Today an agent uses the operator's login either by driving an uncontained profile (`cdpAttach`) or
by receiving the cookie values itself (export, then seed). ADR-025 adds a server-internal,
operator-approved transfer into a contained session. This TD is the plan.

## Prerequisites

- **TD-BROWSER-15 phase 4:** the policy file and opt-in Cedar. The handoff is enabled only by a
  `cookie.handoff` grant.
- **TD-BROWSER-15 phase 0:** the floor module, which the handoff's refusals extend.

## Phases

Each phase is its own PR with its own adversarial review, test-first. Phases 1–3 add
infrastructure with no user-visible capability; phase 5 enables the handoff.

### Phase 1: operator credential and non-act approvals

- **`AGENTBROWSER_OPERATOR_KEYS`:**
  - Keys in this set authenticate as `actor: "human-operator"`, and **only** on approval-decision
    routes. On any other route they are refused with the existing authentication error.
  - A key present in both this set and `AGENTBROWSER_API_KEYS` aborts startup.
  - Keys are never logged, consistent with `API_KEYS`.
- **`ApprovalRequest` gains a `kind`.** The existing act requests become `kind: "act"`, unchanged.
  A generic non-act kind carries a typed payload and fingerprint, which phase 5 instantiates as
  `cookie.handoff`.
  - **Protocol first (ADR-015):** the request kind and the non-act `APPROVAL_REQUIRED.details`
    shape.
- **Tests:**
  - an API key (an agent) cannot decide a non-act approval;
  - an operator key can decide but cannot create sessions or act;
  - overlapping keys are refused;
  - act approvals are unchanged.

### Phase 2: per-session secret registration

- `SecretManager` gains per-session scopes. A value registered in a session's scope redacts only
  that session's observations, logs, traces and errors.
- Values shorter than 8 characters, or with negligible entropy (a fixed threshold, documented),
  are ignored.
- Registration invalidates the memoized `redactString` cache for that scope.
- **Tests:**
  - no cross-session redaction;
  - the low-entropy floor (`1`, `en`, `true` never redact);
  - cache invalidation (a string cached before registration is redacted after it);
  - the existing global redaction is unchanged.

### Phase 3: domain matcher and cookie normalization in `core`

- **Move** cookie normalization and the bounds from `packages/cli/src/cookie-file.ts` into
  `packages/core`. The CLI then imports them from core, so the package graph keeps its direction.
- **Fix the dedup key:** host-only `github.com` and `.github.com` are distinct cookies. Today the
  key strips the leading dot and wrongly rejects a real jar that holds both.
- **Add** `tldts`, pinned, using the Public Suffix List's private section, and the ADR-025 §3
  matching relation:
  - refuse public suffixes;
  - match the cookie's domain equal to or under the requested domain, within its registrable
    domain;
  - a parent-domain cookie is not pulled in by requesting a subdomain.
- **Tests:**
  - `github.com` matches `.github.com` and host-only `gist.github.com`;
  - `gist.github.com` does not match `.github.com`;
  - `github.io`, `vercel.app`, `co.uk` and `com` are refused;
  - sibling suffixes (`notgithub.com`) do not match;
  - the dedup fix holds, and the CLI behaviour is otherwise unchanged.

### Phase 4: the read side

- **`AGENTBROWSER_HANDOFF_CDP_ENDPOINT`:**
  - It uses the same strict loopback parsing as `AGENTBROWSER_CDP_ENDPOINT`.
  - It does not require the uncontained-egress acknowledgement, and it does not enable `cdpAttach`.
  - Admission follows the floor: not hosted, a single authenticated tenant, a loopback listener and
    peer, and operator keys configured.
- **The read** discovers the browser target's WebSocket URL through `/json/version` on the
  endpoint, then:
  - opens a raw CDP WebSocket;
  - sends `Storage.getCookies`;
  - closes the socket.
  - It makes no `Target.*` or `Runtime.*` call, and nothing else is sent. A test asserts the exact
    method list sent.
- **Normalization:**
  - Partitioned cookies (those with a `partitionKey`) are skipped and counted, and expired ones
    too.
  - Values are bounded by the ADR-025 §6 table before anything else happens.
- **Tests:** run against the existing pre-commit CDP smoke (independent Chrome, disposable
  profile, local fixture with seven cookies covering host-only, domain, subdomain host-only,
  path-scoped, `HttpOnly`, partitioned and expired). Each test asserts that:
  - **filtering:** the server-side filter returns exactly the expected set, including the
    path-scoped and subdomain host-only cookies that a URL-filtered read drops;
  - **operator browser untouched:** afterwards it has the same cookies, its tabs are not attached,
    and its download behaviour is unchanged;
  - **coexistence:** the read works while a `cdpAttach` session is connected;
  - **no leakage:** a scan of all captured output finds no value.

### Phase 5: the operation

- **Route:** `POST /v1/sessions/{sessionId}/cookies/handoff` `{ domains, approvalToken? }`. It runs
  under **one per-session lock** in this order:
  1. **Check the floor**, with each refusal reported by its own `floor.handoff.*` id and protocol
     error:
     - the engine enforces egress;
     - the session is isolated and not delegated;
     - `allowServiceWorkers` is off and the WebSocket policy is the default deny;
     - no committed non-`about:blank` navigation on any page or popup;
     - no existing cookies for the requested domains;
     - every `allowedHosts` entry, including the scope and per-request allowlists, is an exact
       host within the requested domains;
     - operator keys are configured.
  2. **Check policy:** one Cedar `cookie.handoff` decision per domain. Any deny fails the whole
     handoff.
  3. **Check approval:**
     - without a valid token, return `APPROVAL_REQUIRED` with
       `{ kind: "cookie.handoff", sessionId, domains, counts }`;
     - the token must have been decided by a `human-operator` principal, and is single-use;
     - a changed domain set or changed per-domain counts invalidate it.
  4. **Read** (phase 4), then **recheck** the "fresh" conditions.
  5. **Mark** `credentialSource: "operator"`.
  6. Register the values (phase 2), force `approval.transactions` and `externalMessages` to
     `required`, and **write** through the same `addCookies` path session creation uses.
  7. Write an `info` audit log: session, domains, counts, token id and rule ids, never values or
     cookie names.
- **The marked session refuses** cookie export, HTML export and download collection on every
  surface with `HANDOFF_COOKIES_NOT_EXPORTABLE`. It shows `credentialSource` in the protocol
  session view.
- **Launch flag:** handoff-capable sessions launch with
  `--force-webrtc-ip-handling-policy=disable_non_proxied_udp`.
- **Tests:**
  - every floor refusal, including `[".com"]` and a mixed `["github.com", "attacker.example"]`
    allowlist;
  - partial policy denial;
  - an agent key cannot approve;
  - token invalidation;
  - the export, HTML and download refusals;
  - the forced approval tightening;
  - **a concurrency test:** a racing `GET /cookies` during the handoff is refused, because the mark
    precedes the write;
  - **end to end** on the local fixture: the handed-off session receives the authenticated response,
    and the agent-facing output contains no value.

### Phase 6: surfaces and docs

- **SDK and CLI:** `client.sessions.cookieHandoff()`; `agentbrowser session cookie-handoff`, which
  prints the `APPROVAL_REQUIRED` details and the operator's decision command.
- **MCP:** a `cookie_handoff` tool with an optional `approvalToken`. It is present only where the
  mode profile carries the new `session.credential` capability. A protocol mode-profile change comes
  first.
- **`GET /v1/policy`** lists `cookie.handoff` grants per domain.
- **Docs:**
  - a guide, "Use your login safely": the dedicated debugging profile; operator keys and who holds
    them; the exact `allowedHosts` rule; what is guaranteed and what is not (account authority, the
    residual list); verifying the login after navigating; a one-time copy, with local storage not
    carried;
  - a threat-model entry for the handoff, including the account-authority threat;
  - the operations docs gain the two new variables.
- **ADR-025 status → Accepted** when phase 5 ships.

## Non-goals

- Sync, write-back, or refresh.
- Local storage or IndexedDB.
- Handoff into `cdpAttach` or remote-CDP sessions.
- Reading browser cookie databases from disk.
- Making the handoff unattended.

## Risks

- **A hostile agent with a seeded session.** It holds the operator's account authority on the
  allowed hosts. Mitigations: the operator's decision, exact hosts, forced approval tightening, and
  the docs stating this plainly.
- **Residual egress paths:** POST redirect hops, worker WebSockets, missing DNS pinning, and
  pixels or console output. They are documented, and WebRTC is mitigated by the launch flag.
- **Approval fatigue.** Grants are per domain, and decisions are per transfer, by design.
- **Public Suffix List freshness.** `tldts` is pinned and updated by Dependabot. A stale list
  errs toward treating new hosting suffixes as registrable. The docs say so.
