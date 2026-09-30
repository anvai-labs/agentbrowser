# N1: bounded network and console error observation

Status: design candidate, not implemented. Design-first per the foundation-first
refinements (docs/spec/tasks/foundation-refinements.md); no code ships in this
packet. Load this packet for the bounded network/console observation work; it
does not add a debug lane, JS evaluation, or response-body access.

## Motivation and boundary

The published comparison (docs/comparison.md) located AgentBrowser's lane:
governance, not debugging depth. chrome-devtools-mcp owns performance traces,
console inspection, and network UI; raw CDP owns everything else. What agents
using AgentBrowser actually lack is not a debugger — it is **failure facts**:
when a subresource silently fails, a console error fires, or egress policy
denies a hop, the agent currently sees only the page's degraded state and must
guess why.

N1 adds exactly that fact layer, and nothing more. The boundary is ADR-009's:
no `evaluate()`, no raw network handles, no response bodies, no timing traces,
no replay. Every N1 fact is (a) an event the service already observes at its
existing choke points, (b) redacted and byte-capped before storage, (c)
queryable after the fact so it never inflates per-call results.

## Owners and contract

The engine's existing per-context `RequestEventSink` is the provenance root:
the routing owner already writes `request.started/finished/failed` receipts
(origin + pathname only — query strings are stripped at emission, spec 14.2),
including blocked-request records with the policy reason. N1 adds:

1. **Console/page-error capture**: engine-level `console`/`pageerror`
   listeners per page, recorded as bounded entries. Page-derived text is
   hostile: entries carry `untrustedContent: true` and are redacted through
   the existing `SecretManager` registry before storage.
2. **A bounded per-session ring buffer** (new engine state, mirroring the
   bounded-histories precedent): fixed entry cap, per-entry byte cap, oldest
   evicted. No hostname cache, no permanent diagnostic store, no unbounded
   growth — the resource-budgets suite already fails leaks.
3. **A query surface, not a push surface**: `GET /v1/sessions/:id/network-evidence`
   with `since`/`limit` parameters returning the bounded projection. One new
   MCP tool (`browser_network_evidence`) joins the catalog — 16 → 17 per
   profile; the contract-sync tests, mcp-tool-catalog.md, and the CLI
   equivalent are part of the definition of done, not afterthoughts.

| Fact kind | Fields (all bounded) | Source |
| --- | --- | --- |
| request_failed | origin+path, hostname, method, resourceType, reason (existing NavigationFailureReason vocabulary), blocked flag | routing sink (existing emission) |
| request_finished | origin+path, hostname, method, status, bytes | routing sink (existing emission) |
| console_error | level, byte-capped text (untrusted, redacted), source URL origin+path | page console/pageerror listeners (new) |
| policy_denied | origin+path of the denied hop + policy reason (incl. redirect-chain denials from all-hop enforcement) | routing sink deny paths (existing) |

Deliberately absent: request/response bodies, headers beyond status, timing
or performance data, WebSocket frames, anything JS-initiated.

## Why query-after-the-fact

Pushing evidence into every navigation/observation result would tax every
call for facts most calls do not need, and would re-create the token problem
ADR-003 solved for observations. The `since`/`limit` query keeps the cost
proportional to the agent's actual question ("why did this page fail?") and
keeps the MCP result shape small. The projection reuses the shared bounded
envelope discipline (reason + operationId reconciliation, no retries implied).

## TDD gate plan

- Engine units (hermetic): ring-buffer caps (entry count, per-entry bytes,
  eviction order), redaction through a registry with a canary secret,
  query-string stripping, `untrustedContent` on console entries, and
  sink-provenance (only the routing owner writes receipts — the R3 rule).
- Engine family conformance: the capture surface runs against every
  registered engine in `engine-families-platforms.test.ts`.
- API: route registration with tenancy ownership checks (404-not-403 for
  foreign sessions, per existing convention), OpenAPI emission, budget
  enforcement on the response envelope.
- MCP/CLI: catalog delta (16 → 17) with contract-sync tests updated; CLI
  subcommand returning the identical JSON projection; the frozen-profile
  counts asserted nowhere stale.
- Real-Chromium: one end-to-end — a fixture page with a failing subresource
  and a console error yields exactly the bounded facts, and a policy-denied
  navigation yields a `policy_denied` entry naming the denied hop.

## Non-goals

Debugger parity with chrome-devtools-mcp; response or request body access;
timing/performance data; any new execution capability (no eval, no fetch
proxying); retroactive capture before session start. If a use case needs
these, it needs a different tool — that is the comparison's conclusion, and
this design does not quietly widen it.

## Sequencing

Design review first (this packet). Then three PRs: engine capture + store +
units; REST surface + API gates; MCP/CLI catalog slice. Each carries its own
evidence record per T9.
