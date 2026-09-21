# T6 C1 foundation: authority-bound review invalidation

Status: implementation slice before C1 operator-approval surfaces. Base: PR #240,
develop `4b9b155`. Load with forms/T6 and the [consent sequence](t6-reviewed-payload-consent.md).
See [validation evidence](../evidence/t6-review-authority-binding.md).

## Scope and shared owners

Control epoch is not a universal review version: repeated takeover in HUMAN_ACTIVE
does not advance it. Configuration can mutate state and throw before the old final
takeover. A later consent record must detect these invalidations without changing
delegation epochs, public ControlView, operation replay or adding another ledger.

SessionControl owns an opaque review version, rotated on live takeover (including
repeated human takeover), successful prepare-resume/delegation, review-invalidating
operator write admission and stop. Rejected transitions preserve it. Use a random
UUID rather than a numeric counter with overflow or a wall-clock timestamp. This
version conveys no permission and says nothing about page/payload freshness.

SessionAuthority exposes `reviewBindingInScope(sessionId)`: an immutable primitive
record containing tenant, session ID/incarnation, epoch and review version. It requires
a current admitted operator operation in HUMAN_ACTIVE, outside a configuration
callback. Scope closure, foreign sessions, agent admission, revocation and session
replacement refuse. The source is captured authority state, never caller identity.

Configuration invalidates the captured owner's review before its trusted synchronous
callback and takes over that same owner in finally, including on exceptions. A private
configuration marker prevents review capture during reentrant callbacks; nested
configuration restores its prior marker. A callback replacing the session cannot
make cleanup touch the replacement. Failed admission does not invoke the callback or
invalidate a different owner. Existing application composition remains the consumer
of configure; no alternate configuration service is introduced.

Deliberate compatibility delta: failed configuration also invalidates prepared resume
review and fences work started reentrantly by its callback. Such work drains under
the existing operation owner and refuses output; no rollback is claimed. Thenable
rejection reuses synchronousResult but cannot cancel asynchronous work already
started. These callbacks remain trusted and synchronous, not sandboxed.

## Acceptance and limits

Failing-first tests cover repeated takeover at unchanged epoch; all successful and
rejected control transitions; immutable operator projection; delegated/foreign/closed
scope refusal; session reuse; successful, throwing and nested configuration; and
replacement during configuration. Preserve existing epoch/replay and application
authorization suites. Do not publish an approval endpoint or advertise consent from
this stamp alone.

Next C1 slice still must enforce operator-selected reviewed mode, store a bounded
private action projection, distinguish pending/approved/consumed states, reconcile
response loss and project the service contract through REST/SDK/CLI. An agent holding
an operator key has operator powers; this is no proof of human presence. Page and
complete-payload witnesses remain separate C2/C3 requirements. No live submissions
or release changes belong to this foundation slice.
