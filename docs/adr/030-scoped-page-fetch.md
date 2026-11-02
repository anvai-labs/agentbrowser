# ADR-030: Controlled origin-context API probes

Status: Accepted for the approved T10 handoff P0-2 increment; independent review
required before merge. Initial design 2026-10-30; preparation/lifetime refinements
2026-11-01 from [ADR-031](031-coordinate-interaction-and-visual-evidence.md).
Related: [ADR-006](006-network-egress-policy-ssrf.md),
[ADR-007](007-approval-tokens-side-effects.md),
[ADR-015](015-cross-package-contract-single-source-of-truth.md).

## Decision

Expose `page fetch` as a typed `fetch` action through the existing act transport,
controlled mutation admission, operation identity and durable act journal. CLI/SDK
convenience methods carry an explicit method, URL, bounded UTF-8 body and header
pairs. There is one dispatch and no automatic retry after timeout, cancellation,
transport loss or uncertain outcome. Operation records remain the reconciliation
authority; no parallel write journal is introduced.

The contained Chromium engine issues a fixed browser fetch function with
`mode: same-origin` and `credentials: same-origin` in an isolated world of the live
page, using its origin's cookies and supplied CSRF headers. Fix `cache: no-store`
and never grant the isolated world universal access. Opaque, inherited and other
unqualified document origins refuse. The
initial URL must match the live document origin and be an engagement testing
target. Asset/resource hosts do not become API probe targets. Unsupported engines
and unqualified CDP-compatible adapters refuse before input; no caller-supplied
JavaScript, Node HTTP transport or operator-CDP bypass is added.

Strict additive schemas retain unknown-field rejection. Browser-controlled
credential/transport headers, userinfo/fragments, malformed and duplicate headers,
GET/HEAD bodies and forbidden browser methods refuse. Request bodies are at most
64 KiB UTF-8, supplied headers at most 8 KiB, and returned response body at most
1 MiB with explicit truncation. The `truncated` flag covers any body, header or
serialized-envelope reduction. Return at most 32 response headers and 8 KiB of
header names/values; bound the serialized response envelope to 2 MiB. Stream,
slice and cancel before sending data over CDP, including decompressed content.
Reapply bounds after redaction. Body and header bounds apply to bytes as well as
schema shapes. Response status, bounded headers/body and truncation are typed,
redacted using the owning session's secret registry and marked untrusted. Apply
that registry before response, error, trace or artifact publication; global-only
redaction is insufficient for seeded cookie secrets. Bodies never enter ordinary
diagnostics or engagement ledgers. The private approval store can retain the exact
request for operator review; input/output files remain private evidence. Preserve
existing refusal of operator-reviewed registered secrets and vault references.
Private storage alone does not authorize a new secret-binding or disclosure path.

Response-policy admission must use authoritative transport headers and decoded
bytes read, independently of the displayed DTO. Never reconstruct a response-size
floor from truncated headers/body or redacted text: header-count reduction might
hide Content-Length, and Unicode repair can change the displayed byte count.
Preserve those private witnesses through the bounded browser/engine boundary and
check the existing response floors before any public result publication. Bound
the complete internal response envelope, including witnesses, before CDP too.
Browser Fetch exposes a filtered header view; it is not a complete raw transport
witness. Obtain required facts through trusted interception, or refuse a response
whose policy cannot be evaluated. Engine activation remains gated on qualifying
that admission path, rather than substituting the reduced public DTO.

The transport reader checks complete response headers before taking the body
stream and checks cumulative decoded bytes before retaining each chunk. Internal
transport bounds are 256 raw header rows / 64 KiB, 8 MiB decoded body and a
15-second maximum read lifetime; stricter policy or operation bounds win.
Cancellation and authority revocation bound header-policy and byte-policy waits
as well as CDP reads. Late stream acquisition closes the handle, and refusal
clears owned decoded buffers. HEAD and bodyless statuses still require header
admission and the zero-byte policy check. These limits are additional refusals,
not permission to truncate transport witnesses and evaluate a smaller response.
Native redirect pauses cannot supply a body stream in the qualified Chromium
build. Model their outcome explicitly as `redirect`: full header policy is
checked, while destination admission remains mandatory in the all-hop guard.
Fetch discards redirect bodies. As in the existing inspected redirect walker,
the actual-byte floor applies to terminal bodies exposed to the page; do not
claim to have measured a discarded redirect body or report a zero-byte witness
for it. A terminal response with no body still supplies the zero-byte witness.
Taking a stream irrevocably selects fulfillment or cancellation: a failed read
must never fall back to continuing the original response.

Activation also requires trustworthy request attribution. A page-wide active
probe flag or method/URL FIFO does not identify the prepared fetch: page timers
can issue indistinguishable concurrent requests. Such a flag cannot authorize a
route-policy skip or expand an unrelated request's transport privileges. An
internal claim must prove the actual network request received the complete
required admission. Competing identical-URL page traffic is a required negative
oracle before any new transport lane is enabled.

