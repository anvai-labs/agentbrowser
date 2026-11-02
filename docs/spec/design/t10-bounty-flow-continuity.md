# T10 bounty flow continuity plan

Status: revised base/addendum plan approved; incremental releases authorized.
Source: the 2026-10-30 external handoff/kickoff, whose revised order takes
precedence over the kickoff's older numbered list:
P0-1 → P0-3 → P1-4 → A1 → P0-2 → P1-5/P1-6+A4 → P1-7+A2/A3 → P2-8 → A5 → A6.
Reference operator scripts are behavioral examples, never product dependencies.

Released so far: foundation [1.29.0](../evidence/release-1.29.0.md) (T10 B1–B6,
P0-1/P0-3/P1-4), maintenance [1.29.1](../evidence/release-1.29.1.md) (navigation
classification, interception), [1.30.0](../evidence/release-1.30.0.md) (A1
coordinate mode), [1.30.1](../evidence/release-1.30.1.md) (redirect method/body
fidelity — the P0-2 prerequisite), [1.30.2](../evidence/release-1.30.2.md)
(research-marker transport, initial seed lifecycle), [1.30.3](../evidence/release-1.30.3.md)
(owner-bound ordinary publication foundation), and [1.32.0](../evidence/release-1.32.0.md)
(page fetch, P0-2 — see its section below). Live Wolt/Vinted acceptance remains
pending operator verification throughout.

## Origin reconciliation: 2026-11-01

The published source, rather than earlier candidate status or PR descriptions,
determines completion. [1.29.0](../evidence/release-1.29.0.md) shipped T10 B1–B6
and P0-1/P0-3/P1-4 through #659–#661. [1.29.1](../evidence/release-1.29.1.md)
shipped the navigation classification and interception changes from #664–#665.
The latter landed directly on main; this reconciliation brings those released
changes back into develop while retaining develop's 1.29.0 evidence record.

| Handoff work | Reconciled status |
| --- | --- |
| T10 B1–B6; P0-1/P0-3/P1-4 | Released in 1.29.0; live Wolt/Vinted acceptance remains pending operator verification |
| A1 | Released in 1.30.0: public closed-shadow picker/search/select/upload/one-submit fixture; DPR 1/2, controlled durable no-replay and method/host/rate/budget denial ledgers; full checks, exact-head independent review and release delivery passed. Live program verification pending |
| P0-2 | Released in 1.32.0: typed fetch action (protocol bounds and refusals), isolated-world transport with nonce attribution and authoritative admission on both lanes, one-use method-based consent, scope preflight, session-secret redaction, API/MCP/CLI/SDK surfaces. Live Vinted/Wolt acceptance remains pending operator verification |
| Header hostSuffix pass-through | Released in 1.30.2 after #676, combined release review, full 6,511-test hooks, green protected CI and package/tap delivery |
| Initial seed privacy prerequisite | Released in 1.30.2: reserved-owner registration, generation-bound redaction/cleanup and fail-closed recorder faults. This does not implement live reseed or ordinary observe/console output privacy |
| Scope host suggestions | Helpers/tests exist in 1.29.1; no public call site found, so this is not a delivered resource-host workflow |

