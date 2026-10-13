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

- **`AGENTBROWSER_OPERATOR_KEYS_FILE`:** a file of `key:tenant` entries, never an inline variable,
  so it can sit where an agent's OS user cannot read it.
  - Each tenant must equal the single API-key tenant. Ownership checks apply to these keys as to
    API keys.
  - These keys authenticate as `actor: "human-operator"`, and **only** on routes flagged
    `decisionRoute: true` in fastify `routeOptions.config`. That is the same metadata mechanism the
    `/v1` hook already reads for `config.capability`. Any other route refuses them with the
    existing authentication error.
  - `SessionPrincipal`'s actor union gains `human-operator`.
  - A key present in both this file and `AGENTBROWSER_API_KEYS` aborts startup. Keys are never
    logged.
  - The CLI's decision command reads the operator key from `AGENTBROWSER_OPERATOR_KEY`.
- **`ApprovalRequest` gains a `kind`.** The existing act requests become `kind: "act"`, unchanged.
  Two new kinds are added:
  - `act.reviewed`: act approvals in a marked session;
  - a generic non-act kind with a typed payload and binding, which phase 5 instantiates as
    `cookie.handoff`.

  **Protocol first (ADR-015):** the kinds, and the non-act `APPROVAL_REQUIRED.details` and view
  shapes.
- **A separate resolve-and-decide path for the new kinds.** The existing decision routes resolve
  through `reviewContext()`. It requires `approval.review: "operator"`, and so a delegated session
  and its authority epochs (`prepareApprovalDisclosureInScope` has the same delegated-only guard).
  Handoff destinations are never delegated, so the new kinds must not reuse that path. Existing
  act approvals keep it, unchanged.
- **Tests:**
  - an API key (`actor: "operator"`, which an agent may hold) is refused on **both** the GET view
    and the POST decision for every new kind;
  - an operator key can view and decide, but cannot create sessions or act;
  - the non-act view shows kind, domains and counts, never cookie names;
  - overlapping keys are refused;
  - existing act approvals are unchanged.

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
  endpoint. It keeps only the URL's path and connects to the configured loopback host and port;
  any other host or scheme is refused, with a test. Then it:
  - opens a raw CDP WebSocket;
  - sends `Storage.getCookies` with no `browserContextId`, which reads the default context only
    (verified on Chrome 152);
  - closes the socket.
  - It makes no `Target.*` or `Runtime.*` call, and nothing else is sent. A test asserts the exact
    method list sent.
- **Normalization:**
  - Partitioned cookies (`partitionKey` or `partitionKeyOpaque` present) are skipped and counted.
    Expired ones are also skipped, defensively; Chrome does not return them here.
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
     - without a valid token, **read** the operator browser (phase 4) for the Cedar-granted
       domains only, and return `APPROVAL_REQUIRED` with
       `{ kind: "cookie.handoff", sessionId, domains, counts }`. The counts are informational;
     - the token is bound to `(kind, sessionId, sorted domains, policy version)`, must have been
       decided by a `human-operator` principal, and is single-use.
  4. **Read again**, then **recheck** the "fresh" conditions. Fail only if a requested domain went
     from some cookies to none; changed counts are expected.
  5. **Mark** `credentialSource: "operator"`.
  6. **Register** the values (phase 2), **switch** the session to operator-reviewed actions
     (high-risk and `unknown` effects require `act.reviewed` approvals, with `unknownRisk` forced
     to `required`), **inject** the all-frames init script that removes `RTCPeerConnection`, and
     **write** through the same `addCookies` path session creation uses.
  7. Write an `info` audit log: session, domains, counts, token id and rule ids, never values or
     cookie names.
- **The marked session refuses** cookie export, HTML export and download collection on every
  surface with `HANDOFF_COOKIES_NOT_EXPORTABLE`. It shows `credentialSource` in the protocol
  session view.
- **Launch flag:** while `AGENTBROWSER_HANDOFF_CDP_ENDPOINT` is configured, the shared Chromium
  launches with `--force-webrtc-ip-handling-policy=disable_non_proxied_udp`. It is browser-wide,
  because headless sessions share one browser. WebRTC over TCP remains a documented residual.
- **Tests:**
  - every floor refusal, including `[".com"]` and a mixed `["github.com", "attacker.example"]`
    allowlist;
  - partial policy denial;
  - an agent key cannot approve;
  - token invalidation;
  - the export, HTML and download refusals;
  - in a marked session, a `transaction` and an `unknown`-effect action both need an `act.reviewed`
    decision by the operator key. The agent retrying with the token id is refused;
  - `RTCPeerConnection` is absent in every frame of a marked session;
  - the binding survives cookie-count changes, and fails only on some-to-none;
  - `allowedHosts` checks through `scope.allowedHosts`, the per-request `allowedHosts` and
    `scope.pathRules.hostSuffix`;
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
  allowed hosts. Mitigations: the operator's decision, exact hosts, operator-reviewed high-risk and
  unknown actions, and the docs stating this plainly.
- **An agent with a shell as the same OS user** bypasses the tool-surface boundary: it can reach the
  debugging port, or read the server's environment. The guide requires a separate OS user for the
  server and the debugging Chrome, and operator keys in a file the agent's user cannot read.
- **Residual egress paths:** POST redirect hops, worker WebSockets, missing DNS pinning, and
  pixels or console output, and WebRTC over TCP. They are documented; WebRTC is reduced by the
  launch flag and the `RTCPeerConnection` removal.
- **Approval fatigue.** Grants are per domain, and decisions are per transfer, by design.
- **Public Suffix List freshness.** `tldts` is pinned and updated by Dependabot. A stale list
  errs toward treating new hosting suffixes as registrable. The docs say so.
