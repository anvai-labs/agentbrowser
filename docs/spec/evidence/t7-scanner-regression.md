# T7 slice 3 evidence: scanner-regression adapter

Status: fixture gates 24/24 in `@agentbrowser/audit` (visual 10 +
accessibility 7 + scanner 7 + closure rows); the REAL-ZAP recorded run
EXECUTED 2026-10-03 (see below). Design:
[t7-scanner-regression](../design/t7-scanner-regression.md).

## Fixture gates (deterministic CI, no ZAP required)

A fixture HTTP server emulates the ZAP JSON API surface the adapter
uses (version, scan start/status, alerts, newSession). Ten rows:
the vulnerable/fixed fixture pair differs (seeded SQL-injection
finding vs none); out-of-scope scan targets refused typed
(POLICY_DENIED/SCOPE_HOST_DENIED); empty and malformed scopes refused
at construction; out-of-scope alerts dropped and counted; baseline
within/regression/resolved semantics; budget exhaustion typed
(SCAN_BUDGET_EXHAUSTED) with `newSession()` cleanup counted; invalid
scope entries refused; and the no-new-runtime-dependencies row.

## Real-ZAP recorded run — EXECUTED 2026-10-03

- **Scanner**: OWASP ZAP 2.17.0, official image
  `zaproxy/zap-stable:latest`
  (sha256:781a2bdaea47324e7bab583e2263f21d257b0aee61ed51521a5be45f5f5081ef),
  daemon mode with the JSON API enabled (keyless, throwaway container).
- **Target**: a local vulnerable fixture (reflected parameter, missing
  security headers) reachable to the container at
  `http://host.docker.internal:8099`.
- **Setup steps the client deliberately does not automate**: the
  target was accessed through ZAP first (enters the sites tree —
  without it the scan start refuses `url_not_found`); scope inclusion
  was not needed for a direct URL scan.
- **Result**: the adapter's `scan()` ran the real active scan to
  completion and returned SIX findings, all normalized with correct
  risk names through the name-form path:
  1. Cross Site Scripting (Reflected) — pluginId 40012, HIGH,
     parameter `name` — the seeded vulnerability, confirmed.
  2. Cross Site Scripting (DOM Based) — pluginId 40012 as observed
     verbatim in the run's raw JSON (ZAP's DOM-XSS active-scan rule
     raises the 40012 id with the DOM-Based name; the URL carried the
     injected `<script>alert(5397)</script>` probe), HIGH.
  3. Missing Anti-clickjacking Header — pluginId 10020, parameter
     `x-frame-options`, medium.
  4. Content Security Policy (CSP) Header Not Set — 10038, medium.
  5. X-Content-Type-Options Header Missing — 10021, low.
  6. HTTP Only Site — 10106, medium.
  `droppedOutOfScope: 0` (every alert was in scope).
- **Corroborating discoveries from the run**: ZAP serializes alert
  risk as the capitalized NAME (the adapter's dual-form normalization
  exists because of this run); ZAP's alerts `baseurl` filter is a URI
  PREFIX (the adapter queries the ORIGIN for the same reason); ZAP's
  scan start refuses a URL that is not in its sites tree
  (`url_not_found`) — the adapter's error now carries the bounded
  scanner body so operators see these causes.

Two findings that would have broken real runs were caught by the
adversarial review BEFORE this recorded run (risk-name serialization;
baseurl prefix filtering) — the recorded run exercised and confirmed
both fixes against the real scanner (they existed in the merged code
before the run; the run did not motivate them). Norm noted for future
recorded runs: archive the fixture source and the sanitized raw alert
JSON with the record, so the finding table is independently
re-verifiable rather than transcribed.

## Remaining

- Slice 4 (report templates) — on demand.
- The recorded run above used the development host's docker; a
  constrained-mount / CI-hosted ZAP run remains optional depth.
