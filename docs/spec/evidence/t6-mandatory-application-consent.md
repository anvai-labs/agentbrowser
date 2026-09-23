# C3b internal application-consent qualification

Base: develop `9c82a49` (#251). The [design](../design/t6-mandatory-application-consent.md)
passed independent adversarial review before implementation. This increment protects
declared application submission operations; public execution remains gated on C3c.

## Existing owners and observable guarantees

ApplicationAuthority captures `review: operator-submit` on write operations. Its
existing admission/dispatch path refuses absent policy or consent. One shared strict
request snapshot and intended-action builder bind tenant/session incarnation,
adapter/resource/binding generation, operation, operation ID, expected version and
business input. Protected preparation receives a frozen detached input; ordinary
preparation retains its behavior. Trusted parser semantics still require qualification.

Internal review generation takes a separate operator read admission, reserves no
operation ID and invokes no application preparation/effect. The service composes
that intent guard with the existing native-page/context/evidence helper. Its mandatory
policy reuses the C2d resolver, compares the independently configured action with the
actual intended execution, recollects the witness and consumes through ApprovalGate.
There is no second token store, executor, admission loop or operation ledger.

The final guard checks permission generation after source/host callbacks, then the
original page/context and callback-free application binding. An adversarial regression
caught and fixed a generation revocation in the last source callback. Revocation stays
latched after regrant. Refusal after consumption does not restore consent or dispatch.

Exact operation replay returns status without recollecting or submitting; a different
approval token conflicts. Known application CAS rejection remains failed with consumed
consent. A lost post-acceptance response remains unknown until an independently
read app receipt resolves it. Restart recovery remains T5.

## Evidence

- Control tests started with 25 failing cases. Additional failing-first regressions
  caught premature use of the final guard and mutable protected preparation input.
  The resulting protected-operation suite passes 42 cases alongside ordinary
  application/read behavior.
- Final evidence guard tests started with two missing-method failures; a separate
  adversarial regression reproduced revocation after the earlier generation check.
  The resulting evidence-review suite passes 32 cases.
- Service integration started with 17 failures. The completed suite covers 21 cases:
  separate review/decision/execution admissions, missing/pending/denied/expired/used/
  draft consent, provider absence, binding/page/permission changes, actual execution
  differing from token/provider, async resolver takeover, cancelled-read drain,
  last-permission-callback page replacement, CAS rejection and lost-return recovery.
- The existing Chromium witness fixture now opts into the same test owner's protected
  submission operation. It proves one accepted full payload with actual original uploaded
  bytes, plus refusal when the native/app answer changes after review. It reuses
  the already qualified native/app witness collector; no new browser fixture or
  production submit registration is introduced. The HTTP submit route stays denied.
- Four focused API files pass 106 tests: 21 consent integration, 47 independent owner,
  26 existing public evidence review and 12 real Chromium witness/transport tests.

The fake-source cases isolate adversarial control transitions; they do not claim DOM
qualification. The two added real Chromium cases supply native/app evidence for the
narrow cooperative fixture. Existing CLI inspection/decision transport qualification
remains green; CLI submission is not implemented here.

## Remaining gate and delivery

Public protocol/REST/SDK/CLI schemas still have no application approval-token input.
Successful internal service-policy tests use test-only access to its private authority;
ordinary public execution cannot bypass the mandatory guard. The default synthetic
adapter and HTTP route still expose no submit operation; tests explicitly register
the owner's protected operation. Source config and live portal consent remain unqualified.

C3c must design public review creation and protected-operation discovery/credential
projection, then qualify compiled CLI submission with named T2 independent acceptance,
drift refusals and lost-response reconciliation. Reuse these owners and helpers. No
live application, release, installed-service restart, T5 durability or completed T4/T6
claim follows from this increment. Milestone count stays 3/9; published 1.9.1 is unchanged.

Normal hooks, independent exact-head review, green PR/post-merge checks and explicit
merge-state/tree verification gate delivery. Immutable candidate/merge/run evidence is
recorded in the PR after those checks; no additional CI job or runner matrix is needed.
