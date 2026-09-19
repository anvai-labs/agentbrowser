# T3 navigation reset: local candidate

Status: focused and full extracted-package acceptance pass locally. Exact-head CI
and merge remain pending. This is not release evidence; T3 remains active.

## Qualified behavior

The candidate adds one `navigation-reset` case to the delivered 12-case bound-report
matrix. On one existing session and page, operator setup first loads the still-live
`pass` fixture and captures its current revision and button ref. The delegated QA
process then uses the compiled CLI to:

1. navigate to a fresh target fixture with `--wait-until networkidle`;
2. take a bounded snapshot and reacquire the current `Add` button;
3. attempt a click through the pre-navigation ref and receive `STALE_TARGET`; and
4. execute and replay the fresh request-relative outcome.

The navigation result and snapshot both identify the target origin, the snapshot
revision advances from 2 to 4, and the old and fresh refs differ. Before the fresh
outcome, independent source and target oracle snapshots prove that navigation and the
stale-ref probe caused no application claim, evidence read, action or effect. The fresh
outcome then passes with one scoped UI effect; exact-ID replay dispatches nothing.

## Failure-first and green evidence

The red run failed at the target-origin assertion while the page still reported the
source fixture. Adding the real CLI navigation made that assertion and the stale-ref,
oracle, bound-outcome and replay checks pass.

The focused green artifact reports 13 expected case verdicts, 11 CLI assertions and
11 exact-ID replays, two offline discovery calls, zero model calls and zero MCP calls.
Reports remain 340–923 bytes; the navigation-reset report is 802 bytes. Its recorded
CLI activity is one navigation, one bounded snapshot and one stale-ref probe.

The complete extracted-package acceptance passed all eight groups on Node v22.23.2,
using freshly compiled CLI/MCP binaries and a package stamped with base `4dd96e9`.
Its `dirty: true` and `releaseEvidence: false` explicitly retain the local candidate
boundary. The 13-case outcome matrix itself uses no MCP or model calls; other package
acceptance groups separately exercise MCP. The local context loader passes all 82
selections and its ten tests. Independent navigation code review is clean.

## Limits

This proves navigation to a declared start state on one page, invalidation of a stale
element ref and reacquisition of current UI state. It does not prove cookie, storage or
browser-context isolation. The slice adds no public regression command, reusable
export/integration, report adapter, dependency or CI job. Full local candidate acceptance
does not replace exact-head review, required PR CI or post-merge verification.
