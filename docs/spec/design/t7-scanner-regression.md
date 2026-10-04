# T7 slice 3: scanner-regression adapter (OWASP ZAP) with role/business-logic fixtures

Status: slice 3 DELIVERED 2026-10-03 (the ZAP-API client adapter and
its fixture gates; the real-ZAP recorded run is availability-gated —
no ZAP on the development host, docker present for a future run). Task packet:
[t7-audit-security](../tasks/t7-audit-security.md) ("Security
regression: external ZAP/Burp adapter plus a role/business-logic
fixture"). Dependencies: T3 (complete); the T7 slice-2a scope policy
supplies the engagement boundary this adapter enforces on the scanner.

## Choice and reuse

**OWASP ZAP over Burp**: open-source, API-scriptable (JSON REST), an
official container image, and a stable alerts model. Burp's
programmatic surface is commercial and GUI-centric; not chosen. The
packet's prohibitions are honored literally: the adapter BUILDS NO
scanner — it drives an installed/launched one over its API, normalizes
alerts into scoped findings, and compares them against an acknowledged
baseline. No vulnerability payload database: payloads belong to ZAP's
active-scan policy, not to this repository.

## Module and closure

Lives in `@agentbrowser/audit` (slice 1's package), absent from the
default dependency closures (the existing gate-7 row already pins
cli/mcp-server/api free of the package; zero new runtime dependencies —
the adapter speaks ZAP's REST API over `fetch`).

## Semantics

- `ZapClient` — a bounded client over ZAP's JSON API: `version()`,
  `scan(target)` (start, poll to completion within an explicit budget —
  on exhaustion the scan is stopped server-side best-effort and the
  failure is typed `SCAN_BUDGET_EXHAUSTED`), and `newSession()`
  (cleanup; the fixture-gate row invokes it explicitly). Alert
  collection happens inside `scan()`: the ORIGIN is used as ZAP's
  baseurl filter (ZAP prefix-filters alert URIs — a path target would
  silently hide sibling-path alerts), and alerts are fetched without a
  count cap.
- **Scope enforcement at the adapter boundary**: the caller supplies
  the engagement's allowed hosts (exact or `.suffix` entries, aligned
  with the slice-2a scope policy's shape; the adapter compares
  host:port, so a non-default port must appear in the scope entry).
  Alerts against out-of-scope hosts are DROPPED and counted
  (`droppedOutOfScope`), and `scan()` refuses a target outside the
  scope outright. The scanner cannot widen the engagement. Risk values
  arrive from real ZAP as capitalized names ("High") and from fixtures
  as numbers — both are accepted, and an unknown value fails typed
  rather than degrading to informational.
- **Findings and baseline** (slice 1's acknowledged-set semantics,
  reused): `compareScannerFindings(result, baseline)` — new alert
  signatures regress, disappeared ones resolve, acknowledged-only is
  `within-baseline`. A finding signature is
  `(pluginId, url, parameter)` — deterministic across runs of the same
  scanner version.
- **Installed-scanner honesty**: `version()` is recorded in every
  result (`scannerVersion`), satisfying "installed scanner version and
  capability scope are recorded". There is no availability-gated
  real-ZAP test in the suite: the Status line records the real-ZAP run
  as skipped on the development host (no ZAP installed; docker present
  for a future recorded run) — the CI-gated fixture rows carry the
  adapter's logic meanwhile.

## Honest boundary (the packet's egress rule)

The scanner probes the TARGET at the HTTP layer, outside
agentbrowser's browser choke point entirely. Nothing in this slice
changes agentbrowser's egress guarantees, and no test-mode flag may
present scanner coverage as browser containment. The role/business-
logic fixture (a local vulnerable-app/fixed-app pair) exists to make
the scanner's findings differ deterministically — it is not a claim
that the adapter covers what the browser choke point covers.

## Fixture gates (deterministic, no ZAP required)

A fixture HTTP server emulates the ZAP JSON API endpoints the adapter
uses (version, scan start/status, alerts):

1. Vulnerable fixture: the seeded finding (e.g. a reflected parameter)
   is normalized into a finding whose signature matches the seeded
   vulnerability.
2. Fixed fixture: the same scan yields no such finding —
   vulnerable/fixed fixtures DIFFER.
3. Scope: an alert against an out-of-scope host is dropped and
   counted; a scan target outside the scope is refused typed
   (`SCOPE_HOST_DENIED` — the same sub-code the slice-2a policy uses).
4. Baseline: acknowledged findings are within-baseline; a new finding
   regresses; a resolved one is reported.
5. Budget/cleanup: the budget path fails typed when the fixture never
   completes a scan, and the adapter explicitly cleans up via
   `newSession()` (the gate invokes and counts it).
6. Closure: still no new runtime dependencies (fetch only).

## Real-ZAP recorded run (availability-gated)

When a ZAP is launchable on the host (local install or the official
container image), a recorded run drives the REAL scanner over the same
adapter against the vulnerable fixture and records the installed
version and alert set. When unavailable, the run records its skip with
the reason (installed-harness pattern) — the CI-gated fixture rows
above carry the adapter's logic either way.

## Deliberately out of scope

- Active-scan payload policy customization (ZAP's own), Burp support,
  report templates (slice 4), and any wiring into the default
  surfaces. The adapter library and its gates are the slice;
  consumption arrives with the audit mode/profile work.
