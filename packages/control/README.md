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

This package exposes an in-process port; v1.8.20 also provides application binding,
discovery, execution and receipt lookup through REST, SDK and the first-class CLI.
AgentBrowser 1.9.0 adds business receipt correlation, admitted receipt drain, generic
generation-fenced evidence permission and application-bound receipt composition. Its
candidate qualification covers a controlled G4 fixture, not a production source or G6.
MCP application tools, operator binding UI, and application-persisted restart receipts
remain subsequent work. Existing browser interfaces retain their current behavior.
Session state is ephemeral; restarting the host does not restore grants.

Trusted composition can call `prepareReceiptReadInScope` before dispatching its
existing executor. Preparation validates the live admission and application binding
without reading a receipt or marking a write. The frozen reader identity contains the
authority-owned adapter, resource, session ID/incarnation and `SessionAdmission`.
`admissionInScope` exposes the same immutable actor/tenant/mode snapshot for that ticket;
agent identity must match the stored grant, and operators have no delegated mode.
Each reader check and read requires that original active admission and binding, checks
authorization around I/O, and combines a fresh per-read deadline with session cancellation.
Observed authority failure permanently invalidates that reader. It does not detect
unobserved permission revoke/regrant cycles: the delegated predicate policy needs
its own versioned permission fence, composed by the evidence helper below. Both existing receipt helpers reuse this preparation.
These helpers establish identity and preflight, not permission for browser modes to
receive application-derived evidence.

Receipt I/O is registered with `SessionAuthority.trackReadInScope` before its callback
starts. This helper is for read-only observation; writes must settle inside `run`.
If a verifier deadline returns while an adapter ignores cancellation, the
response can still report unknown verification, but the original ticket remains busy
and its operation record stays `in_flight` until the receipt settles. The completed
response closes all scope-derived authority immediately; a late continuation cannot
dispatch, read evidence, or register more work. Duplicate operation IDs replay the
in-flight record, and other operations and resume review remain blocked. Settlement
preserves the response's execution classification; intervening revocation makes a
dispatched operation `outcome_unknown` and an undispatched operation `failed`.
Only explicitly tracked I/O receives this guarantee. Generic evidence callbacks,
cleanup and engine work are not automatically tracked. A never-settling receipt keeps
a live session busy until host removal/TTL; removal cannot make external I/O settle,
and old work remains fenced from a replacement session incarnation.

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

Evidence sources that read business receipts declare `correlation: 'required'` in their
trusted descriptor. The runner requires a bounded `evidenceCorrelationId` before dispatch
and supplies it as the third argument to `read(context, signal, correlationId)`. A prepared
reader captures that ID once for every poll; direct registry reads use the same validation.
An absent ID for a correlated source or a supplied ID for an uncorrelated source is
unsupported. The ID selects application evidence; it does not confer authority or replace
the outer operation ID. Use `readReceiptInScope` for receipt reads within existing admission
and derive tenant/resource/incarnation from authority, never from the correlation string.
This low-level helper does not grant delegated browser modes application access. A
production receipt source must enforce an explicit permission/declassification policy
before delegated plan dispatch; the operator fixture is not that policy.

Sources requiring predicate-specific permission declare `authorization: 'required'`
and provide synchronous `authorize(request)`. The request contains the captured source
descriptor, exact verifier ID/version, bounded frozen raw verifier input, correlation
ID when present, and host-owned context. The parser receives a separate input copy.
Returning `{ generation, currentGeneration }` grants that prepared reader permission;
missing, denied, throwing or asynchronous policies block before dispatch. Generations
are nonnegative safe integers and must increase on every permission change, including
regrant. A detected change or failed check permanently invalidates that reader.

`prepareRead` remains callable and exposes `assertAuthorized()`. Protected reads check
permission before and after I/O; the runner also checks around execution, evaluation
and final output after cleanup. Cleanup still runs on denial/revocation. Caller changes
cannot replace the captured host authority, signal, executor or result provenance.
Existing sources without an authorization declaration retain their prior behavior.
Generic context remains a trusted host reference: an application source must compose
the immutable admitted identity and receipt reader before claiming tenant/resource/mode
isolation. This generic gate does not grant browser modes raw application access,
register a production source, or establish a causal UI-to-commit relationship.

`defineApplicationReceiptEvidenceSource` supplies that application composition. It
requires correlation and an explicit synchronous policy over frozen source/verifier/raw
input plus authority-owned admitted actor/tenant/mode and application identity. The
policy receives no host context or receipt method. Each prepared read privately captures
its own guarded receipt closure; no cross-session reader cache is used. Application
and generation authority are checked before execution, around receipt/reference work
and before final publication after cleanup. An absent receipt remains pending.

The registry's additive `{ kind: 'authorized_access_v1', permission, access }` result
keeps opaque access private to one prepared read and its paired source callback. Existing
permission-only source definitions and three-argument readers remain valid. These are
trusted constructor interfaces; callers use the registry's guarded read/preparation API.
The service offers an optional synchronous `evidenceSourceRegistryProvider` with a
frozen `applicationReceipt(config)` builder. It is mutually exclusive with a prebuilt
registry and exposes no raw application authority. No request field or CLI command
changes. This qualifies scoped observation, not a causal UI-to-commit relationship;
see [application permission evidence](../../docs/spec/evidence/t2-application-evidence-permission.md).

Run `pnpm test:application-independence` after a workspace build to deploy only
production dependencies, reject browser packages or escaping dependency links,
and exercise delegation, a real application callback, duplicate suppression,
takeover, and receipt lookup from outside the source workspace.

The internal `openOperationJournal` facade and journal types establish a storage-neutral
transition contract. Trusted composition supplies fixed namespace metadata, fingerprint
key material and an exclusive atomic adapter. The facade validates bounded snapshots and
ACKs, retains actual I/O through caller timeouts, and quarantines uncertain writes.
The test-only memory adapter/conformance suite proves model behavior, not persistence.
No service option or SessionAuthority integration enables durability yet; see the
[journal design](../../docs/spec/design/t5-journal-contract.md) for C1–C4 and J2–J4 gates.
