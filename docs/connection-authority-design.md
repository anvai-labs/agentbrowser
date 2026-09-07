# T2a: connection authority and test contract

Status: **Design artifact for independent review; not implemented.**
Owner approved progressing T2a locally after v1.8.4. This unit selects the
smallest connection boundary behind direct downloads, not a browser transport,
public proxy or contained deployment. T1/R4 remain open. The
[integration milestones](transport-integration-contract.md) govern wider scope.

## Current behavior and prerequisite correction

[download-transport.ts](../packages/api/src/download-transport.ts) currently owns
per-hop URL policy, DNS lookup, an address-pinned HTTP(S) request, redirects,
response decoding and buffering. It disables connection pooling and retains
the logical URL rather than replacing the host with its selected IP. Its five
tests cover redirected host refusal, pinned HTTP Host, chunked/compressed byte
limits and a stalled-body deadline. They do not establish the contract below.

| Current seam | Why extraction alone is insufficient | Required disposition |
| --- | --- | --- |
| Optional `checkResolvedAddresses` | A custom policy can omit DNS authorization | Strict authority creation requires both host and resolved-address gates; missing capability fails before lookup/dial, without changing the legacy engine port globally |
| String-based IP classification | Strict policy denies `127.0.0.1` and `::1` but allows `::ffff:127.0.0.1`, `::ffff:7f00:1`, expanded IPv6 loopback and a non-IP string | **R14 / T2b0:** canonical IP parsing and classification correction before reusable authority; tests at policy and transport boundaries |
| Pinned lookup callback | No explicit connected-peer comparison | Dial a selected literal address once, verify canonical peer address/port before exposing the socket to HTTP/TLS callers |
| Transfer timeout only | No caller/session revocation signal; asynchronous policy/DNS work can outlive the caller's result | Authority owns reservations, late completions and revocation as well as active sockets |
| Only `maxBytes` validated | Invalid timing/resolver output can undermine bounded behavior | Validate finite options and complete resolver records before dialing |

R14 is a reproduced **policy-level** defect, not an end-to-end exploit claim.
Both independent review and a local built-policy check produced the decisions
above. A malformed resolver result is a robustness boundary, not a normal DNS
answer; distinguish it from valid mapped/expanded IP addresses. Do not call
existing private-range checks sufficient until their representation gaps close.

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
surfaces. When a real gateway consumes the primitive, move the cohesive module
with both consumers in the same reviewed change; an engine must never import
`api` to obtain it.

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

These are initial implementation defaults for review, not shipped settings.
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
This document contains no implementation, new security acceptance claim, shared
package, listener, deployment, or release-version change.