Main's #664 also disabled four unused-code Biome rules globally. The back-sync
preserves that published configuration; its green lint result does not establish
the previous lint coverage. The subsequent lint-hardening checkpoint restores
all four as errors and adds dependency, runtime-cycle, unused-expression and
global-eval checks. Hooks and CI share the warning-failing root gate and executable
policy probes; see [lint hygiene](../../../CLAUDE.md#lint-hygiene).

Further additive public capabilities receive the next minor version.
A standalone repair to shipped behavior receives a maintenance version
(subsequent standalone repairs use the next available patch).
Published tags and assets must not be reused or rewritten.

## Release cadence

Checkpoint stable logical groups with passing checks and separate adversarial
review. Additive public capabilities receive minor releases; fixes to shipped
behavior receive maintenance releases. Promote each qualified group through
protected develop/main PRs, tag the promotion commit, verify delivery and back-sync.
A later group does not block publication of an earlier qualified foundation.
Next foundational increments: auth/resource continuity, verified form
interactions, observability and incident/lifecycle diagnostics.

## Constraints and qualification

Keep strict additive schemas, identityBindings validation-only semantics, all outer
policy layers, controlled-write review and secret redaction. Every egress change
must retain method/host/rate/budget denial enforcement and ledger records. Dependency
hints never authorize hosts. Operator budget/resource/reseed authority changes and
submit/fallback semantics require design decisions before their implementation.
Unknown dispatch outcomes never justify replaying an irreversible mutation.

Local fixtures mirror unavailable Wolt/Vinted flows. Live checks remain pending
operator verification; fixture success is never described as a live program pass.

## P0-2: scoped origin-context probes — shipped in [1.32.0](../evidence/release-1.32.0.md)

The [ADR-030](../../adr/030-scoped-page-fetch.md) capability is delivered end to
end, in three qualified stages.

### Stage 1 — redirect method/body fidelity prerequisite (shipped 1.30.1)

The scoped UI redirect walker was repaired before enabling API probes: HEAD
remains HEAD through 301/302/303, each hop derives its method from the current
request, DELETE/OPTIONS retain their inspected lane and response-size checks,
and a 303 permanently clears body and body headers (converted hops use the same
context's API request jar without Route.fetch's original-body fallback).
Cookie/Host and cross-origin authorization hygiene precede destination
transforms; only browser redirect statuses 301/302/303/307/308 follow. Public
real-Chromium fixtures measure receiver method, body length and SHA-256 through
same-origin and mixed chains; method/host/rate/budget refusals reach no denied
receiver and persist in independently verified sealed engagement ledgers.
Browser-generated CORS preflight qualification remains a separate foundational
follow-up before expanding native admission.

### Stage 2 — authoritative response admission (qualified with 1.31.0's helper)

The transport distinguishes complete transport witnesses from the truncated
public response: full headers and response identity are snapshotted before
awaiting policy, duplicate delivery cookies are preserved, cumulative decoded
bytes are checked, and policy waits and CDP reads are bounded by owner
cancellation, revocation and a monotonic deadline. Refused decoded buffers are
cleared; late stream handles are closed. Local qualification covered 15
real-Chromium cases plus the existing 20 redirect guard cases (compression,
hidden declared length, HEAD/204/205/304, all five redirect statuses, terminal
302 without Location, exact PUT bytes/cookies, a stalled stream); a
redirect-header denial reaches no destination receiver. Independent review
caught mutable policy-header classification; regressions ensure callbacks
cannot turn a terminal response into a redirect/bodyless result or change
which response stream is acquired. Chromium cannot stream a native redirect's
body at its response pause: those outcomes carry a distinct redirect
classification, never a fabricated zero-byte witness.

### Stage 3 — activation and controlled service admission (shipped 1.32.0)

The protocol carries a delivered `fetch` action whose schema union
discriminates bodyless methods; its bounds (8 KiB aggregate header bytes,
64 KiB UTF-8 body measured in bytes, URL shape, forbidden and duplicate
header names — including the method-tunneling and context-spoofing families)
live in one contract source enforced at the CLI, the service executor and the
engine. The Chromium engine issues a fixed same-origin/credentials/no-store
browser fetch in an isolated world (`grantUniveralAccess: false`) pinned to
the prepared frame, loader and origin; a navigation invalidates the
preparation and the consumed token refuses replay. The probe lane exists only
under an engagement scope.

Trusted attribution is a per-dispatch secret nonce header that exists only
inside the isolated world: the CDP guard strips it before the wire on the
native (POST/PUT/PATCH) lane, and the route handler's Node-side re-issue
drops it on the inspected (GET/HEAD/DELETE/OPTIONS) lane; the page-wide flag
and method/URL FIFO approaches stay rejected. Terminal responses are admitted
authoritatively — `admitPageFetchResponse` on the native lane, the verified
Node response on the inspected lane — and the exact admitted bytes fulfill the
page's request. Redirect hops carry a fresh scope verdict plus the probe's
same-origin rule (cross-origin 307/308 refused on every method even when the
destination is scope-allowed); the choke point's own synthetic denial is
recognized by its marker and settles the probe denied with the noted sub-code.

Service admission follows the HTTP method: GET/HEAD/OPTIONS read;
POST/PUT/PATCH/DELETE transaction with the exact one-use consent floor and
the prepared probe's identity bound into the approval. A scope preflight
denies before any browser work (`SCOPE_METHOD_DENIED` in one round trip),
the published result is redacted with the owning session's secret registry,
re-bounded after redaction and marked untrusted, and probe outcomes are
ledgered with `probe: true`. Real-Chromium qualification covers the
Vinted-shaped PUT (exact bytes, cookie, CSRF header, no nonce on the wire),
the method denial with zero receiver hits and both ledger rows, competing
identical-URL traffic (a driver that replaces `fetch`/`Headers`), cross-origin
and same-origin 307 chains on both lanes, the inspected-lane GET, and
stale-document token refusal. A four-pass adversarial review before merge
closed its confirmed findings (guard method gate, scope-only lane, MCP
envelope handling, header tunneling) with receiver-counted oracles; see the
[release record](../evidence/release-1.32.0.md). Live Vinted/Wolt
verification remains pending operator verification.

## P0-1: marker compliance and configuration round-trip (shipped 1.28.0/1.29.0)

Header/UA enforcement shipped in 1.28.0. Both existing local services reported
1.27.4 at inspection, explaining requestHeaders rejection; they were left running.
The create/status validate-only hint and canonical private-file export/import
preserve marker values only in the operator's configuration. Unknown keys and
unsafe injection headers refuse; canonical import refuses constraint overrides;
runtime status and ledger values remain hashed/redacted. Live Wolt verification
pending.

## P0-3: live denial diagnostics (shipped 1.29.0)

Default bounty/program-scope tracing, bounded authenticated SSE, SDK/CLI consumers
and MCP logging notifications preserve independent enforcement/ledger paths.
Correlation is advisory (three host denials in five seconds, known vendors or
cross-TLD registry label). No policy mutation. Session-scoped redaction precedes
correlation/publication; transport chunks do not define frame bounds. Observers
share readiness and outlive individual MCP tool cancellation, ending with their
session/connection. Retention and output backpressure are bounded and reported.
Live Vinted verification remains pending operator verification.

## Remaining ordered items

P1-4 shipped under [ADR-029](../../adr/029-operator-budget-topup.md) in 1.29.0:
observed method/host classes (including denied PUT), bounded tenant-local page
cost, explicit platform sizing presets and separately authenticated durable
budget top-up. A1 shipped under
[ADR-031](../../adr/031-coordinate-interaction-and-visual-evidence.md) in 1.30.0.
Remaining, in the approved order:

- P1-5: explicit functional resource hosts, distinct from static assets/targets.
- P1-6+A4: rotation diagnostics, operator-approved reseed, scoped CDP extraction
  and seed provenance/non-transferability hints.
- P1-7+A2/A3: verified activation/submit, delayed/reloaded field verification and
  visible primary-action gating diagnostics, without uncertain mutation replay.
- P2-8: safe event filters, bounded evidence retention and no-cache auth checks.
- A5: private manifested incident bundles with scoped API/ledger/screenshot evidence.
- A6: bounded page tombstones and explicit early-close diagnostics.
