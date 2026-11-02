# T10 bounty flow continuity: 2026-10-30 handoff

Status: revised base/addendum plan approved; incremental releases authorized.
Foundation release 1.29.0 shipped; maintenance release 1.29.1 shipped.
Coordinate mode (A1) shipped in [1.30.0](../evidence/release-1.30.0.md).
The redirect method/body prerequisite shipped in
[1.30.1](../evidence/release-1.30.1.md).
The updated external handoff/kickoff define acceptance. Their revised order takes
precedence over the kickoff's older numbered list:
P0-1 → P0-3 → P1-4 → A1 → P0-2 → P1-5/P1-6+A4 → P1-7+A2/A3 → P2-8 → A5 → A6.
Reference operator scripts are behavioral examples, never product dependencies.
Unfinished API-probe work is preserved separately and is not a released capability.

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
| P0-2 | In progress and disabled. Redirect method/body repairs released in 1.30.1; response-admission helper qualified locally, with activation/controlled-service gates still open |
| P1-5/P1-6+A4; P1-7+A2/A3; P2-8; A5; A6 | Planned in the approved order; not completed by the published hotfix |
| Header hostSuffix pass-through | Local commit `93213f22`; absent from the 1.29.1 source despite the #664 description; separate review and qualification required |
| Scope host suggestions | Helpers/tests exist in 1.29.1; no public call site found, so this is not a delivered resource-host workflow |

