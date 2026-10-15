# TD-BROWSER-16: Operator login browser and cookie handoff

**Status:** Planned (after TD-BROWSER-15 phase 4)
**Decision:** [ADR-025](../adr/025-operator-cookie-handoff.md)

## Problem

Today an agent can use an operator's login in only two ways:
- **drive an uncontained profile** (`cdpAttach`) through a debugging port that any local process
  can read;
- **receive the cookie values itself** (export, then seed).

ADR-025 adds an operator-only login browser with no port, and an operator-approved transfer into a
contained session. This TD is the plan.

## Prerequisites

- **TD-BROWSER-15 phase 4:** the policy file and opt-in Cedar. The handoff is enabled only by a
  `cookie.handoff` grant.
- **TD-BROWSER-15 phase 0:** the floor module, which the handoff's refusals extend.

## Phases

Each phase is its own PR with its own adversarial review, test-first. Phases 1–5 add
infrastructure; phase 6 enables the handoff.

### Phase 1: the operator credential and its decision path

- **`AGENTBROWSER_OPERATOR_KEYS_FILE`** holds `key:tenant` entries, read from a file, never an
  inline variable.
  - Each tenant must equal the single API-key tenant, and ownership checks apply.
  - A key in both sets aborts startup.
  - Keys are never logged.
- **The `human-operator` actor.** `SessionPrincipal`'s actor union gains `human-operator`. These
  keys authenticate as it **only** on routes flagged `operatorRoute: true` in fastify
  `routeOptions.config`, the same mechanism the `/v1` hook already reads for `config.capability`.
  On any other route they are refused.
- **`ApprovalRequest` gains `kind`.** `act` is unchanged. Two new kinds are added:
  - `act.reviewed`, using the ADR-007 act binding;
  - a generic non-act kind, which phase 6 instantiates as `cookie.handoff`.

  **Protocol first (ADR-015):** the kinds, and the non-act `APPROVAL_REQUIRED.details` and view
  shapes.
- **A separate resolve-and-decide path for the new kinds.** The existing routes resolve through
  `reviewContext()` (and `prepareApprovalDisclosureInScope`). It requires
  `approval.review: "operator"`, and therefore a delegated session and its authority epochs, so it
  is not reused. Existing act approvals keep their path.
- **CLI operator commands** read the key from the OS keychain (macOS Keychain, Windows Credential
  Manager, Linux Secret Service) or from a no-echo prompt, **never** from an environment variable.
- **Tests:**
  - an API key (`actor: "operator"`, which an agent may hold) is refused on both the view and the
    decide route for each new kind;
  - an operator key can view and decide, but cannot create sessions or act;
  - overlapping keys are refused;
  - the CLI ignores any operator key in the environment;
  - existing act approvals are unchanged.

### Phase 2: per-session secret registration

- `SecretManager` gains per-session scopes. A value registered in a session's scope redacts only
  that session's observations, logs, traces and errors.
- Values under 8 characters, or with negligible entropy (a fixed, documented threshold), are
  ignored.
- Registration invalidates the memoized `redactString` cache for that scope.
- **Tests:**
  - no cross-session redaction;
  - the floor (`1`, `en`, `true` never redact);
  - cache invalidation;
  - the global redaction is unchanged.

