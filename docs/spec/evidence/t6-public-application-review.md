# C3c public application review and independent acceptance

Scope: the [approved design](../design/t6-public-application-review.md), built on
C3b (#254) and security repair #256 (`5bdb89f`). Merged as PR #257 at `d53829e`;
published 1.9.1 and installed browser sessions are unchanged.

## Delivered contract

The operator-only REST `application/reviews` route, SDK `applicationReview` and
CLI `application review` create a pending complete-payload review. They reuse
SessionAuthority, ApplicationAuthority, ApprovalGate and the existing bounded JSON
reader. Inspection and decisions reuse the existing approval surfaces; execution
passes the token into the existing application executor. MCP remains optional.

A shared extractor derives only application routing identifiers from the bound
inner action. The provider independently reconstructs the action from trusted app
state. An untrusted source hint cannot register collectors or grant permission.
One strict capture helper freezes source metadata/callbacks and retains permission
revocation; no per-plan source owner, duplicate executor or token ledger is added.

Creation does not reserve the future operation ID or dispatch. Repeated explicit
creation can allocate separate pending tokens, bounded by the existing TTL/quota.
It rejects execution-operation headers and global CLI operation IDs. Unknown,
foreign, malformed or mismatched configuration refuses before acceptance.

## Failing-first and adversarial evidence

- Protocol/control/SDK/CLI regressions preceded implementation: missing public
  review, routing and consent projection failed, then passed with shared contracts.
- Independent review found two concrete API defects: a caller-owned request could
  mutate during application authorization, and the last host callback could revoke
  evidence after its previous check. Both service regressions failed before repair.
  Validation now detaches the whole bounded own-data request; final checks run host
  callbacks, check evidence permission, then check captured application/page/context
  owners without invoking host callbacks again.
- Accessor rejection, dotted contract IDs, reserved-discriminator mutation, source
  identity mismatch, provider reentry, cancellation/drain, quota, missing review
  policy and no dispatch/operation allocation are pinned by focused tests.
- Protocol/control/SDK/CLI builds and focused/broader suites passed. API review and
  HTTP suite: 45 passed. OpenAPI freshness passed; the updated route contract passed
  all 9 tests. Compiled SDK/CLI interface gate passed all 3 tests.

## Actual-surface qualification

The existing real Chromium draft/witness fixture now drives public compiled CLI
create -> inspect -> approve -> execute through the HTTP service. It independently
reads the application receipt through authenticated REST and the existing trusted
source registry. The named `synthetic.submission.accepted` verifier reports G6 with
`testedSeam: application`. The returned execution payload is not its own oracle.

The complete 13-test fixture passed before expanding the refusal matrix; the three
expanded public refusal cases then passed. Those cases change a committed visible
answer, a hidden native value, or file bytes while retaining file metadata. Each
records failed/not-dispatched execution, zero accepted submissions and zero external
HTTP attempts. Both normal hook suites passed the final combined 15-test fixture,
with 3,329 tests passing and 24 existing skips across the workspace.

Success proves exactly one acceptance and the original received file bytes. The
same permission owner supports two independently reconstructed planned operation
IDs. Wrong operation, draft incarnation, destination, attachment digest and version
fail the named verifier. Replays return recorded status without another effect.
A lost execution response remains execution/verification unknown. A separate fresh
authorized receipt read passes the same verifier without rewriting that original
unknown result or redispatching.

Delivery: reviewed head `e31df5b4b38b9378cb93d9f6d5c9843a58e54fae`, tree
`9c80b4a75f419de18da2c69f365c1d70740127b9`, retained by merge
`d53829e6c06e26b977bdd0396e61094282b4081c`. Independent exact-head SHIP review;
PR run `35700286133` and post-merge run `35700787754` passed all eight checks
without reruns. P0's next embedding design does not retroactively claim this synthetic
fixture is deployable production configuration.

## Remaining gates

This qualifies the synthetic cooperative adapter and a test-only receipt verifier.
It does not register production ATS sources, prove candidate/job eligibility,
qualify arbitrary portals, or provide restart recovery. T4/T6 remain active; T5 and
installed-harness T8 retain their own acceptance gates. See the
[progress table](foundation-progress-2026-09-20.md) and
[operator usage](../../operations.md#reviewed-application-submission-develop-candidate).