Main's #664 also disabled four unused-code Biome rules globally. The back-sync
preserves that published configuration; its green lint result does not establish
the previous lint coverage. The subsequent lint-hardening checkpoint restores
all four as errors and adds dependency, runtime-cycle, unused-expression and
global-eval checks. Hooks and CI share the warning-failing root gate and executable
policy probes; see [lint hygiene](../../../CLAUDE.md#lint-hygiene).

Further additive public capabilities receive the next minor version (1.31.0).
A standalone repair to shipped behavior receives a maintenance version (next:
1.30.2). Published tags and assets must not be reused or rewritten.

## Release cadence

Checkpoint stable logical groups with passing checks and separate adversarial
review. Additive public capabilities receive minor releases; fixes to shipped
behavior receive maintenance releases. Promote each qualified group through
protected develop/main PRs, tag the promotion commit, verify delivery and back-sync.
A later group does not block publication of an earlier qualified foundation.
Page fetch (P0-2) is the next foundational increment. Auth/resource continuity,
verified form interactions, observability and incident/lifecycle diagnostics follow.

## Constraints and qualification

Keep strict additive schemas, identityBindings validation-only semantics, all outer
policy layers, controlled-write review and secret redaction. Every egress change
must retain method/host/rate/budget denial enforcement and ledger records. Dependency
hints never authorize hosts. Operator budget/resource/reseed authority changes and
submit/fallback semantics require design decisions before their implementation.
Unknown dispatch outcomes never justify replaying an irreversible mutation.

Local fixtures mirror unavailable Wolt/Vinted flows. Live checks remain pending
operator verification; fixture success is never described as a live program pass.

## P0-2 prerequisite: redirect method and body fidelity

Before enabling API probes, repair the existing scoped UI redirect walker.
HEAD remains HEAD through 301/302/303, and each hop derives its method from the
current request. DELETE/OPTIONS retain their inspected lane and response-size
checks. A 303 permanently clears their body and body headers; converted hops use
the same context's API request jar without Route.fetch's original-body fallback.
Cookie/Host and cross-origin authorization hygiene precedes destination transforms.
Only browser redirect statuses 301/302/303/307/308 follow. Existing native
POST/PUT/PATCH admission and worker-response gates are retained. This is an
existing-behavior repair, not delivery of the `page fetch` command.

Coverage: public-service real Chromium fixtures measure receiver method, body
length and SHA-256 through same-origin and mixed chains; method/host/rate/budget
refusals reach no denied receiver and persist in independently verified sealed
engagement ledgers. This stable prerequisite is checkpointed separately so the
longer API-probe qualification does not hold up the repair.

Browser-generated CORS preflight qualification remains a separate foundational
follow-up before expanding native admission: marker injection must never precede
its policy decision, preflights must remain distinct from explicit OPTIONS, and
any new native lane must preserve response caps and all outer policy floors.

## P0-2 checkpoint: authoritative response admission

The [API-probe decision](../../adr/030-scoped-page-fetch.md) now distinguishes
complete transport witnesses from the truncated public response. The private
helper snapshots full headers and response identity before awaiting policy,
preserves duplicate delivery cookies, checks cumulative decoded bytes, and bounds
policy waits and CDP reads by owner cancellation, revocation and a monotonic
deadline. Refused decoded buffers are cleared; late stream handles are closed.

Local qualification covers 15 real-Chromium cases plus the existing 20 redirect
guard cases. Compression, hidden declared length, HEAD/204/205/304, all five
redirect statuses, terminal 302 without Location, exact PUT bytes/cookies and a
stalled stream have receiver/result oracles. A redirect-header denial reaches no
destination receiver. Chromium cannot stream a native redirect's body at its
response pause: those outcomes carry a distinct redirect classification, never
a fabricated zero-byte witness. Only terminal body bytes are measured, matching
the existing inspected redirect walker; this is not a bandwidth cap.

Independent review caught mutable policy-header classification; regressions
ensure callbacks cannot turn a terminal response into a redirect/bodyless result
or change which response stream is acquired. A page/URL matching shortcut was
also rejected as an activation design. Existing transport lanes and all policy
charges remain unchanged in this checkpoint. The helper is not wired into the
engine yet; the public command is not qualified or released. Next gates are
trusted transport integration, prepared document/authority binding, controlled
service admission, session-secret redaction and durable no-replay qualification.

## P0-1: marker compliance and configuration round-trip

Header/UA enforcement already shipped in1.28.0. Both existing local services reported
1.27.4 at inspection, explaining requestHeaders rejection; they were left running.
New work adds the create/status validate-only hint and canonical private-file
export/import, preserving marker values only in the operator's configuration.
Unknown keys and unsafe injection headers refuse. Canonical import refuses
constraint overrides. Runtime status and ledger values remain hashed/redacted.

Coverage: core scope-configuration tests, CLI canonical round-trip/private/exclusive
output tests, API bounty-session/research-identity tests, existing real Chromium
marker/redirect receivers and scope denial fixtures. Live Wolt verification pending.

## P0-3: live denial diagnostics

Default bounty/program-scope tracing, bounded authenticated SSE, SDK/CLI consumers
and MCP logging notifications preserve independent enforcement/ledger paths.
Correlation is advisory (three host denials in five seconds, known vendors or
cross-TLD registry label). No policy mutation. Session-scoped redaction precedes
correlation/publication; transport chunks do not define frame bounds. Observers
share readiness and outlive individual MCP tool cancellation, ending with their
session/connection. Retention and output backpressure are bounded and reported.

Coverage: pure correlation/window tests, strict protocol parsing, SDK fragmentation
and coalescing, API ownership/cancellation/opt-out/sink failure, MCP lifecycle races,
and real Chromium first-denied PUT with receiver hit count zero and sealed ledger.
Live Vinted verification remains pending operator verification.

## Remaining ordered items

P1-4 implemented under [ADR-029](../../adr/029-operator-budget-topup.md):
observed method/host classes (including denied PUT), bounded tenant-local page cost,
explicit platform sizing presets and separately authenticated durable budget top-up.
Tests cover finite increases, stale/concurrent/unauthorized/failed grants, preserved
pages/spending, expired-navigation sample isolation and unsupported engines.
Live Vinted sizing remains pending operator verification.
A1: coordinate input and capture-bound visual verification for closed-shadow UIs.
The [ADR-031](../../adr/031-coordinate-interaction-and-visual-evidence.md) candidate
adds exact one-use consent, native input-bound verified bytes and bounded owner
cancellation. Unknown/non-unit browser zoom is explicitly unqualified; live
Bugcrowd verification remains pending operator verification.
P0-2: controlled, scoped, ledgered origin-context API requests.
P1-5: explicit functional resource hosts, distinct from static assets/targets.
P1-6+A4: rotation diagnostics, operator-approved reseed, scoped CDP extraction
and seed provenance/non-transferability hints.
P1-7+A2/A3: verified activation/submit, delayed/reloaded field verification and
visible primary-action gating diagnostics, without uncertain mutation replay.
P2-8: safe event filters, bounded evidence retention and no-cache auth checks.
A5: private manifested incident bundles with scoped API/ledger/screenshot evidence.
A6: bounded page tombstones and explicit early-close diagnostics.