**Delivered (phase 2, #462):** `SecretManager` session scopes — `registerSessionSecret`,
`redactScoped`, `redactUntrustedScoped` (the untrusted-key variant, so cookie values appearing as
dictionary keys redact in the receiving session), `clearSessionSecrets`. The entropy floor (8
characters / 3 distinct). Bounds per TD-BROWSER-9: `redactionCacheMaxEntries` governs the global
memo AND every per-session memo; `sessionScopesMaxSessions` (default 512, `0` disables) bounds
memos least-recently-USED (eviction costs speed, never protection) and makes registration **fail
closed** (`SCOPE_LIMIT`) once that many live scopes exist — a live session is never silently
un-protected; **phase 6 must call `clearSessionSecrets` at session close** (the release valve).
An unknown session id allocates nothing. Core-only: the service wiring is phase 6's.

### Phase 3: domain matcher and normalization in `core`

- **Move** cookie normalization and the bounds from `packages/cli/src/cookie-file.ts` into
  `packages/core`, and have the CLI import them from there.
- **Fix the dedup key:** host-only and `.domain` cookies with the same name and path are distinct.
- **Add** `tldts`, pinned, using the private section, and implement the ADR-025 §3 relation.
- **Tests:**
  - `github.com` matches `.github.com` and host-only `gist.github.com`;
  - `gist.github.com` does not match `.github.com`;
  - `github.io`, `vercel.app`, `co.uk` and `com` are refused;
  - `notgithub.com` does not match;
  - the dedup fix holds, and the CLI behaviour is otherwise unchanged.

**Delivered (phase 3, #463):** `packages/core/src/domain-matcher.ts` on pinned `tldts` with the
**private section in force** (`allowPrivateDomains` — without it `github.io` parses as a normal
`.io` domain). Review round 1 hardened the exported relation to its documented invariants:
`covers` refuses suffix/IP/`localhost` matchers outright (never even self), a dotted entry matches
**subdomains only** (like `SessionHostPolicy` — the apex must be listed alongside), and a usable
parent — a registrable domain OR a host under one, which §3 allows operators to request — covers
its subtree. `usableHost`/`cookieDomain` refuse IPs, bare suffixes, `localhost`, unlisted TLDs
(keys-only), **ports and trailing dots** (tldts's hostname extraction strips them, which would
fork the identity), and allow the host itself or any usable parent on request. `registrableParents`
lists only registrable parents. The cookie bounds moved into core (`MAX_COOKIE_COUNT`,
`assertCookieRequestSize`/`MAX_COOKIE_REQUEST_BYTES`) with the CLI importing them; the CLI's cookie
identity is `cookieKey` (host-only and `.domain` distinct — the leading dot is scope; same-scope
duplicates refuse; the only observable change is the duplicate error naming scope). **Known gap for
phase 6 (recorded, deliberate):** no IDNA canonicalization — unicode and punycode forms of the
same domain are distinct; phase 6 canonicalizes operator input first. 14 matcher tests + 2 CLI
tests.

### Phase 4: the login browser

- **Engine.** The Playwright engine gains a pipe-connected persistent context:
  `launchPersistentContext(dir, { headless })`. Playwright launches Chromium with
  `--remote-debugging-pipe`, so no port is opened. A test asserts that the browser process listens
  on no TCP port.
- **Profile directory.** `AGENTBROWSER_LOGIN_PROFILE_DIR` defaults under the server's data
  directory, outside synced and backed-up paths.
  - **POSIX:** created with mode `0700`; startup refuses a directory with wider permissions.
  - **Windows, which is new code:** the directory is created atomically with a `DirectorySecurity`
    whose DACL is protected and holds only the owner's ACE, with
    `ContainerInherit | ObjectInherit`, so every file Chrome creates inherits owner-only access.
    The CLI's writer creates one file and cannot be reused. Startup parses the DACL and refuses any
    ACE beyond the owner; SYSTEM and Administrators are reported, not refused. Tested on the
    Windows CI job.
- **Launch arguments.** The login browser reuses `headedChromiumOptions` (ADR-013), and removes
  `--disable-client-side-phishing-detection`, `--disable-component-update` and
  `--disable-background-networking` with `ignoreDefaultArgs`. A test asserts the resulting argument
  list.
- **Pinned binary.** The `executablePath` is resolved once at enablement. Launch refuses if that
  binary's version has moved backwards since it last wrote the profile; the version is recorded in
  the profile directory.
- **Service.** With `AGENTBROWSER_LOGIN_BROWSER=1` and operator keys present, three operator
  routes are added:
  - `open` launches headed. It refuses without a display, and refuses when the deployment is
    hosted or has more than one tenant.
  - `close`.
  - `reset` deletes the profile, after confirmation.

  The login browser is not a session: it has no id, refs or pages on any agent surface.
- **Read.** `readLoginCookies()` reads the **open** login browser's context with `cookies()` and
  no URL filter. A closed browser refuses with `LOGIN_BROWSER_CLOSED`; there is no headless read.
  - `open`, `close` and read are serialized on a profile lock.
  - A profile locked by a hand-started Chrome is refused with `LOGIN_PROFILE_IN_USE`.
  - When the operator closes the last window, the context's close event marks the browser closed.
  - Partitioned cookies (`partitionKey` or `partitionKeyOpaque`) and expired ones are skipped and
    counted.
  - The bounds are checked first.
- **Tests:**
  - **filtering:** the server-side filter returns exactly the expected set from a fixture profile
    with seven cookie kinds;
  - **no port:** no TCP listener exists while the browser is open or during a read;
  - **lifecycle:** a closed browser refuses; a hand-locked profile refuses; closing the window
    reconciles the state; a binary downgrade refuses;
  - **access:** the profile mode is enforced; agent credentials are refused on every login-browser
    route; no agent surface can address the browser;
  - **no leakage:** a scan of all captured output finds no value.

**Delivered (phase 4, #464):** `packages/engine-playwright/src/login-browser.ts` + operator
routes. A pipe-connected persistent Chromium context — no debugging port, verified on Linux by
matching the process's own LISTEN sockets through its fds (empty while open and during reads) —
with the three login-wall-disabling Playwright defaults removed via `ignoreDefaultArgs` (the live
argv is asserted to carry none of them and to carry the pipe flag). Profile security: POSIX `0700`
with any wider mode refused; Windows via `icacls` — creation strips inheritance and grants the
owner's SID `(OI)(CI)F`, verification parses the ACE lines (the pipe-glued filename header
stripped first) and refuses any identity beyond every spelling of the owner plus the exempted
SYSTEM/Administrators (no bare username: it would false-exempt `OTHERDOMAIN\sameuser`). icacls,
not PowerShell's `Get-Acl`, because the runner could not load PS 5.1's Security module; the
runner-observed posture after `/inheritance:r` is the ADR-tolerated owner + SYSTEM +
Administrators, and the parse is what refuses anything wider. The profile root is
`AGENTBROWSER_LOGIN_PROFILE_DIR` or the OS per-user state root (XDG_STATE_HOME/`~/.local/state`,
`LOCALAPPDATA`) — the spec's "server data directory" intent, with synced-ness left to the
operator's environment. Binary pinning records the executable path AND its file identity
(size + mtime); a different path refuses `LOGIN_BINARY_CHANGED`, a same-path identity change (an
in-place update) refuses `LOGIN_BINARY_DOWNGRADED`, and either refusal leaves the profile
unlocked (the lock is acquired after every pre-launch check). The compared field is file
identity, not the version string — the runner proved `chrome.exe --version` prints nothing on
Windows (GUI-subsystem exe), which made a version-probe check fail open exactly where ADR-025's
rationale is strongest; the recorded `chromiumVersion` stays as documentation. (Residual,
exotic: a replacement preserving BOTH size and mtime would evade the check — practically
negligible, and every observable direction of the check fails closed.) Lifecycle:
open/close/read serialized; a live second owner or a hand-started Chrome (ProcessSingleton)
refuses `LOGIN_PROFILE_IN_USE`, a stale lock is adopted, reads on a closed browser refuse
`LOGIN_BROWSER_CLOSED`; partitioned (`partitionKey` OR `partitionKeyOpaque`) and expired cookies
are skipped and counted. Operator-only routes `POST /v1/operator/login/{open,close,reset,read}`
behind the human-operator actor with the seven `LOGIN_*` codes in the protocol (409/403/400,
never 500); a hosted deployment refuses at the open route with a typed 400, and the service never
constructs without operator keys — which are single-tenant, so multi-tenant deployments never
boot with one; shutdown closes the browser.
The Windows CI job runs this suite headless — via a TEST-side env knob the test file applies, not
an engine env mode; the branded-chrome suite stays deferred to #465. Seven review rounds; every
Windows behavior above is runner-proven, not claimed. Carried to phase 6 (acknowledged): the F12
reset confirmation, raw values on the read route (tension with ADR-025 §2), the 1 MiB cookie
size bound unenforced (count only), and 400/409 undocumented in the OpenAPI for the four routes.

### Phase 5: action review in marked sessions, and the lease

- **Review.** In a session with `credentialSource: "operator"`:
  - **High-risk effects** (`transaction`, `external-message`, `account-security`, `destructive`)
    always return `APPROVAL_REQUIRED` with kind `act.reviewed`. A per-rule `decision: "allow"`
    on them is overridden.
  - **`unknown` effects** do the same, unless an active lease covers the page's host.
  - Operator classification rules (`read`, `write-local`) are honoured unchanged.
  - Stale tokens are refused like any stale act token.
- **Lease.** `{ hosts, expiresInMs ≤ 4 h, maxActions ≤ 500 }` is granted only on an operator route
  (with the handoff decision, or later). Its `hosts` must lie within the session's exact allowlist.
  - The session view shows the remaining time and count, and every leased action decrements the
    count.
  - No agent-facing route or schema accepts lease fields.
  - The audit log records each grant and when it is exhausted.
- **Write paths outside `act`:**
  - `autofill` in a marked session runs only within a lease covering the page's host, and each
    field write uses one leased action. Without a lease it is refused.
  - `application.execute` is refused in a marked session.
  - A checklist test enumerates every route that can write to a page and asserts a declared
    marked-session behaviour, so a future write path fails the test until it declares one.
- **Tests:**
  - a `transaction` action and an `unknown`-effect action both need an operator decision, and the
    agent retrying with the token id is refused;
  - the lease admits `unknown` actions on its hosts only, never high-risk ones, and stops at its
    expiry and at its count;
  - an agent cannot set a lease;
  - autofill is refused without a lease and counted under one;
  - `application.execute` is refused;
  - the write-path checklist passes.

**Delivered (phase 5, #466):** `credentialSource` enters the code as a **service-level** marking —
a `ServiceSessionRequest` field plus an internal `markOperatorCredentialSource` (what phase 6's
handoff calls). The wire create route refuses `credentialSource` **by name**: the request
validator deliberately passes unknown keys through (for the flat policy fields), and review round 1
proved the first cut therefore forwarded an agent-supplied marker — an API-key create with
`credentialSource: "operator"` got 201 and made the session lease-eligible. The session view
reports the marking read-only. The override lives in `checkApproval` ahead of the allow
early-return: a policy `deny` stands above everything (pinned by test after review round 1 — a
deny-authorizer mutation had passed green); in a marked session an `unknown` effect first tries
the lease (one count per action on a covered host), and otherwise high-risk AND unknown route to
the delegated reviewed branch — whose request now stamps `kind: 'act.reviewed'`, overriding any
per-rule/Cedar allow. That stamping exposed one REAL latent phase-1 bug, fixed:
`ApprovalGate.allocate` spread the binding after the storage `kind`, so every kind-stamped
reviewed approval threw `Invalid token kind` (nothing stamped a kind on the reviewed path before).
A second suspected latent bug — `getApprovalKind` mis-routing `'act.reviewed'` to the non-act
decide path — was claimed in the first cut of this note and RETRACTED after review: `getToken`
returns confirmation records only, so `getApprovalKind` cannot see an act.reviewed token at all;
the exclusion added for it is defense in depth, and the counterfactual failure mode is
`INVALID_TOKEN`, not a burn. The view schema gained the optional kind (strict parse had rejected
it). The lease: `POST /v1/sessions/{sessionId}/lease`, human-operator key only (an API-key
operator gets the FORBIDDEN floor), bounds `≤16 hosts / ≤4 h / ≤500 actions`, every host a usable
host within the session's own allowlist (request + engagement scope; **no allowlist ⇒ no lease**,
fail closed); coverage and validation use the phase-3 matcher (`covers`/`usableHost`);
`lease.granted` / `lease.exhausted` audit events fire once per exhaustion actually observed; the
view shows `actionLease` + `actionLeaseRemainingMs` (named to not collide with the pre-existing
idle `lease`). Lease-shaped input on the agent create-route is inert (passes through, parses to
nothing — asserted by view absence). `autofill` refuses at entry without a covering lease and its
field writes spend leased counts through the normal act path; `application.execute` refuses
outright; the checklist test enumerates mutating routes from the live fastify router so an
undeclared page-writing route fails CI. 14 tests; workspace green.

### Phase 6: the handoff operation

**Route:** `POST /v1/sessions/{sessionId}/cookies/handoff` `{ domains, approvalToken? }`. It runs
under **one per-session lock**:

1. **Floor checks,** each refusal with its own `floor.handoff.*` id:
   - the engine enforces egress;
   - the session is isolated and not delegated;
   - service workers are off, and the deployment's WebSocket policy is the default deny;
   - no committed navigation other than `about:blank`;
   - no existing cookies for the requested domains;
   - every entry in `allowedHosts`, `scope.allowedHosts` and the per-request `allowedHosts` is an
     exact host within the domains, and every `scope.pathRules[].hostSuffix` is too;
   - the login browser is enabled **and open**, and operator keys are configured.
2. **Policy:** one Cedar `cookie.handoff` decision per domain. Any deny fails the whole handoff.
3. **Approval.** Without a valid token:
   - read (phase 4) for the granted domains only;
   - return `APPROVAL_REQUIRED` with `{ kind, sessionId, domains, counts }`;
   - count the call toward the session's pending-approval quota.

   A valid token is bound to `(kind, sessionId, sorted domains, policy version)`, was decided by a
   `human-operator` principal, and is single-use. The decision may carry a lease (phase 5).
4. **Read again** and recheck the "fresh" conditions. Fail only if a domain went from some cookies
   to none.
5. **Mark** `credentialSource: "operator"`.
6. **Prepare the session:**
   - register the values (phase 2);
   - switch on reviewed actions (phase 5);
   - inject the all-frames init script that removes `RTCPeerConnection` and
     `webkitRTCPeerConnection`.
7. **Write** through the session-creation `addCookies` path.
8. **Audit** at `info`: session, domains, counts, token id, lease and rule ids. Never values or
   cookie names.

**Afterwards:**
- The marked session refuses cookie export, HTML export and download collection with
  `HANDOFF_COOKIES_NOT_EXPORTABLE`, and shows `credentialSource` in its view.
- While the login browser is enabled, the shared Chromium launches with
  `--force-webrtc-ip-handling-policy=disable_non_proxied_udp`.

**Tests:**
- **Refusals:**
  - every floor refusal, including `[".com"]`, `["github.com", "attacker.example"]`, a broad
    `scope.pathRules.hostSuffix`, and a session that already holds cookies;
  - partial policy denial;
  - an agent key cannot approve;
  - the pre-approval call is quota-limited;
  - the export, HTML and download refusals.
- **Binding and timing:**
  - the token binding survives count changes and fails on some-to-none;
  - **concurrency:** a racing `GET /cookies` is refused, because the mark precedes the write.
- **WebRTC removal:** `RTCPeerConnection` is absent in a synchronous `about:blank` iframe and in a
  `window.open('about:blank')` popup.
- **End to end:** an operator signs in to a local fixture in the login browser, the handoff is
  approved with a lease, the agent completes a leased flow, and no agent-facing output contains a
  value.

**Delivered (phase 6, #470):**
*(Review round 1 corrected four things, all test-pinned: the cookie applies relation had
`covers()` inverted — deep-host requests pulled parent cookies, apex requests refused subtree
cookies — the per-domain evidence and freshness guard now use the fixed relation; every
pre-mark-abortable check (engine capability, lease validation, the previously-unenforced ADR §3
transfer bounds, init script, secret registration) moved BEFORE the mark so no refusal can brick
a marked-but-empty session; operator domain input is canonicalized (case/whitespace/trailing
dot); and the RTC-removal script became a shared engine-package constant (`HANDOFF_RTC_REMOVAL_INIT_SCRIPT` in @agentbrowser/engine)
so the real-browser behavioral tests exercise the exact shipped text. ADR §4's baseline sentence
now states the shipped Cedar default; floor.handoff.websocket guards a compile-time
canary on the construction default (a field whoever adds a webSocketPolicy option must set honestly).)*
 `POST /v1/sessions/{sessionId}/cookies/handoff` under a
per-session promise-chain lock, in the spec's order. Floors each carry their own `floor.handoff.*`
rule id (login browser enabled+open via the new `LoginBrowserService.isOpen`; isolated
non-delegated local launch recorded as per-session create facts; egress chain presence; service
workers off; every page at about:blank by live `getUrl`, never the cache; no existing cookies via
the engine's `cookies()` with leading-dot domain matching; the whole allowlist — request, scope,
and every `pathRules[].hostSuffix` — an exact host within the requested domains; each domain a
usable host). Policy: one `cookie.handoff` decision per domain through the authorizer seam — the
Cedar schema gained the action with a `domain` context, the env-generated document grants it
(env.capability.default, mirroring the legacy authorizer), and a policy file can deny per domain.
Approval: the mint carries per-domain counts as the operator's evidence AND the freshness baseline
— the binding is `(kind, sessionId, sorted domains, policy version)`, with the version on the
token and in its fingerprint (a policy change invalidates outstanding approvals); count changes
survive, some-to-none refuses with `floor.handoff.freshness`; the human operator decides on the
existing non-act route, may attach a lease to the approval (validated and applied only after
marking), and the mint counts against the gate's capacity (QUOTA_EXCEEDED, pinned by test with a
tight gate). Completion: **mark before write** (a racing export is refused, never served unmarked
cookies), lease applied, every value registered as a session secret (phase 2's release valve —
`clearSessionSecrets` — is wired at session close), the RTC-removal init script injected
(all-frames; proven against a real browser in main document, synchronous about:blank iframe, and
window.open popup — plus a discriminator test proving the probe sees the constructor without the
script), the write through the engine's new optional `addCookies` (the `__Host-` conversion is
factored out and shared with create-time seeding; absent methods refuse ENGINE_UNSUPPORTED, never
silently skip), and an info audit with session/domains/counts/token/lease/rule ids only. FakeEngine
records writes, scripts, and now exposes seeds+writes through `cookies()`; the contract suite
asserts the optional methods. Afterwards: cookie/HTML/download export refuse
`HANDOFF_COOKIES_NOT_EXPORTABLE`; the shared Chromium launches with the WebRTC IP-handling policy
while the login browser is enabled (engine option from main.ts; argv asserted where the platform
exposes it — the login-suite pid-not-found skip precedent covers argv-hiding local setups). 12
api tests + 3 engine tests; workspace green. Deferred to phase 7: the SDK/CLI/MCP surfaces, the
guide, and the threat-model entry.

### Phase 7: surfaces and docs

- **SDK:** `client.sessions.cookieHandoff()`.
- **CLI:** `agentbrowser session cookie-handoff`; `agentbrowser operator login-browser
  open|close|reset`; `agentbrowser operator approve <token> [--lease hosts=…,minutes=…,actions=…]`.
- **MCP:** a `cookie_handoff` tool with an optional `approvalToken`, only where the mode profile
  carries the new `session.credential` capability (a protocol mode-profile change comes first).
  There are no MCP tools for operator routes.
- **`GET /v1/policy`** lists `cookie.handoff` grants per domain.
- **Guide, "Use your login safely":**
  - the threat boundary first: the agent must not run as the server's or the operator's OS user;
  - the supported layout: server and operator as one OS user, the agent as another, with no access
    to the operator's display;
  - on disk the profile is protected only by file permissions, and must stay out of synced and
    backed-up paths;
  - session cookies are dropped when the login browser closes;
  - the login browser and its profile;
  - operator keys and the keychain;
  - the exact `allowedHosts` rule;
  - classification rules and leases, with examples;
  - what is guaranteed and what is not (account authority, the residuals);
  - a one-time copy, with no local storage.
- **Threat model:** an entry for the handoff and the login browser. The operations docs gain the new
  variables.
- **ADR-025 status → Accepted** when phase 6 ships.

## Non-goals

- Reusing logins from an operator-started Chrome.
- Sync, write-back or refresh.
- Local storage or IndexedDB.
- Handoff into `cdpAttach` or remote-CDP sessions.
- Agent access to the login browser.
- Unattended handoffs.

## Risks

- **A hostile agent with a seeded session.** It holds the account's authority on the allowed hosts.
  Mitigations: the operator's handoff decision, exact hosts, reviewed high-risk and unknown actions,
  and leases the operator chose. The docs state this plainly.
- **An agent running as the server's or the operator's OS user** bypasses the boundary. Documented
  first; out of scope to prevent.
- **Residual egress paths:** POST redirect hops, worker WebSockets, WebRTC over TCP from workers, DNS
  prefetch, no DNS pinning, and pixels or console output. All documented.
- **Approval fatigue.** Leases and classification rules are the operator's tools, by design.
- **The persistent profile holds real credentials on disk.** Owner-only permissions, a documented
  location, and `reset`.
- **Public Suffix List freshness.** `tldts` is pinned and updated by Dependabot.

**Delivered (phase 7, #TBD-at-PR):** `session.credential` in the closed capability vocabulary
(flows into every browser profile by derivation; application stays fenced; revision stays 1 —
capabilities only grew). MCP `cookie_handoff` gated on it, dropped when bound, with the handler
catching APPROVAL_REQUIRED itself so the relay payload (token/domains/counts) reaches the agent
structured — the global error-details allowlist is untouched; catalog regenerated and
release-smoke pins the tool unbound-only. SDK `client.sessions.cookieHandoff()` with the typed
result. CLI `session cookie-handoff` (relay printout, never values), `operator login-browser
open|close|reset`, and `operator approve <session> <token> [--lease hosts=…,minutes=…,actions=…]`
(lease parsed client-side, validated server-side). `GET /v1/policy` carries the cookie.handoff
DEFAULT entry; per-domain answers are `policy check` with the domain as target (bare suffixes
refuse like the floor). Docs: the "Use your login safely" guide (threat boundary first), a
threat-model row + the accepted ADR-025 residuals, the three login-browser env vars in
operations.md as trusted operator configuration, and the four login routes' OpenAPI 400/409
(a phase-4 carried item closed). No MCP tools exist for operator routes. ADR-025 stands
Accepted; **TD-BROWSER-16 is complete.**
