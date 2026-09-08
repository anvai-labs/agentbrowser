# M2 design: authenticated session gateway

Status: **M2 complete in PR 103; T2c1 implementation and acceptance in progress.**
The [M2 closeout](https://github.com/anvai-labs/agentbrowser/pull/103#issuecomment-5579683896)
records both clean reviews, all eight PR checks, and merge `46807ea` to develop.
The owner subsequently authorized T2c1 only: policy adaptation and shared TCP
admission with failing tests first. The original design boundary below remains
historical; it does not prohibit that separately authorized implementation.
One documentation-only unit from develop. The owner reports the v1.8.5 Homebrew
upgrade and service restart complete; this is not a new installed-server
acceptance run. This document specifies future implementation, not passing
runtime evidence. It authorizes no listener, browser integration, deployment,
package extraction or release. R4/T1 remain open.

## Outcome and PR boundary

The shipped [connection authority](connection-authority-design.md) supplies
request-authorized TCP leases for downloads. M2 specifies how an authenticated
gateway can reuse those mechanics without pretending a TCP destination is an
HTTPS request. One PR contains this design, tracking links and the release
checkpoint. M2 closes only after independent design review and exact-head
eight-check PR CI, followed by merge to develop. No main promotion or release
is needed for documentation alone.

| ID | Resolved decision | Implementation proof required |
| --- | --- | --- |
| G1 | Private strict HTTP/1.1 CONNECT profile over public Node TCP APIs; trusted synthetic client first | Byte grammar, fragmentation, early-data rejection, transition and failure matrix |
| G2 | Per-generation opaque Basic credential; trusted in-process issuance | Strict encoding, instance binding, expiry, replacement and secret hygiene |
| G3 | Immutable destination policy distinct from request policy, with explicit TCP-only coverage | Built-in and custom adaptation cannot fabricate URLs or discard restrictions |
| G4 | Session-owned admission; credential-owned tunnels; synchronous revocation before teardown | Races at every callback boundary; closure distinct from external callback drain |
| G5 | Bounded indexed registry, pre-auth sockets and joint download/tunnel admission; no queue | Saturation, unresolved work, backpressure and finite cleanup tests |
| G6 | Private API composition, pure policy rules, no new shared package yet | Existing layering checks; no sockets or credentials in public/neutral surfaces |
| G7 | Deterministic ownership tests plus real TCP/TLS positive and negative controls | Independent upstream counters, secret checks and unchanged download regressions |
| G8 | Three sequential implementation units, with a usable consumer before release | T2c1 prerequisites, T2c2 data plane, T2c3/M3 opt-in lifecycle and delivery |

All limits and interfaces below are design requirements, not current behavior
or measured capacity. Implementation may discover a necessary revision: change
this contract with evidence and renewed review, not an undocumented exception.

## Trust and responsibility boundaries

```text
Trusted service/session owner -- issue/revoke --> Gateway generation registry
Trusted client -- credential + CONNECT -------> Gateway data plane
                                                   |
                                       destination policy + TCP lease
                                                   |
                                         verified upstream address
```

First mode is explicit opt-in, bound only to `127.0.0.1` on an OS-assigned
port. No wildcard, dual-stack, proxy-environment discovery, remote bind or
cross-container deployment is implied. Loopback does not contain hostile local
processes. Off-host use requires a separately approved protected control/data
channel and exposure model. Origin TLS does not encrypt proxy credentials.

The first supported consumer is a trusted Node 22 client using public
`node:net`, then `node:tls` after the complete CONNECT success response.
Acceptance records the exact tested Node patch; version-specific Node 22.11.0
documentation is a reference, not evidence for a different installed patch.
No browser, curl, generic proxy, pooling, retry, HTTP/2, forward HTTP, SOCKS,
UDP, proxy chaining or TLS interception compatibility is promised.

The control plane is an in-process capability, not a REST endpoint on the
listener. Gateway credentials confer no session administration, artifact
access, policy mutation or issuance. Never reuse API bearer keys.

CONNECT authorizes a TCP destination, not an HTTPS URL, origin identity,
redirect count, response size or WebSocket verdict. The client owns origin TLS;
an allowed port 443 tunnel can carry other protocols or reach multiple origins
served at that endpoint. Request semantics require T1/T3; bypass prevention
requires T4. A gateway alone does not close R4.
See [RFC 9110 CONNECT](https://www.rfc-editor.org/rfc/rfc9110.html#section-9.3.6).

## G1: exact wire profile

Use one small bounded byte-level CONNECT prelude parser over `node:net` with
`pauseOnConnect: true`. Charge the inbound socket and attach close/error
ownership before parser allocation or reads. Do not combine a shadow parser
with the general HTTP server. Node's retained-header limit is not an actual
raw-field rejection limit; upgraded sockets also need explicit lifecycle
ownership. See the pinned [TCP API](https://nodejs.org/download/release/v22.11.0/docs/api/net.html)
and [HTTP API](https://nodejs.org/download/release/v22.11.0/docs/api/http.html).

Accepted shape:

```text
CONNECT <authority> HTTP/1.1\r\n
Host: <authority>\r\n
Proxy-Authorization: Basic <token>\r\n
\r\n
```

- Request line has exactly those method/version tokens and single spaces.
  Framing is CRLF only. No leading blank lines, bare LF or folded fields.
- Exactly one Host is required. Header names are case-insensitive ASCII tokens
  immediately followed by a colon; trim only edge SP/HTAB from values.
  Only Host and Proxy-Authorization are permitted, in either order.
  Missing authentication is 407; duplicate fields, including case variants,
  are 400. All other fields are 400, including Content-Length even zero,
  Transfer-Encoding, Expect, Connection, Upgrade, Authorization and identity
  selectors. There is no automatic 100 Continue or second request.
- Validate octets before decoding: reject non-ASCII and controls except the
  specified CRLF delimiters and value-edge SP/HTAB. Do not let an ASCII decoder
  clear high bits. Count the complete prelude including request line and final
  delimiter: at most 8,192 bytes and 32 raw fields, within five seconds of
  acceptance. A bounded buffer and linear scan reject an oversized input chunk
  without copying the entire chunk into application storage.
- Authority requires an explicit canonical decimal port 1–65535 without
  leading zeroes. IPv4 is canonical dotted decimal. IPv6 is bracketed and
  valid, with address comparison reusing existing mapped/expanded IP identity
  rules. DNS is lowercase-normalized ASCII LDH labels, each 1–63 characters,
  total at most 253, no empty labels, trailing dot or edge hyphen. Reject final
  labels matching decimal digits or `0x[0-9a-f]+` case-insensitively to exclude
  legacy numeric-host interpretations; malformed IPv4 must not fall back to
  DNS. ASCII punycode is literal input, not an implicit Unicode conversion.
  Reject zones, escapes, userinfo, paths, queries, fragments and controls.
  Host uses the same parser and must match normalized hostname **and port**.

After the delimiter, coalesced extra bytes cause rejection before authentication,
policy, DNS or dial. Keep a pre-open read guard active through asynchronous
setup. Extra bytes observed during policy/DNS/dial cancel the attempt and
forward **zero application bytes**; DNS or an upstream TCP accept may already
have happened. Pausing and later forwarding accumulated early input is not
compliant.

After a verified lease arrives, synchronously recheck session/credential
authority, deadlines, socket state and already-observed pending input, then
commit open and enqueue exactly
`HTTP/1.1 200 Connection Established\r\n\r\n`, with no await or
external callback between the final check and commitment. Neither Content-Length
nor Transfer-Encoding is sent. Failure during or after this commitment is
close-only, even if the client received only part of the response.

Only post-commit input becomes opaque tunnel data. The trusted client waits
for the complete response before starting TLS: at most 8 KiB of response headers
and a 20-second monotonic handshake deadline from starting the loopback dial,
capped by its known remaining credential lifetime. It destroys the connection
on malformed/non-200 response or timeout, with no retry. It preserves any
coalesced post-response bytes without counting opaque data as header bytes.
The server cannot determine when bytes observed
after commitment were transmitted by the client; no remote-send-time guarantee
is made. Proxy headers are consumed locally, never sent upstream.

## G2: credential contract

Choose Basic for this narrow trusted client, not as proof of browser support.
An ID is 16 independent cryptographically random bytes rendered as 32 lowercase
hex characters; a secret is 32 further random bytes rendered as 64 lowercase
hex characters. Decoded credentials are exactly `id:secret`: 97 ASCII bytes.
Accept a case-insensitive Basic scheme, one SP, then canonical standard Base64:
132 characters including terminal `==`, exact decoded grammar/length and
re-encoding equality. A permissive Base64 decoder is not validation.
See [Node encoding behavior](https://nodejs.org/download/release/v22.11.0/docs/api/buffer.html#buffers-and-character-encodings).

The registry stores a domain-separated SHA-256 verifier over unambiguously
length-delimited instance ID, credential ID and secret, not a raw secret.
Compare fixed 32-byte verifiers using timingSafeEqual, including a dummy
comparison on lookup miss. This does not make the entire authentication path
constant-time. Generate a fresh random 128-bit gateway instance ID on start;
IDs are never intentionally reused. Retry a registry ID collision at most three
times, then fail registration without publishing credentials.

Trusted issuance takes an opaque owned session handle, derives identity and
immutable policy, and returns the secret once to an in-process trusted client
handle. Wire input never selects tenant/session/generation. No secret enters
page JavaScript, observations, CLI arguments, URLs, SDK/MCP responses, traces,
metrics or logs. Registry restart invalidates all previous credentials.

Missing, malformed, unknown, wrong, expired, revoked and other-instance
credentials receive the same bounded 407 and
`Proxy-Authenticate: Basic realm="agentbrowser-gateway"`.
Structural wire failures remain 400. Authentication precedes policy callbacks,
DNS and dialing; a valid credential can authorize only its bound session.
A stolen valid A credential still authorizes A until revocation/expiry: no
sender-authentication or replay-prevention claim. Basic is encoding, not
encryption; this first profile is trusted-local only.
See [RFC 7617](https://www.rfc-editor.org/rfc/rfc7617.html).

## G3: immutable policy without invented requests

Conceptual internal contract; these are not new exported runtime interfaces:

```ts
type Destination = Readonly<{ hostname: string; port: number }>;

interface DestinationPolicy {
  checkDestination(destination: Destination): Promise<void>;
  checkResolvedAddresses(addresses: readonly string[]): Promise<void>;
}

interface GatewayPolicySnapshot {
  readonly requestPolicy: RequestPolicy; // actual URL required, as today
  readonly destinationPolicy: DestinationPolicy;
  readonly coverage: 'tcp-destination-only';
}

interface GatewayPolicyProvider {
  snapshotForGateway(): GatewayPolicySnapshot;
}
```

Both policy views are captured from one immutable configuration generation
before credentials are published. Gateway-enabled session creation explicitly
selects this capability even when downloads are disabled; it must not enable
downloads. Do not retrofit an existing mutable-policy session by taking a fresh
gateway-only snapshot. Policy change requires close/recreate under the current
contract, not live mutation or credential rotation.

The built-in adapter is allowed only for the exact built-in NetworkPolicy
with no overridden instance hooks. It preserves loopback/private/metadata and
resolved-address restrictions and adds a trusted destination port allowlist:
default `[443]`, at most 64 unique explicit ports. A gateway allowlist must
not change direct-download port behavior. Share the pure SessionHostPolicy
matching predicate across the views: operator/base restrictions and session
host restrictions intersect, retaining existing exact/suffix, deny-first and
empty-allowlist semantics. No duplicate policy rule implementation.

Request view still applies real URL, redirect and response/body semantics.
TCP-only coverage is an explicit opt-in limitation, not a claim to enforce
those request rules inside a tunnel. Built-in request accounting limits stay
with request consumers; gateway lifetime/buffering limits are separate.

A custom subclass, overridden hook or custom request policy requires an explicit
gateway-capable snapshot provider; the existing download snapshot alone is
insufficient. Custom URL/path or mandatory response/body restrictions require
a conservative whole-destination denial or rejection of gateway registration.
Declaring TCP-only coverage cannot silently waive such a restriction. Never
strip the policy to its base configuration or pass a fabricated
`https://host/` URL. Unsupported gateway policies fail before credential
issuance, without changing download-only sessions. Freezing an object does not
freeze captured mutable state: providers are trusted extension code with
mutation/isolation contract tests, not a sandbox for hostile callbacks.

The shared authority is constructed in one fixed authorization mode:
request mode accepts actual URL/host/port and binds RequestPolicy; tunnel mode
accepts only host/port and binds DestinationPolicy. Discriminated input must
reject a mode mismatch at runtime, not merely rely on a TypeScript cast.
Both reuse one implementation for full DNS-answer validation (at most 16),
literal-address dial, canonical peer verification, cancellation and lease
ownership. No second resolver, unchecked lookup, verdict cache, pooling or
upstream retry. Neutral policy types must not import sockets or API modules.

## G4: ownership, revocation and terminal behavior

Generation: `reserved -> active -> revoked -> drained`.
Tunnel: `accepted -> authenticated -> authorizing -> connecting -> open -> closing -> closed`.
Failure may move any nonterminal state to closing; no terminal state reopens.

One trusted service owns the runtime registry. Session identity, gateway
credential generation and private download generation are distinct.
Registration reserves a bounded registry record before invoking extension
code, captures the session's policy, attaches cancellation, then rechecks
authority before atomically publishing the credential. On any failure, publish
nothing and release only fully drained ownership. The current coordinator
allocates cancellation after asynchronous engine creation: use the established
session seam for the synthetic consumer, not as browser first-request admission
proof. Earlier browser admission belongs to T1/T3.

The session owns joint TCP admission. Each credential generation owns its pending
attempts, client sockets and leases. Authentication-to-ownership attachment and
the revoked/expired check occur synchronously; no await may leave an admitted
socket unowned. Unauthenticated sockets remain listener-owned. Session close
first closes joint admission and revokes every child generation/authority,
then proceeds with browser teardown.

Revoke is synchronous and idempotent: remove authentication lookup first,
cancel pending work, destroy both endpoints of every owned tunnel, and prevent
late results from emitting success. Repeated revocation does not double-release.
Credential replacement revokes the old generation before publishing another;
there is no overlap grace period. If replacement fails, the old credential
stays revoked. Replacement uses the same session admission owner and unchanged
policy, never a new budget or download generation.

| Race / event | Required outcome |
| --- | --- |
| Session closes during registration or extension callback | No credential publication; retained work remains charged until settled |
| Revoke during policy, DNS, dial or peer verification | Prompt caller cancellation; late socket destroyed; no 200; external callback slots retained until settlement |
| Revoke at success write, backpressure or half-close | Destroy both endpoints immediately; no second HTTP response |
| Credential replacement while old work is unresolved | Old work keeps its session/runtime and registry charges; new credential cannot reset either cap |
| Session A closes while B is active | A's admission closes; B's identity and legitimate owned work remain independent |
| Shutdown during any stage | Stop accepts/issuance, revoke all, destroy sockets, report socket closure separately from pending callbacks |

At issue, derive an absolute monotonic deadline from the smaller of the trusted
remaining session TTL and 30 minutes. Reject nonpositive lifetime. Check the
deadline at authentication, each asynchronous boundary and success commitment;
owned timers end live tunnels. Session cancellation also revokes immediately
when observed. Traffic does not refresh coordinator idle activity or extend
a credential. Its absolute deadline does not turn lazy/sweep-driven coordinator
idle expiry into a strict idle scheduler. Event-loop stalls are not hard
real-time guarantees.

Normal EOF half-closes the other write side and drains only already-buffered
bytes, with at most one second in closing; stop admitting further application
data on either side. Errors, revoke, expiry and shutdown destroy both sides
immediately. Pending callbacks are not declared cancelled merely because their
callers rejected. Shutdown waits at most one second for owned socket closure,
then reports any remaining sockets/callbacks without waiting forever; late
cleanup retains ownership and cannot reopen admission.

## G5: selected bounds, accounting and diagnostics

| Resource | Initial ceiling / deadline | Charge and release owner |
| --- | --- | --- |
| Accepted client sockets including unauthenticated | 64 per runtime | Listener; charge before parser state, release only on close; overflow socket immediately destroyed without response allocation |
| Reserved, active and retired gateway generation records | 64 per runtime | Registry; remove auth lookup on revoke but retain record until callbacks and sockets drain |
| Prelude | 8 KiB, 32 actual fields, 5 seconds from accept | Fixed bounded parser; overflow 431, incomplete deadline 408 |
| Pending plus active TCP attempts | 8 per session, 32 per runtime jointly across downloads and tunnels | Shared session/runtime admission; reserve before policy/DNS/dial, no waiting queue |
| DNS / setup | 16 answers; 10 seconds capped by remaining authority lifetime | Existing connection mechanics; one resolution and one literal dial |
| Credential | Session remaining TTL or 30 minutes, whichever is smaller | Registry-owned deadline; no data-plane renewal |
| Open tunnel idle / hard lifetime | 60 seconds / 10 minutes, capped by generation expiry | Tunnel owner; reset idle only on successful write callbacks for positive application bytes in either direction, not input or enqueue; no remote-consumption claim |
| Application relay buffer | 64 KiB high-water target per direction | Streaming backpressure; never accumulate whole streams; measure chunk overshoot |
| Rejection / orderly closing / shutdown socket wait | 1 second | Owned close timer, force destroy on expiry; report incomplete drain |
| Diagnostics | Fixed counters; at most one terminal record per admitted tunnel, 1 KiB serialized maximum; runtime token bucket 32 records/second, burst 32 | Drop/count on saturation; no log queue, secrets, payloads or attacker-keyed labels |

These are safety ceilings for the first implementation, not performance targets.
Trusted configuration may tighten but not silently exceed them; validate finite
positive safe integers, timer representability and explicit unique port values
before binding. Local fixtures can allow explicit fixture ports. Stream high-water
marks and a fixed parser buffer are not hard process/kernel memory bounds;
record observed relay overshoot and concurrency in real fixtures. No OS CPU,
RSS or socket backlog containment is claimed.

Conceptual shared admission:

```ts
interface TcpReservation { release(): void } // idempotent; actual drain only
interface SessionTcpAdmission {
  reserve(): TcpReservation; // synchronously charges session AND runtime
  closeAdmission(): void;    // rejects new work, retains outstanding charges
}
interface RuntimeTcpAdmission {
  createSessionScope(): SessionTcpAdmission;
}
```

Use one runtime TCP root and one session scope across both consumers.
Reservation is atomic, without awaits or extension callbacks between the two
counter charges. On local denial or setup failure, release exactly once after
owned work drains. A closed socket does not release a pending external callback's
reservation; cancellation retains charges until that work settles. Old session
scope references survive only through outstanding bounded ownership, not an
unbounded tombstone registry.

Preserve the independent existing download transfer limits (8 local, 32 runtime)
and 30-second transfer deadline. A stalled transfer continuation remains charged
even after TCP closes; TCP and transfer slots are different resources. Inject
joint TCP admission into downloads rather than introducing a second 32-slot
gateway pool. Download-only policy and default behavior otherwise remain intact.

Use credential-ID and session-ID Maps, plus per-owner Sets of attempts and
sockets. Revoked credential lookup disappears immediately; its retained owner
still consumes one of 64 records until drain. Remove drained records without a
historical failure map or cache. All accepted socket setup, including auth
failure, stays under the 64-client cap. Connection churn and trusted extension
CPU are not hard process-level rate/resource guarantees.

Diagnostics use fixed stage/outcome labels and bounded opaque internal IDs,
never destination/header/credential values or raw external errors. Failed auth
is aggregate-only. Every admitted tunnel gets one internal terminal outcome;
emitting its record is best-effort within the size/rate bounds. Logger exceptions
cannot interrupt cleanup; no async logging backlog. A blocking trusted sink
remains an explicit event-loop limitation.

| Failure before success commitment | Wire action |
| --- | --- |
| Malformed or out-of-profile request | 400 |
| Missing/invalid/unknown/expired/revoked credential | 407 plus fixed Basic challenge |
| Destination or resolved-address denial | 403 |
| Incomplete prelude timeout / byte or field overflow | 408 / 431 |
| Authenticated admission capacity exhausted | 503 |
| Setup deadline | 504 |
| Other setup transport failure | 502 |
| Unexpected internal invariant failure | 500, plus bounded internal diagnostic |
| Pre-parser client capacity; revoke; disconnected peer | Close; no response required |

Failure responses have fixed generic reason text, Content-Length: 0 and Connection:
close, with no reflected input. Map existing typed errors centrally at the
wire boundary; do not fork the taxonomy or leak resolver/parser/socket errors.
After any success commitment, only close—never append an HTTP error. An
unsupported custom policy is a trusted registration error, not a late 407.

## G6: package and future process boundaries

Keep the first same-runtime gateway's wire and ownership code in cohesive
private API modules; policy owns reusable host/address predicates. Core sees
lifecycle abstractions, not sockets. Protocol, SDK, MCP and CLI gain no raw
transport types or gateway credential fields from the internal prerequisites.
Engines never import API. Extract a narrowly named shared transport package
only with an actual second package/runtime consumer in the same reviewed
change, not to anticipate one.

Combined admission is explicitly same-process. A future external gateway needs
a real shared accounting owner or honestly separate per-process caps.
Its control protocol must acknowledge registration, make revoke idempotent,
roll back interrupted registration and invalidate generations/live tunnels
on channel loss. Never fall back to direct networking or merely reject the
next CONNECT. This is a future process-boundary contract, not a new RPC endpoint.
The scoped ADR-008/T4 forced-egress path remains required for containment;
full multi-tenant isolation remains deferred.

## G7: falsifiable implementation acceptance

These are required future tests, **not passing results**. Every network-denial
fixture has an explicitly permitted positive control and independent upstream
TCP-accept and application-request counters. Deterministic hooks control races;
real sockets validate the behavior mocks cannot establish.

| Owner / boundary | Positive control | Falsifying negative or race |
| --- | --- | --- |
| Wire parser | Valid request split at every delimiter boundary | Duplicate Host/auth beyond retained-header thresholds; non-ASCII aliases; body/framing/authority violations; oversized and slow input; no 100 Continue or second request |
| Early-data guard | Client waits for full 200, then TLS succeeds | Coalesced extras: zero policy/DNS/dial; delayed extras at suspended policy/DNS/dial: zero application forwarding, no 200, eventual close |
| Credential registry | Active credential reaches its bound policy | Strict Base64 negatives, wrong secret, stale/other-instance credentials, forged identity fields: zero external policy/DNS/dial; no reflected/logged secret |
| Policy snapshot | Built-in allowed host/port and explicit local fixture address | Mixed denied DNS answers, alternate IP identity, denied port, unsupported URL-only custom policy: no upstream accept; custom policy cannot weaken base/session intersection |
| Snapshot isolation | New session sees updated config, established views do not | Mutating captured config, custom hooks without capability and gateway with downloads disabled; no fake URL or accidental download enabling |
| TCP authority | One lookup, literal dial, verified canonical peer | Rebinding on next attempt, peer mismatch, same-host sessions; mode mismatch rejected; no unverified socket handed off |
| TLS client | Logical hostname certificate verifies through opaque tunnel | Wrong certificate fails at client; proxy credentials absent at origin; preserve coalesced response bytes |
| Generation owner | B continues while A closes | Revoke/expiry/shutdown at every await and partial success write; late result cannot publish credential/200, keep tunnel live or release twice |
| Joint admission | Seven downloads plus one tunnel fill eight session slots | Ninth attempt fails before policy/DNS; 32 runtime slots reject next; rotation/stalled callbacks retain charges; reentrant close and failed reserve cannot leak or reset counters |
| Registry/listener owner | Settled generations/sockets free slots | 64-client flood, 64 active/retired records, failed replacement and nonreading rejects: bounded retained state, no queue |
| Relay/closing owner | Slow-reader long transfer within idle/lifetime bounds | Backpressure overshoot measured, stalled write reaches idle deadline, normal EOF drains only bounded bytes; revoke/error destroys both ends |
| Diagnostics/cleanup | One internal terminal outcome and complete owned drain | Throwing/rate-saturated logger, error after success, unresolved callback on shutdown: no secret backlog, false drain success or leaked timer |
| Download regression | Existing real HTTP/TLS and native Bun suites pass | Request URL/Host/SNI/redirects/bytes/cancellation preserved; stalled body continuation still holds transfer slot after TCP close |
| Claims guard | Supported synthetic workflow reports TCP-only coverage | No browser first-request, worker/redirect/WS/WSS or OS-containment claim; R4 remains open |

## G8: sequential implementation units after M2

| Later unit | Cohesive change | Exit | Release treatment |
| --- | --- | --- | --- |
| T2c1 | Destination-policy adaptation and joint ownership/admission, preserving downloads | Failing-before policy/ownership contracts and existing real download regressions pass; no listener | Internal prerequisite; no release solely for this unit |
| T2c2 | Authenticated CONNECT parser/relay, credential registry and bounded cancellation | Real two-session TCP/TLS matrix, auth failures, revoke, backpressure and no origin credential leakage | Candidate only; no browser/containment claim |
| T2c3 / M3 | Explicit opt-in lifecycle and supported synthetic-client delivery | Installable end-to-end workflow, honest capabilities, independent review and exact-head/post-merge CI | Consider minor release for the usable new public capability |

Do not stack all implementation branches now. If an ownership contract cannot
be meaningfully exercised without its gateway consumer, combine the necessary
code instead of shipping speculative exports. Each unit requires independent
review and green CI before merge; revise scope together if evidence warrants.

T1 inquiry remains separately blocked on support-channel access. No private
Playwright patch, replacement engine, worker-topology experiment, host firewall
change, CA installation or deployment follows implicitly. T3 waits for supported
T1 evidence and T2c acceptance. T4 adds scoped Linux forced egress and the complete
browser bypass matrix before a contained release.

## Review and completion

- [x] G1–G8 choices written, including auth, bounds, wire statuses and lifecycle.
- [x] Independent final adversarial design reviews: authentication/policy and lifecycle/resources.
- [x] Claimed guarantees mapped to required falsifying tests, owners and residuals in G7; tests not yet implemented.
- [x] Documentation links pass; no runtime, manifest or lockfile changes.
- [x] Exact-head eight-check docs PR CI green, then merge to develop (PR 103).

The earlier two independent scoping reviews were clean but did not approve
this final contract or run implementation tests. Their refinements are retained:
credential rotation preserves budgets, absolute expiry does not imply strict
idle scheduling, and package extraction waits for an actual second consumer.
Final independent authentication/wire and policy/ownership reviews are clean.
Re-review confirmed the corrections: distinguish failure framing from CONNECT
success, specify the client's 8 KiB/20-second response boundary, count reserved
generation records, and define idle progress by successful write callbacks.
Validation: 170 relative links across 47 Markdown files pass, diff whitespace
checks pass, and all first-party package versions remain 1.8.5. No implementation
tests were run by the design reviewers. Exact-head CI and merge evidence belong
on the PR; the linked closeout supersedes the pre-merge labels above.

## T2c1 implementation and review ledger

One cohesive implementation PR from merged develop. No credential registry,
CONNECT listener/parser/relay, browser integration, new package, main promotion,
version change or release. No unrelated worktree is changed by this unit.

| Item | Fix shape and evidence | Status |
| --- | --- | --- |
| C1: immutable paired policy | Explicit gateway snapshot on existing policy classes; one shared host predicate; built-in config copied once; custom adapters required | Implemented; 24 initial failing-before policy cases, expanded review coverage below |
| C2: fixed authorization modes | Private authority binds request or tunnel mode; discriminated destination rejects mismatch and URL-bearing tunnel input before admission; common DNS/literal-dial/peer/lease mechanics | Implemented; mixed-consumer and mode contract tests |
| C3: joint session admission | Runtime budget creates an 8-slot session scope under the existing 32-slot TCP cap; authorities share it across generation replacement; release only after actual drain | Implemented; nine initial failing-before admission cases and cancellation regressions |
| C4: download composition | Service creates the scope from the coordinator signal and injects it into downloads; keep separate transfer quotas and 30-second deadline | Implemented; two additional failing-before session/abort cases; existing real HTTP/TLS and callback-tail tests retained |
| C5: custom adapter port bypass / high | Session composition independently validates and captures operator ports before invoking the custom provider; provider cannot widen them | Reproduced as allowed 8443 under operator [443], then fixed |
| C6: malformed custom capability / medium | Validate coverage marker and complete request/destination/address gates; safe ENGINE_UNSUPPORTED before returning a composed pair | Four failing-before invalid-capability cases, then fixed |
| C7: sparse port configuration / low | Validate every entry including array holes, bounded before copying | One failing-before sparse-array case, then fixed |
| C8: suppressed abort notification / medium | Admission checks the signal's current aborted state as well as its owned closed flag; retained reservations still drain normally | One failing-before suppressed-event case, then fixed; not a claim that hostile in-process code is contained |
| C9: private authority ceilings / medium | Enforce 16 DNS answers and 10-second setup as maximum private configuration values; keep the existing defaults and independent overall download deadline | Two failing-before ceiling cases, then fixed |
| C10: adversarial review and delivery | Independent policy and transport/lifecycle reviews, full workspace hooks, native Bun download smoke, exact-head eight-check PR CI and post-merge CI | Both independent code reviews clean; local workspace builds/tests and Bun smoke pass; commit/push hooks and CI/merge gates pending |

The new mixed-consumer real fixture runs seven actual HTTP downloads and one
raw TCP lease against independent accept/request counters. A ninth attempt
fails before policy/DNS; replacing only the tunnel authority preserves the
seven download slots. This is a destination-authority fixture, **not CONNECT
wire acceptance**. The first 36 new tests failed against absent T2c1 contracts;
subsequent behavioral regressions were written and observed failing before their
corrections. Local socket fixtures require loopback permission; an initial
sandbox EPERM is environment failure, not passing or failing transport evidence.

Implementation details relative to the conceptual interfaces: a TCP reservation
is an idempotent release closure, preserving the existing budget convention;
scope creation optionally binds the coordinator cancellation signal. No extra
session index or strong retired-scope registry is introduced. The service creates
download scopes now; M3 must retain/share the owner when adding a real gateway
consumer, including sessions with downloads disabled. Gateway credential rotation,
registration, full custom-provider publishing validation, wire deadlines and
OS containment remain future acceptance, not certified by C1-C4.

Custom gateway providers remain trusted extension code: their immutable closure
semantics and conservative treatment of request-only restrictions are obligations,
not properties TypeScript or Object.freeze can prove. Session composition checks
the concrete adapter bundle and enforces its own host/port intersection. Direct
download-only snapshots and service defaults remain unchanged.

Local validation on Node 24.11.1: full workspace build/test pass, including
149 policy tests (31 new gateway cases) and 421 API tests. Native Bun HTTP/HTTPS
positive and abort controls pass. Existing environment/backend skips remain;
these results are not all-browser or Node 22 CI evidence. Independent policy
review reran all 149 policy tests; transport review separately reran focused
authority/session and download regression suites. All 172 relative documentation
links across 47 Markdown files pass. Versions remain 1.8.5. The exact final
head still requires normal hooks and all eight PR and post-merge CI jobs.
