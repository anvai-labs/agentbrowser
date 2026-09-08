# T2a: connection authority and test contract

Status: **T2a and T2b0-T2b2 merged, independently reviewed and shipped in v1.8.5.**
The [release checkpoint](release-milestones.md#baseline-and-release-boundaries)
records completed CI and publication. The next design-only unit is
[M2 gateway design](session-gateway-m2-scope.md), independently reviewed with docs
CI/merge pending; T1/R4 remain open.
Owner approved progressing T2a locally after v1.8.4. This unit selects the
smallest connection boundary behind direct downloads, not a browser transport,
public proxy or contained deployment. T1/R4 remain open. The
[integration milestones](transport-integration-contract.md) govern wider scope.

## Current behavior and prerequisite correction

[download-transport.ts](../packages/api/src/download-transport.ts) owns
per-hop URL policy, DNS lookup, an address-pinned HTTP(S) request, redirects,
response decoding and buffering. It disables connection pooling and retains
the logical URL rather than replacing the host with its selected IP. At the T2a
design baseline, five tests covered redirected host refusal, pinned HTTP Host,
chunked/compressed byte limits and a stalled-body deadline. T2b0 adds malformed
resolver and mapped-address regressions with real TCP/HTTP counters; neither
set establishes the full authority contract below.

| Current seam | Why extraction alone is insufficient | Required disposition |
| --- | --- | --- |
| Optional `checkResolvedAddresses` | A custom policy can omit DNS authorization | Strict authority creation requires both host and resolved-address gates; missing capability fails before lookup/dial, without changing the legacy engine port globally |
| String-based IP classification (design baseline) | Strict policy denied `127.0.0.1` and `::1` but allowed `::ffff:127.0.0.1`, `::ffff:7f00:1`, expanded IPv6 loopback and a non-IP string | **R14 / T2b0:** corrected with native address identity/range checks and strict syntax validation; policy and real transport tests, without changing configured range membership |
| Pinned lookup callback | No explicit connected-peer comparison | Dial a selected literal address once, verify canonical peer address/port before exposing the socket to HTTP/TLS callers |
| Transfer timeout only | No caller/session revocation signal; asynchronous policy/DNS work can outlive the caller's result | Authority owns reservations, late completions and revocation as well as active sockets |
| Only `maxBytes` validated | Invalid timing/resolver output can undermine bounded behavior | Validate finite options and complete resolver records before dialing |

R14 was reproduced as a **policy-level** defect, not an end-to-end exploit claim.
Both independent review and a local built-policy check produced the decisions
above. A malformed resolver result is a robustness boundary, not a normal DNS
answer; distinguish it from valid mapped/expanded IP addresses. The T2b0 fix
closes these representation gaps, not broader browser transport gaps.

## Smallest internal contract

Create one private authority per session generation, attached to a shared
runtime admission budget. The trusted composition root supplies an immutable
effective policy snapshot; a policy change revokes the old authority before
publishing its replacement. A page cannot choose a policy or generation ID.

The conceptual operations (not a public SDK/API) are:

- `connect(destination, callerSignal, deadline)`: authorize and establish one
  TCP connection, returning an owned socket lease only after peer verification.
- `revoke(reason)`: atomically reject new work and begin destroying pending and
  active owned resources; repeated calls are harmless.
- `closed`: report completion of owned cleanup, with any unresolved external
  resolver/policy work explicitly accounted for rather than hidden.

For the first direct-download consumer, `destination` contains the normalized
logical hostname, numeric port and the actual HTTP(S) URL needed by the existing
request policy. The authority validates URL/hostname/port agreement itself.
The caller cannot override its dial address or supply Node socket options.

A future CONNECT consumer has only an authority (hostname/port), not an
originating browser URL. Its integration must supply a separately reviewed
authority-level policy adapter; it must not fabricate a URL/path to satisfy
today's URL-bearing `RequestPolicy`. The underlying TCP mechanics can be shared
without claiming request-level authorization from CONNECT. Do not implement or
export that second input form before a real gateway consumer exists. No Unix
socket, proxy fallback or environment-selected destination is accepted.

A lease contains the socket plus its immutable logical destination and selected
canonical address/family/port, an opaque connection ID, and idempotent close.
It stays registered with its authority after delivery, so revocation can close
it. There is no separately reusable allow token or untracked socket handoff.
Consumers may initiate protocol I/O only after the lease is delivered.

Implementation stays private under `packages/api/src/` while direct downloads
are its sole real consumer. Split policy/address logic from runtime socket
ownership: `policy` owns pure classification and performs no DNS or socket I/O.
Do not add a package or export socket types through `engine`, core, protocol or
surfaces. M2 clarifies the extraction trigger: a same-runtime gateway inside
the API can share the private module in place. When a real second package/runtime
needs it, move the cohesive module with both consumers in the same reviewed
change; an engine must never import `api` to obtain it. No speculative package
is added by the design-only milestone.

## Ordering, identity and cancellation

One connection attempt follows:

`reserve -> authorize host -> resolve -> validate every answer -> select -> dial -> verify peer -> lease -> closed`

Every transition checks revocation and the applicable monotonic deadline,
including after asynchronous callbacks. The setup deadline ends at verified
lease delivery; caller/session cancellation and the caller's overall transfer
deadline remain active until the lease closes. A terminal state cannot be reopened by a late DNS,
policy, connect or TLS completion. Concurrent attempts with identical URLs are
distinct identities; no URL-keyed global verdict or socket cache is introduced.

1. Reject invalid URL schemes, userinfo, ports, hostname disagreement, IP zone
   identifiers and malformed resolver entries before any connection. Normalize
   IPv6 brackets, expanded/compressed forms and IPv4-mapped addresses consistently
   for classification and peer comparison. Do not silently broaden the existing
   configured policy: local test policies may explicitly permit loopback.
2. Literals skip DNS but still pass canonical address policy. For names, request
   all returned addresses, validate each address/family pair, then authorize the
   entire set. One denied answer rejects the attempt even if another is allowed.
   Malformed or excessive answer sets are rejected, not filtered into an allow.
3. Select one address deterministically from the validated set and connect using
   that literal. No implicit second resolution, address-family fallback, retry,
   connection pooling or shared-session socket. Failed selection/dial is terminal.
4. Compare the actual connected peer with the selected canonical endpoint.
   IPv4-mapped socket reporting must compare by address identity, not raw strings.
   A mismatch destroys the socket before application bytes are sent. The socket
   may have completed a TCP handshake: this is not a claim of zero network packets
   for post-connect peer-verification failure.
5. The authority owns abort/error listeners before dialing. Session revocation
   and caller cancellation destroy owned sockets and suppress late lease delivery.
   Release admission exactly once after actual owned work is settled/closed.

Node documents the connected peer through
[socket.remoteAddress](https://nodejs.org/docs/latest-v22.x/api/net.html#socketremoteaddress).
The API is a mechanism to test, not evidence that the current helper checks it.
Tests must cover both canonical comparison and real socket I/O.

## TLS and request semantics remain with the correct caller

For direct HTTP(S), preserve the original Host authority and URL. HTTPS must
verify the certificate for the logical hostname, not the selected IP; configure
SNI for DNS names and validate IP-literal identities without sending an IP as
SNI. A connector handing a socket into HTTPS needs explicit tests: raw
[tls.connect](https://nodejs.org/docs/latest-v22.x/api/tls.html#tlsconnectoptions-callback)
does not infer the same SNI behavior as the HTTPS API. Preserve normal trust
validation; test-local trust material is not a host CA installation.

The future CONNECT gateway owns TCP destination policy, not origin TLS. The
browser performs end-to-end TLS over the lease; the gateway cannot inspect
encrypted HTTP Host, response bodies, redirect chains or WSS upgrades. CONNECT
authentication and revocation are T2c, not fields a page may pass to `connect`.

Redirect counting/loop detection, method behavior, credentials, response/header
policy, decompression, encoded/decoded byte counters and transfer completion
remain in the request caller. Each direct-download hop obtains a new lease and
retains one overall transfer deadline; it never resets that deadline per hop.
The first rollout keeps the GET-only download behavior and current limits.

## Proposed bounds and error ownership

These are T2b1 primitive defaults, adopted by the T2b2 direct-download caller.
Small values may be injected by deterministic tests. Validate all limits as
positive safe integers before admitting work. Millisecond timeouts additionally
must not exceed 2,147,483,647 (the supported single-timer maximum); reject invalid
settings rather than relying on timer coercion. Keep monotonic absolute deadlines
internally and cap scheduled waits to their validated remaining duration.

| Resource | Initial contract | Rejection / lifecycle |
| --- | --- | --- |
| Pending plus live leases | 8 per authority; 32 across one service runtime; no wait queue | `QUOTA_EXCEEDED` before policy/DNS/dial; count connecting and active leases together |
| DNS answers | At most 16 returned records; reject malformed family/address pairs | `POLICY_DENIED` with bounded reason metadata; no dial |
| Connection setup deadline | 10 seconds or remaining caller deadline, whichever is shorter | `ACTION_TIMEOUT`; abort transport, suppress late lease |
| Direct-download overall deadline | Preserve 30-second default; validate explicit finite positive override | Includes policy, DNS, TCP, TLS, headers and body; timeout remains caller-owned |
| Retained diagnostics | Connection ID, generation, stage, bounded reason; existing redacting event/logger path | Never include raw URL userinfo/query, authorization headers or unrestricted error objects |

An aborted asynchronous resolver or policy promise may not be cancellable.
Reject the caller promptly, but retain its bounded in-flight reservation until
that work settles, including the global reservation across authority close and
replacement; never free the slot and admit an unbounded tail of abandoned
operations. A permanently unresolved callback can exhaust capacity and fail
closed. Distinguish caller completion, socket closure and full authority drain;
do not promise a hard shutdown deadline for arbitrary external callbacks. The
resolver may allocate an answer list before our cap; this is not a total
process-memory guarantee. Process-level enforcement remains ADR-008 work.

Missing strict-policy capability maps to `ENGINE_UNSUPPORTED`; malformed caller
options to `INVALID_REQUEST`; authorization/peer mismatch to `POLICY_DENIED`.
Preserve valid typed revocation reasons supplied by the session owner, while
untyped caller abort uses a bounded `INTERNAL` cancellation reason. Unexpected
DNS/TCP/TLS failures map to `INTERNAL` with a safe stage/reason, not a false
policy denial. No automatic retry or blanket retryability is introduced.
One owner emits the terminal outcome; destroying the socket cannot emit a
second one. Cleanup failure is recorded separately, without changing denial
into success or dumping secret-bearing Node errors.

## Test contract and implementation sequence

| Unit / fixture | Required positive control | Required negative evidence |
| --- | --- | --- |
| T2b0: canonical IP policy | Public IPv4/IPv6 variants retain the configured verdict; intentionally permissive local policy still works | Mapped loopback/private/metadata, expanded loopback and mixed answer sets denied under relevant flags; malformed address/family rejected |
| T2b1: authority state/admission | Independent same-URL leases; normal close restores capacity | Missing address gate, revoked generation, quota saturation, pending policy/DNS cancellation and late completion cause zero dial calls; no reservation growth past caps |
| T2b1: DNS/peer | One resolver call and one literal-address dial; equivalent mapped peer accepted | Changed answers revalidated on next attempt; mixed denied answers rejected; mismatched peer destroyed; no fallback lookup/retry |
| T2b1: real HTTP/TLS | Loopback fixtures explicitly allowed; HTTP Host, DNS-name TLS/SNI and IP certificate identity preserved | Wrong certificate name and revoked connection cannot deliver an HTTP request; timeout/close while connecting or handshaking leaves no owned socket |
| T2b2: direct-download migration | Existing redirects, Host, captured bytes and compression tests remain green | Session close interrupts transfer; per-hop reauthorization; unchanged overall deadline; size/response-policy failures close leases and restore admission |

Use fake resolvers/dialers for deterministic failure ordering, and real HTTP/TLS
servers for claims about actual Host, certificate verification and socket
shutdown. Count upstream accepts separately from HTTP requests; a denied DNS
set must produce neither, whereas failed TLS may establish TCP but must not
deliver application HTTP. Tests use owned loopback endpoints and disposable
test certificates only, with no public probing or host trust/firewall changes.

T2b0 is the first runtime correction to scope: it addresses a real existing
policy defect independently of the unresolved browser lifecycle. T2b1 implements
the private primitive; T2b2 migrates its first production caller with session
lifecycle integration. These are separate review boundaries within T2b, not a
stack of competing APIs. T2c starts only after their acceptance evidence passes.
This design does not authorize a shared package, listener, deployment or
release-version change. T2b0 is the narrow prerequisite; production integration
and the wider transport acceptance gates remain separate work.

## T2b1 implementation boundary

The private [connection authority](../packages/api/src/connection-authority.ts)
implements TCP admission, full-set DNS validation, one literal-address dial,
canonical peer verification and revocable socket leases. At the T2b1 merge it
was not connected to downloads/service sessions; it remains private to the API
implementation. T2b2 integration is described below.
No gateway, browser adapter, HTTP/TLS implementation, deployment or package-version
change is included. Native local behavior therefore remains unchanged.

`ConnectionBudget` is shared by the trusted service runtime; a
`ConnectionAuthority` instance represents one session generation. `connect`
copies the destination and caller deadline/signal before awaiting policy,
validates actual URL/hostname/port agreement, and returns immutable destination
and endpoint metadata with a random connection ID. The lease's `signal` retains
caller/owner/deadline cancellation through close; `closed` settles only after
owned work and the TCP socket drain. Authority `closed` additionally requires
revocation. Neither property promises to cancel an arbitrary unresolved callback.

The trusted composition root must supply a fixed effective policy snapshot and
revoke before replacing it. Capturing bound methods prevents method replacement,
but cannot freeze arbitrary callback closure state. There is no page-selectable
policy, mutable allow token, caller-supplied socket option, retry or pooling.

Deterministic tests cover default capacity bounds, same-URL identities, retained
reservations across cancelled generations, reentrant revocation, mutation across
awaits, stale callbacks, deadlines, malformed destination/DNS input, and mismatched
peers. Real loopback HTTP/TLS tests verify Host/SNI, DNS-name and IP certificate
identity, denied-before-connect counters, and raw/TLS/upstream socket closure
during a stalled handshake. Their TLS adapter is **test-only**: it binds lease
cancellation to the TLS wrapper and wrapper closure back to the TCP lease.
Ephemeral certificates are generated through the local OpenSSL command, using a
mode-0600 key file in a uniquely created test directory. The exact file and empty
directory are removed in `finally`; tests install no host CA and never disable
certificate verification. This avoids Linux's inability to reopen Node's
socket-backed child `/dev/stdin` as a key file, found by the first PR CI run.

Validation: 55 deterministic and nine real-I/O cases pass; independent lifecycle
and HTTP/TLS reviewers approved after rerunning their suites. A native Bun 1.4.0
TCP/close control also passes. The initial tests failed on the absent primitive;
later malformed-bracket destination regressions failed before their correction.
These results are not a substitute for the required PR/post-merge CI gates.

T2b2 must migrate that caller behavior into the production download path with
session lifecycle integration, response/redirect/byte limits and one transfer
deadline. It also owns generation-aware terminal logging through the existing
redacting service logger, and separate caller cleanup diagnostics. T2b1 returns
bounded stage/reason errors and preserves explicit protocol error codes without
retaining raw callback/transport messages; it does not claim that service logging
wiring or TLS wrapper cleanup is intrinsic to a TCP-only authority.

## T2b2 production integration boundary

The private `DownloadTransport` is created once per download-enabled session,
using one service-runtime `DownloadBudget`. It replaces the standalone download
helper, with no socket type exported through core/engine/protocol or a public
route. The engine-neutral coordinator exposes only a session cancellation signal:
explicit close, termination, detected expiry and shutdown abort it before waiting
for engine teardown. The service revokes every download owner before shutdown,
does not publish a generation created during shutdown, and checks the owner again
before storing an artifact. An injected test fetcher runs inside the same transfer
admission/cancellation envelope; it is not production TCP/TLS evidence.

For download-enabled sessions, `NetworkPolicy.snapshot()` captures fixed rules
before asynchronous engine creation. The session host composite is shared by
navigation fast-fail, engine policy and direct downloads. Updating the injected
base configuration affects newly created download generations, not existing ones;
close/recreate to replace a generation. The built-in snapshot freezes configuration
and disables private raw request logs, avoiding a new log buffer per session.
Custom subclasses/overridden policy methods must explicitly implement an immutable
snapshot or download-enabled session creation fails with `ENGINE_UNSUPPORTED`;
copying their base configuration must never silently discard a custom deny.
Sessions without downloads retain their existing injected-policy behavior.

The shared budget separately caps 32 live/pending TCP attempts and 32 transfer
continuations, with eight of each per session and no queue. A cancelled DNS/policy
attempt retains authority admission until it settles; a cancelled response/redirect/
body-policy callback retains transfer admission until its continuation settles.
These are separate bounds, not a promise of 32 total objects or a hard callback
shutdown deadline. Service teardown never waits for an arbitrary external callback.

Each GET/redirect hop obtains a fresh verified lease. The HTTP request supplies
`createConnection` with that exact socket; `agent: false` must not be used because
it selects a default Agent that can bypass the handoff. HTTPS wraps the lease in
TLS first, preserving logical-host certificate verification and DNS-only SNI.
Tests provide disposable fixture trust, never disable verification or install a CA.
There is no pooling, implicit DNS retry or second network lookup.

One monotonic overall deadline (30 seconds by default) covers policy, connection,
TLS, headers, redirects, decoding and body policy. Overrides must be positive safe
integer milliseconds within the single-timer maximum. Redirect overrides are
non-negative safe integers capped at 100; the default remains ten and the policy
can restrict it further. Both encoded and decoded bytes obey the session byte cap.
Per-hop leases drain before redirect readmission. Ordinary TCP close is not itself
a failed transfer: buffered/decompressed data may finish afterward. The transfer
signal owns request/response/decoder/TLS destruction, independently of raw TCP.

The existing redacting service logger receives one `download.transport` terminal
record per admitted/rejected download attempt, with generation, transfer ID, last
established connection ID if available, stage, outcome and protocol code. Cleanup
exceptions use a separate bounded `download.cleanup-failed` record; raw URL query,
headers, certificates, callback details and transport messages are never logged.
The enclosing `download.fetch` operation remains the artifact-level telemetry owner.

Acceptance evidence: 46 focused download tests pass, including eight real TLS
cases and the overflow-during-stalled-policy regression independently reproduced
and corrected during review. Five new coordinator lifecycle cases and two policy
snapshot cases pass. Independent transport and lifecycle reviewers approved.
The native Bun check in `scripts/check-download-bun.ts` exercises production HTTP
and HTTPS success/cancellation with sockets and admission drained; all four
controls pass locally and are included in the existing Bun CI gate.

Expiry cancellation occurs when the coordinator's existing lazy lookup or cleanup
sweep detects expiry; this does not add an exact wall-clock TTL scheduler. Ordinary
local/Brew deployments remain available. Browser routing gaps, CONNECT, gateway
deployment and OS-enforced egress are not addressed here; T1/R4 remain open.
