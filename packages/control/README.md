# Shared session authority

`@agentbrowser/control` owns human/agent grants, operation admission, and optional
typed application operations. Its production dependencies contain the abstract
engine contract, core, and protocol; no browser adapter, browser driver, HTTP
server, model SDK, or database is required.

`ApplicationAuthority` accepts trusted adapters and the same `SessionAuthority`
used by browser work. `ApplicationSessions` supplies a separate bounded session
lifecycle when an embedding needs application operations without a browser.
The embedding authenticates principals before invoking these programmatic APIs.
Adapters are disabled by default. Only a matching operator in idle human control
can bind or unbind a tenant-authorized resource; changing it invalidates review.

Write operations require a caller-known ID and an expected application version.
The application owns authorization, atomic version checks, effects, and receipts.
The control plane suppresses duplicates but does not retry uncertain writes or
manufacture evidence that an application committed. A trusted adapter can report
a known rejection; malformed or lost results remain uncertain after dispatch.
Receipt reads require current scoped authority and share the admission lock.

This package currently exposes an in-process port. REST, MCP application tools,
operator binding UI, and application-persisted restart receipts are subsequent
qualification work. Existing browser interfaces retain their current behavior.
Session state is ephemeral; restarting the host does not restore grants.

Run `pnpm test:application-independence` after a workspace build to deploy only
production dependencies, reject browser packages or escaping dependency links,
and exercise delegation, a real application callback, duplicate suppression,
takeover, and receipt lookup from outside the source workspace.
