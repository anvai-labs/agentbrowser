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
Standalone `lookupReceipt` admits its principal once and delegates to
`readReceiptInScope`. Trusted composition already inside an admitted operation uses
the latter directly, avoiding nested admission. It keeps the business receipt ID
separate from the outer service operation ID and rechecks ownership, binding, adapter
authorization and cancellation before returning. An optional bounded read signal is
combined with session cancellation. The helper waits for adapter settlement; it does
not retry, release admission early, or turn arbitrary receipts into verified evidence.
Trusted adapters receive the authority-owned `sessionId` and per-registration
`sessionIncarnation` in `ApplicationScope`. Application idempotency and receipt keys
must include tenant, resource, session incarnation and the caller's raw operation ID
(or an application-owned equivalent); the textual session ID is trace provenance.
Binding generation is service-side admission provenance and must not replace session
incarnation in a durable receipt key: an authorized same-registration, same-resource
rebind can still reconcile the earlier application receipt. Incarnations are not
persisted, so this contract alone makes no restart-reconciliation claim.

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

`runVerifiedOutcome` composes an existing executor with trusted bounded evidence reads
and verification. Register outcome verifiers with `defineVerifier`: its synchronous
input parser runs once, before dispatch, against detached bounded JSON. The prepared
evaluator accepts only evidence, so later caller input changes cannot alter the expected
outcome. Direct `TrustedVerifierRegistry.evaluate` still accepts legacy definitions;
outcome execution requires their `prepare` contract and otherwise reports unsupported.
Invalid preparation blocks execution, while registered cleanup still settles. Trusted
parsers and predicates must be synchronous and pure. No production evidence source is
registered by default.

Run `pnpm test:application-independence` after a workspace build to deploy only
production dependencies, reject browser packages or escaping dependency links,
and exercise delegation, a real application callback, duplicate suppression,
takeover, and receipt lookup from outside the source workspace.
