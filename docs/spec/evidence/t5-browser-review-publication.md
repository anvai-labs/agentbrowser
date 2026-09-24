# T5 A3c/A4b browser/review HTTP evidence

Base: develop `58e3605ca3aa6cfe1f25ae1e7921083a926af819` (PR #283).
Status: local candidate; exact-head review, required hooks and CI still pending.
Design: [browser/review publication](../design/t5-browser-review-publication.md).

Two actual HTTP tests failed first: browser status was still in flight at `onSend`,
and takeover in a late hook returned a response instead of terminating unsent output.
Both pass after migrating ordinary handlers to inert drafts and the existing publisher.
A separate failing-first test showed authority removal downgraded a controlled session
read to unguarded output; the fix reuses the service's retained controlled-context owner.

Another actual-HTTP regression showed admitted approval-required error details bypassed
publication and survived late takeover. The same error formatter now produces guarded
failure drafts inside admission; pre-admission static errors retain their existing mapping.

The shared context helper was adversarially tested with resolved/rejected async owner
callbacks. Both initially passed authorization incorrectly (one unhandled rejection);
the existing synchronous-result validator now refuses and consumes them, with sticky
refusal and a post-callback base-owner check.

The HTTP review matrix covers generation, inspection and decision, each revoked by
source permission, application permission, page replacement or newly sensitive data.
It proves no publication-time evidence recollection, no submission, status-only decision
replay and no execution record for review creation. Prepare-resume tests distinguish
serialization failure, same-owner collection failure and replacement-owner collection
failure. Browser tests independently cover held exclusion, fresh/replay facts, real
client abort and the actual ten-second deadline with deliberately late hooks, HEAD,
security/cache headers, controlled/legacy success and static validation errors.

The existing correlated-receipt test now asserts the new required drain-before-response
ordering. It observes the verifier signal expire, checks no output while its ignored read
remains admitted, checks duplicate in-flight status and busy exclusion, then releases the
read and verifies the unchanged conservative report. Injected setup fixtures wait one
event-loop turn after finish for authority release; no deadlines/assertions are weakened.

Real Chromium witness qualification revealed an execution-only reader guard inside the
fixture's source permission callback. Source permission now uses its existing policy and
generation; collection retains reader guards, and service-owned publication pins remain.
This clarifies the source contract rather than allowing closed execution scopes.

Durable metadata, process recovery, installed-harness qualification and new releases are
not delivered by this packet. T5 remains approximately 10%; 3/9 finite milestones are complete.


Independent transport parity compared base and candidate compiled servers over all
39 registered v1 routes: 38 bounded HTTP routes times legacy operator, controlled
operator and delegated agent = 114 fresh-session probes per tree. The sole WebSocket
route was explicitly excluded. Status, error code, top-level body shape, cache,
content-type and security headers had zero differences; there were zero setup errors.
HEAD and successful browser/review/application payloads are additionally covered by
focused and existing acceptance tests. This probe is not a stream-recovery claim.
