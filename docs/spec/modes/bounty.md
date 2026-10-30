# Mode: researcher-directed bug-bounty assistance

Status: proposed profile layered on appsec; inherits its scope and execution contract.

## Incremental job and data

Assist a researcher with reproduction and report preparation for one authorized
program. Load the current program scope/rules version, selected finding and minimal
evidence references. Revalidate program scope and test authorization before running;
public reachability or a remembered rule is not permission.

Directory and policy browsing may need a headed context: HackerOne showed a
JavaScript-disabled wall headless in the first bounty run. Browse with
`--no-headless`, then use a separate scoped headless session for the authorized
pass. CLI session creation returns no page: follow it with `page create
SESSION --url URL`; MCP create includes an initial page id. Size budgets in
subrequests and redirect hops (about 120 per planned JS-heavy page, at least
150 for one page) and respect the program's published scanner cap. See the
[engagement operations guide](../../operations.md#engagements-authorized-testing)
for import sizing, traffic identity and ledger exports.

## Reuse and outcomes

Reuse appsec identity isolation, diagnostics, verification and report helpers. Add only
program-specific policy fields and report templates. No separate bounty executor,
scanner, browser profile store or transport. Track suspected/confirmed findings,
reproducer version, sensitivity and potential duplicate references without asserting
a platform has accepted the report. Bounty payout is never an execution success metric.

## Acceptance

Test rule changes, excluded targets, report redaction, unconfirmed claims and duplicate
reproductions. An approved test must not implicitly submit a report or contact a program.
Load only the current finding, not a global cross-customer vulnerability corpus.

Primary packet: T7 report/profile slice after appsec qualification and demonstrated demand.
