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

Authority guards require a registered live owner. Hosts supporting uncontrolled
sessions must choose that path explicitly, rather than infer it from a missing
authority entry. Active IDs cannot be registered twice, and captured page guards
remain tied to the original owner after removal. `ApplicationSessions` enforces
monotonic deadlines at admission, dispatch and output and releases expired
capacity even if cleanup timers have not run. A custom `SessionAuthority`
registration may supply `ttlMs` and an `onExpire` callback; that callback is where
the embedding aborts its owned work and frees its lifecycle resources. The
authority cannot abort a caller-owned `AbortSignal` itself.

Application inputs are bounded during canonical serialization to 64 KiB UTF-8,
4,096 nodes (including object keys), and depth 16. Only own JSON data is accepted;
accessors, sparse arrays and non-JSON values are rejected. Serialized input is
reused for write fingerprints, with separate bounded metadata. Reads do not
compute a write fingerprint. Business receipts remain application-owned.

Run `pnpm test:application-independence` after a workspace build to deploy only
production dependencies, reject browser packages or escaping dependency links,
and exercise delegation, a real application callback, duplicate suppression,
takeover, and receipt lookup from outside the source workspace.
