# T10 B1–B6 operator workflow qualification

Date: 2026-10-30. Local fixtures only; no live program traffic in this change.
Design: [operator workflow](../design/t10-bounty-operator-workflow.md),
[ADR-027](../../adr/027-evidence-pass-state-transfer.md),
[ADR-028](../../adr/028-operator-asset-scope-amendments.md).

## Behavioral evidence

- API bounty-default/session tests cover preset precedence, preserved scope caps,
  paced unscoped contained sessions, teardown and the unenforced CDP distinction.
  CLI and MCP tests verify flag/profile forwarding.
- Evidence-state, lifetime, service and HTTP tests cover exact origins, parent
  cookie filtering, operator/tenant/unknown-field refusals, hidden initialization,
  partial-failure cleanup, deadline/source closure and hash-only ledger records.
  A real Chromium receiver verifies cookies (including non-root paths) and
  localStorage transfer, with exact-origin separation.
- Asset policy/core/CLI tests cover static-only adoption, preserved exclusions,
  program/asset overlap refusal, private audit recovery after interrupted replacement
  and strict inputs. A standalone compiled CLI smoke runs outside node_modules and
  verifies explicit adoption plus unobserved-host refusal.
- Real asset receivers verify markers, cookies and authorization are absent,
  redirects are rechecked, URL-userinfo credentials refuse, and document/fetch
  lanes remain denied. A live-amendment fixture retains the same page and edited
  input while admitting an operator-approved asset, preserving counters.
- Amendment tests cover operator authority, tenant/revision checks, concurrent
  stale requests, critical-ledger failure and stop-on-incomplete behavior.
- Bundle tests verify opt-in categories, immutable program targets, exclusion
  retention and unknown-name refusal. Import output warns that suggestions are
  not testing authorization.
- Worker-floor receivers cover classic/module/blob Worker and SharedWorker
  creation refusal, GET redirects, gzip POST redirect terminals, executable
  terminal 300/302 responses and duplicate Set-Cookie preservation. Stream/CSP
  unit tests cover byte limits, stalled reads, late acquisition, expired deadlines,
  cleanup and failed policy installation without a successful ledger outcome.
- Disclosure cap selection is deterministic; a smaller real fixture retains
  visibility/closed-details coverage. The 500 ms production read deadline has an
  explicit stalled-read test. Autofill uses a bounded setup wait and a test-owned
  pending-frame latch, retaining all field-verification and incomplete-frame checks.

## Limits and merge gates

The CDP operator browser remains outside network containment. Imported scopes and
bundles do not establish testing permission. Transfer covers cookies/localStorage
only, never broad profile state. Asset access is restricted to classified static
GET/HEAD requests and does not extend program targets. Marker ledger entries prove
dispatch intent, not remote receipt. Worker-dependent UI can remain unavailable;
worklets remain outside qualified containment. Scoped native responses have an
8 MiB / 15-second delivery bound; upload request bytes stay native.

Independent adversarial review found and drove corrections to cookie-domain
filtering, interrupted audit recovery, unsupported CLI restriction flags, transfer
lifetimes, host-pattern overlap, URL credentials, bundled matcher loading, worker
provenance, terminal 3xx policy delivery and stream cleanup. Final source review is
clean. Required hooks, full-suite and CI outcomes are recorded on the implementation
PR; isolated fixture success is not a substitute for those gates.
