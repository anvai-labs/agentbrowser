# T10 bounty flow continuity: 2026-10-30 handoff

Status: revised base/addendum plan approved; incremental releases authorized.
First candidate: 1.29.0 (P0-1/P0-3/P1-4 plus already integrated T10 B1–B6).
The updated external handoff/kickoff define acceptance. Their revised order takes
precedence over the kickoff's older numbered list:
P0-1 → P0-3 → P1-4 → A1 → P0-2 → P1-5/P1-6+A4 → P1-7+A2/A3 → P2-8 → A5 → A6.
Reference operator scripts are behavioral examples, never product dependencies.
Unfinished API-probe work is preserved separately and excluded from this candidate.

## Release cadence

Checkpoint stable logical groups with passing checks and separate adversarial
review. Additive public capabilities receive minor releases; fixes to shipped
behavior receive maintenance releases. Promote each qualified group through
protected develop/main PRs, tag the promotion commit, verify delivery and back-sync.
A later group does not block publication of an earlier qualified foundation.
Coordinate mode (A1) is the next foundational increment. Auth/resource continuity,
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
P0-2: controlled, scoped, ledgered origin-context API requests.
P1-5: explicit functional resource hosts, distinct from static assets/targets.
P1-6+A4: rotation diagnostics, operator-approved reseed, scoped CDP extraction
and seed provenance/non-transferability hints.
P1-7+A2/A3: verified activation/submit, delayed/reloaded field verification and
visible primary-action gating diagnostics, without uncertain mutation replay.
P2-8: safe event filters, bounded evidence retention and no-cache auth checks.
A5: private manifested incident bundles with scoped API/ledger/screenshot evidence.
A6: bounded page tombstones and explicit early-close diagnostics.
