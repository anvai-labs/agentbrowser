# T5 A3b: bounded application HTTP publication

Status: implementation candidate on develop `89c20e6` (#282), pending review/delivery.
Parent: [finalization/publication](t5-finalization-publication.md).
Load only for the HTTP boundary. This packet does not complete A3 or A4b.

## Scope and owners

Adopt four existing routes together: application discovery, application execute
(including duplicates), application receipt lookup, and explicit operation status.
Mark them `publication: guarded` at registration and collect that metadata through
`registeredRoutes`. Other routes retain their current behavior. Application review,
approval get/decide, prepare-resume and the ordinary browser envelope follow in A3c;
the whole-inventory parity gate remains A4b.

`ApplicationAuthority` and `SessionAuthority` still own admission, deduplication,
execution finalization, permission/binding checks, publication deadlines and release.
Service methods only forward optional trusted publication arguments. Status uses
`publishOperation`, not a second record lookup or execution ticket. Existing execution
callbacks receive no response/reply capability.

One API transport helper owns request-local output guards and cancellation. No new
executor, journal, authority table, dependency or timer is introduced. The default
output deadline is 10 seconds, enforced by the existing authority publication owner.
It begins after execution/drain, not when the request arrives. This slice adds no
client-configurable timeout or durable acknowledgment.

## Delivery boundary

Attach transport cancellation before invoking the service. A request abort or response
close before `writableFinished` cancels publication only. Normal request-body completion
is not disconnect. Once the authority supplies a result, install its captured output
guard, attach deadline cancellation, and observe response completion using Node's
`stream/promises.finished` before invoking Fastify send. Await actual finish, then the
existing authority performs its final checks and releases its captured ticket.

The installed Fastify reply thenable is insufficient: `reply.sent` can become true at
`writableEnded` before `finish`, and it treats premature close as success. The final
route `onSend` is a synchronous callback after global hooks: assert the captured guard
and immediately continue Fastify's write without a promise gap. Auto-HEAD adds its
built-in synchronous body stripping after this hook; it cannot disclose a body.
Arbitrary custom streams, WebSockets or hooks that write directly to raw sockets are
outside this bounded JSON contract.

Guard refusal, deadline, premature close and serialization/onSend errors terminate
an installed publication by hijacking and destroying the response. Do not substitute
a late 409/500. Retain the request's closed guard for deliberately late hooks. An
adopted success without an installed guard fails closed. Pre-publication validation,
authentication and missing-record failures keep existing static error mapping.
No already-delivered bytes can be revoked.

Use the same transport owner for both execution and replay, with small inert body
mappers: fresh results retain their body; replay remains `{replay:true, operation}`;
an absent receipt remains JSON `null`; explicit status remains the bare record.
Status lookup now validates the operation ID through its existing owner (malformed
IDs return 400; well-formed absent IDs remain 404).

Execution outcome and delivery are distinct: completed business facts survive failed
output. A terminal operation can briefly remain `busy` through finish and final owner
checks. Real socket follow-up I/O occurs after those continuations; in-process `inject`
may resolve before release, so unrelated consecutive injected read assertions must
allow the existing continuation to settle rather than weaken exclusion.

## Acceptance and next gate

Failing-first real HTTP tests must show the old early release and fresh/replay disclosure
after permission revocation. Qualify terminal status with busy exclusion during a
paused async global hook, duplicate and explicit in-flight snapshots without a second
effect, control changes before actual send, serialization failure, real client abort,
the actual deadline and a deliberately late hook. Pin receipt-null, HEAD, security
headers, invalid-input and registration metadata parity using the existing counter
fixture and independent business state.

Review must challenge guard-to-write adjacency, response-finish ownership, listener
cleanup, error containment and replay shape. Keep the old route families explicitly
pending. No whole T5 completion or release is claimed by this packet.
