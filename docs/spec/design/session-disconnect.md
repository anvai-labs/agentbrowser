# Typed engine-session disconnect evidence

Status: implementation candidate, R5b2. Extends the existing session lifetime owner
and bounded close-cause projection; it does not add recovery or a second registry.

## Observed fact and shared port

`EngineSession.disconnected?: AbortSignal` is an optional persistent, one-shot fact.
The adapter aborts it when the session's backing browser or context becomes unusable
outside intentional teardown. The signal's occurrence is the entire contract; its
`reason` is ignored and never published. Adapters without the port remain compatible
and make no classification promise.

The only newly produced public cause is `engine_disconnected`. Process exit, host
shutdown, transport loss and a user closing Chrome can produce the same observation.
None proves `engine_crash` or `operator_window_closed`. Closing a page, including the
last page, and passive page crashes remain page facts and leave the logical session
live when its backing context remains available.

## Resource owner

One Playwright observer owns named browser-disconnect and context-close listeners.
Install it when the context is acquired, before awaited setup; check the browser's
current connection state and the persistent signal before returning the session.
Failed setup disarms listeners and releases only owned resources. An existing operator
context receives the same observer without adopting its tabs or changing its policy.

Intentional close disarms synchronously before closing pages, context, browser or CDP
connection. Concurrent cleanup joins one close promise. External loss can trigger
best-effort adapter cleanup through that same owner, including release of the single
operator-attachment reservation. Shared-browser loss signals every affected session;
closing one isolated context affects only its owner.

## Coordinator composition

Capture the signal once during allocation. An already-aborted signal refuses creation
with a fixed error and releases the allocation without a public tombstone. Register
the listener against the captured session context and recheck the aborted flag so the
already-fired event cannot be lost. No await may split registration and publication.

The disconnect transition checks object identity before changing state, deleting the
live allocation, writing terminal facts, cancelling work or closing engine resources.
It uses a narrow internal path; ordinary terminate callers cannot inject a fabricated
disconnect cause. First terminal trigger wins, including explicit-close/expiry races.
Signal listeners are removed on every intentional terminal path and are never retained
in terminal records. The existing cancellation signal revokes authority immediately.

The legacy internal state remains `ENGINE_CRASHED` for compatibility; the public
terminal state and close cause are both `engine_disconnected`. The wire projection
must not turn the internal legacy spelling into an unsupported crash assertion.
Raw engine exception text is never evidence of a cause.

## Publication and qualification

REST, SDK, CLI and MCP reuse the existing bounded terminal projection and authorization:
matching independently authenticated tenant may read the 404 terminal envelope; a wrong
tenant receives generic not-found; revoked delegated credentials receive no facts.
Reconciliation must not mislabel a disconnect as session expiry. No endpoint, capability,
retry, reconnect, action replay or durable storage is added.

Failing-first tests cover initial and registration races, context/browser loss,
intentional disarming, exact listener cleanup, shared-browser fanout, last-page close,
single cleanup ownership, stale textual-ID reuse, cancellation, retained cause and
lease, and transport authorization. The headed smoke uses a disposable Chrome process
owned by its fixture, closes a page without killing the session, then terminates that
process and reads the resulting cause through the product interfaces. It cannot infer
operator intent from that event. Delegated cancellation and cross-tenant denial are
qualified separately on isolated sessions; operator CDP permits one trust domain and
refuses delegated sessions. Its headed smoke checks owner and missing credentials.