All network requests retain the outer scope, base, tenant and metadata policy
checks, shared budget, pacing, recording and immediate denial tracing. Redirects
cannot create new host authority. Scoped GET/HEAD fetch/XHR cross-origin redirects
refuse before the destination receiver, including the existing Node redirect
walker. Every method refuses cross-origin redirects, including a scope-allowed
destination that accepts CORS/preflight: CORS alone does not stop explicitly
supplied CSRF/custom headers from leaking on 307/308. Same-origin native chains
retain browser method/body semantics and all-hop policy.
Testing this must include allowed redirects as well as denied terminal receivers.
No interception/enforcement path is weakened to make a probe complete.
If the common scoped fetch/XHR redirect choke point is tightened to provide this
guarantee, document and test the effect on existing UI requests as a behavior
change, rather than presenting it as only a CLI convenience.

Preserve the existing inspected and native lanes. POST/PUT/PATCH use their
guarded native lane; DELETE/OPTIONS and other methods retain inspection and its
response-size floors. Bounded UTF-8 bodies require positive byte-exact receiver
oracles through each qualified redirect status; this does not qualify arbitrary
multipart bodies. In particular DELETE 301/302 preserves its method under Fetch
rules. A 303 permanently discards data and request-body headers rather than let
Route.fetch restore the initial body on a later hop. Extending native admission
requires separate all-hop, preflight, response-cap and worker qualification;
never move methods there merely to make a probe complete. Browser-generated
preflights must not receive injected markers before policy admission and must
remain distinct from explicit OPTIONS. Do not advertise arbitrary-method/body
fidelity until receiver oracles qualify the complete supported transport matrix.
HEAD must remain HEAD through 301/302/303 and mixed redirect chains too; the
bodyless walker must retain each hop's current method, rather than reset it from
the original request. Do not claim native `response.url`/`redirected` metadata when
the existing walker fulfills terminal bytes under an initial browser URL.

## Preparation, approval and lifetime

Preparation captures the exact engine page, main frame, immutable document/loader
and current origin before consent. A detached canonical request binds method,
URL, headers/body and limits to this evidence. An opaque prepared token conveys no
wire authority. Input remains excluded while a prepared or submitted fetch owns
the page, while ordinary input retains its existing concurrency outside that
window. Read-only setup cannot dispatch a request.

Policy denies remain authoritative before method classification adds a floor.
Unsafe methods require exact one-use transaction approval even if generic unknown
actions are allowed. GET/HEAD are method-convention reads, not a promise that the
server has no side effects; operator/session policies and credential-review floors
still apply. Required consent includes control incarnation, epoch and review
version so an unused old-grant token cannot survive takeover/regrant or a repeated
human takeover on an unchanged page. No action lease bypasses an unsafe-method
approval floor.

Immediately before the sole request dispatch, revalidate document/origin, request
identity and live authority after asynchronous approval/journal setup. Commit
consent only at that boundary through the existing controlled/durable act path.
Use a monotonic bounded lifetime for every awaited setup/read, session/page/document
cancellation and captured authority guards, including guard-only takeover changes.
Late setup results cannot resume input. Pin the isolated execution context so a
replacement document cannot inherit a pending call.

Once browser execution has been submitted, timeout, cancellation, close and raw
transport failures preserve their typed cause and carry explicit uncertain
dispatch metadata. Aborting waiting/reading cannot undo remote effects. Retain
page exclusion until an outstanding browser write actually settles; clear owned
mutable request buffers and discard retained request references on close, and
clean up isolated handles/listeners. This does not promise secure erasure of
immutable JavaScript strings or transport copies. A successful
response still does not authorize replay of an earlier unknown operation.

## Acceptance

The offline public-service/SDK/CLI equivalent of the Vinted probe sends an
authenticated PUT with the exact JSON body, session cookie and CSRF header through
a scoped session. A scope without PUT produces `SCOPE_METHOD_DENIED`, zero denied
receiver hits and a sealed ledger record. Host, redirect, budget and rate refusals
remain enforced and ledgered. Browser fetch must use the intended isolated-world
origin even when page scripts replace fetch/Headers or a document changes during
setup.

Co-located tests cover strict shapes and byte bounds, unscoped/unsupported refusal,
parameter mutation and approval binding, unused-token takeover/regrant, durable
operation-ID unknown/no-replay, same-URL reload/origin replacement, hung setup/read
cancellation, late completion, response truncation/redaction and cleanup. Include
decompression/escaped-envelope bounds, registered request/error/response secret
sentinels and wrong-tenant stream/artifact denials. Receiver
counts and bytes, rather than adapter reports alone, establish dispatch behavior.
Include same-origin DELETE 301/302/307 method/body receivers, allowed same-origin
PUT redirects, and a scope-allowed cross-origin 307 attacker receiver that accepts
the CSRF header through CORS: no request or supplied header reaches that receiver.
Live Vinted/Wolt verification remains pending operator verification.

Transport semantics follow the [Fetch standard](https://fetch.spec.whatwg.org/),
including its forbidden request headers and redirect method rules. Additional
credential and method-tunneling header refusals are deliberate product limits.
