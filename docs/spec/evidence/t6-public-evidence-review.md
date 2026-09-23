# C2d public evidence review qualification

Base: develop `9a87b49` (#247). See the
[design](../design/t6-public-evidence-review.md). This slice connects host-created
qualified records to existing public inspection and decision surfaces; creation,
consumption, dispatch and acceptance remain distinct internal/future boundaries.

## Reused owners and surfaces

An optional trusted `evidenceReviewProvider` on service/server embedding receives
only immutable tenant/session/incarnation/page and source-owner/contract routing
metadata. The configured host independently resolves current action/source state.
No provider means refusal. Existing ApprovalGate, SessionAuthority, strict snapshot,
canonical bounds, prepared evidence review and source permission guards remain the
owners; no second registry, executor, token store, route or command is introduced.

The exact page and review context are captured before resolver callbacks. Reserved
inspection/decision goes through prepared review guards; callback/result errors use
static absence responses. Ordinary action approvals retain their existing contract.
The SDK methods and CLI commands need no execution changes. CLI help/docs distinguish
conditional private evidence from status-only output and from submission permission.

## Falsifying tests

Service tests were written first: configured public inspection failed at the prior
reserved-token refusal. They cover resolver capture, narrow immutable metadata,
source/action/generation mismatch, absent/invalid/async/accessor-backed results,
revocation/reentry, page replacement, static errors and secret disclosure refusal.

The existing synthetic Chromium draft fixture now uses the actual authenticated
server while retaining its independent application oracle and internal collection
helpers. REST, ordinary SDK and compiled CLI inspect/approve the same complete
witness. Default CLI text contains only token ID/status; explicit JSON returns the
private snapshot. Foreign tenants and delegated credentials are refused before
source selection. Access revocation blocks fresh reads; replay returns status without
private evidence. Regrant cannot resurrect old consent, and new app/UI answers make
fresh internal consumption fail. Review produces zero engine actions/submissions.

Independent adversarial review exposed an ordinary-approval async-boundary race:
takeover could occur between resolver completion and legacy disclosure/gate mutation.
A shared authority/context check now runs immediately after resolution. Both
regressions failed first: the inner service returned a stale view, and the old token
was approved. Both now pass, proving no disclosure and no old-context decision.

The focused service suite passed 26 tests; Chromium/HTTP passed 18 tests, including
eight ordinary approval transport regressions. All 643 documentation links passed. Broader validation and immutable delivery evidence belong in
the PR after mandatory hooks, exact-head review and green PR/post-merge CI.

## Limits and next step

The resolver is trusted deployment code, not caller configuration or proof that an
arbitrary collector is qualified. The synthetic collector covers a cooperative
native draft; this does not qualify hostile pages, arbitrary ATS widgets or production
sources. Operator credentials do not prove human presence. A decision approves the
stored snapshot; consumption recollects, but is not an atomic submission permit.

Next, design C3 for one application-owned atomic compare-and-submit operation and
independent acceptance, reusing the existing operation ledger and uncertainty rules.
Do not turn DOM check-then-click into an atomic-payload claim. Public create/consume,
live source qualification, candidate screening and process-loss recovery remain
separate gates. Published 1.9.1, main and live browser sessions remain unchanged;
T4/T6 stay active and finite completion remains 3/9.
