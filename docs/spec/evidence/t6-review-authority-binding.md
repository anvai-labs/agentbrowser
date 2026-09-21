# C1 review-authority foundation evidence

Base: develop `4b9b155` after C0 #240. Scope is the
[review-binding design](../design/t6-review-authority-binding.md), not an approval API.

## Failing-first and compatibility evidence

- Initial core suite: four failures for the missing review-version seam.
- Initial control suite: seven failures and one pass, including configuration cleanup
  touching a replacement session. New review projection was not present yet.
- Final focused core suite: four review-version and seven existing session-control
  tests pass (11). Control suite: 14 review-binding, 24 authority and 93 application
  authority tests pass (131).
- Existing application callback reentry test now checks the intentional failure
  transition: failed configuration takes over its captured owner; a pending read
  drains from PAUSE_REQUESTED/busy and rejects CONTROL_REVOKED before HUMAN_ACTIVE/idle.
  Cleanup never revokes a replacement registration's grant.

The implementation reuses SessionControl, SessionAuthority admission/scope/revocation,
and synchronousResult. No dependency, permission store, ledger, route, CLI command,
MCP tool or CI job is added. Epoch/replay wire contracts stay unchanged; the new
opaque review version and immutable projection are internal composition seams.

## Limits and delivery gates

The binding is not approval, a credential, proof of human presence, page freshness,
complete form evidence or a submission receipt. Configuration callbacks are trusted;
thenable rejection cannot cancel async work already started. C1 approval surfaces
and C2/C3 payload/submission qualification remain pending. Main/1.9.1 is unchanged.

Mandatory hooks, exact-head independent review and eight PR/post-merge checks gate
delivery. Record verified commit and CI identities in the PR and next checkpoint;
do not claim future CI success from local evidence.
