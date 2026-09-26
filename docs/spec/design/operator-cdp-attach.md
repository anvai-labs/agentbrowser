# Operator Chrome attachment

Status: implementation candidate; Brief 3 / consumer F2.2. This is an explicit local
operator exception to [ADR-006](../../adr/006-network-egress-policy-ssrf.md), bounded by
[ADR-008](../../adr/008-process-container-isolation.md). It does not replace the isolated
session default or the existing remote-CDP browser-pool adapter.

## Contract and owners

The protocol adds only `cdpAttach?: boolean` to session creation. REST, SDK, CLI
`session create --cdp-attach`, and MCP `browser_create.cdpAttach` select the same
service path. Endpoints and egress acknowledgements are startup configuration only.
The coordinator forwards the selector without synthesizing launch options.

The packaged server requires both `AGENTBROWSER_CDP_ENDPOINT` and
`AGENTBROWSER_CDP_ALLOW_UNENFORCED_EGRESS=true`. Partial or invalid configuration
fails startup without echoing its contents. Endpoint parsing accepts only HTTP,
literal `127.0.0.1` or `[::1]`, an explicit port, and an optional root slash. There
is no endpoint discovery, request override, credential-bearing URL, or remote host.

The server freezes admission from its copied authentication map, explicit deployment
mode (`AGENTBROWSER_HOSTED`), and effective listener host. Hosted deployments,
missing bearer credentials, more than one authenticated tenant, non-loopback listeners/peers, and delegated
sessions refuse before connection. Multiple keys for the same tenant form one trust
domain; this does not prove one human operator. The request boundary also checks the
actual listener address so an embedding cannot declare loopback then bind a wildcard.
An unsupported adapter must refuse rather than ignore the selector.

The engine snapshots the endpoint and acknowledgement, reserves one attached session
(including pending connection), connects independently, and uses the existing default
context. `remote_cdp` continues to create a new isolated context. Only pages explicitly
created by the session and popups with an owned opener enter its page registry. No
existing operator tab is adopted. Reuse the same page implementation and resource
cleanup with explicit ownership; do not build another automation stack or session store.

Close releases owned tabs and the connection. It never closes the default context or
the operator browser. Failures and shutdown races release the reservation and only
resources allocated by that attempt. No automatic reconnect or mutation replay occurs.
Cookie export and seeding refuse because profile cookies are shared credentials.
Context launch overrides, per-session policy overrides, and download enablement refuse.

## Network semantics

The trusted startup acknowledgement explicitly accepts that the existing profile is
outside AgentBrowser network containment. Retain the effective session policy; do not
remove it in generic code. The service and attached page's common navigation path check
the initial explicit URL before dispatch, including action/plan navigation. This is
`navigation_preflight_only`, not an ADR-006 choke point or DNS pinning guarantee.

Redirects, subresources, click/form navigation, popups, workers/service workers, page
JavaScript, WebSockets, downloads and operator traffic are not contained. An
already-authenticated profile can exfiltrate data through those paths. Browser download
behavior remains operator-owned even though AgentBrowser download collection is denied.
Use isolated sessions when containment is required; use an external network perimeter
when operating this lane. No context-wide routes or init scripts are installed. The locked Playwright supports
`connectOverCDP(..., { noDefaults: true })`; this preserves the existing default
context download, focus and media settings rather than applying Playwright overrides.

Diagnostics extend the existing bounded schema: `attachment: cdp_attach`,
`endpointClass: loopback_http`, `resourceModel: operator_owned_browser`,
`context.isolation: existing_default_context`, `egress: navigation_preflight_only`.
Viewport/launch mode remain unknown and init scripts are not registered. Fixed warnings
persist in create/get/list. No endpoint, profile path, credential or raw connect error
is published. A dedicated profile is operator guidance, not an attested runtime fact.

## Qualification

TDD covers disabled/unacknowledged/hosted/multi-tenant/remote/delegated refusals;
endpoint parsing and sanitization; unsupported adapters; request forwarding; original
isolated-session policy retention; profile context ownership; unowned popups; close,
failed-connect and shutdown races; cookie refusal; and common navigation preflight.

The pre-commit smoke starts an independent Chrome with a disposable dedicated profile,
seeds a non-sensitive fixture marker in an unowned tab, and exercises the product
transports. It verifies shared storage, isolated page inventory, fixed diagnostics,
explicit URL refusal, detach/browser survival, and disabled configuration. Yahoo is a
live observation with a recorded title/status, not a deterministic unit fixture or a
promise that CDP attachment passes future site challenges.

## Upstream grounding

[Playwright CDP connection](https://playwright.dev/docs/api/class-browsertype#browser-type-connect-over-cdp)
exposes the default context and documents lower fidelity than its native protocol.
[Chrome remote debugging](https://developer.chrome.com/blog/remote-debugging-port)
requires a non-default user-data directory for regular Chrome remote debugging from
Chrome 136. The implementation must qualify the installed Playwright/Chrome pair; it
cannot assume new connection options exist in the locked dependency version.
