# Coexistence promotion and parallel-session recovery

## Accepted source and CI

| Change | Accepted head | Merge into develop | Validation |
| --- | --- | --- | --- |
| [PR 156](https://github.com/anvai-labs/agentbrowser/pull/156): delegated control, independent browser and application qualification | `f3e257d17be7dcd503f43f23a94bed5623279d80` | `7c826463ebfb70e50daec0ea00743bb943d2582a` | All eight [PR checks](https://github.com/anvai-labs/agentbrowser/actions/runs/34982405862) passed |
| [PR 157](https://github.com/anvai-labs/agentbrowser/pull/157): bounded native test scheduling and qualified host selection | `c3649d592fb606124e56aed540d534cf1c36c5d1` | `9e2e612e91f5dcb32b31cb726175a3875573c01e` | All eight [PR checks](https://github.com/anvai-labs/agentbrowser/actions/runs/34985332187) passed |
| [PR 159](https://github.com/anvai-labs/agentbrowser/pull/159): closed-popup diagnostic evidence and Docker-capable runners | `ad400f69a25ebeb25db7302e708236ba697054c7` | `8a336daf8aa753ab550a611971effdbc290323ef` | All eight [PR checks](https://github.com/anvai-labs/agentbrowser/actions/runs/34993531194) passed |

Final develop [post-merge CI](https://github.com/anvai-labs/agentbrowser/actions/runs/34994841533):
**all eight checks passed** on `8a336daf8aa753ab550a611971effdbc290323ef`.

All three merge commits retained their two parents, and each merged tree was compared
byte-for-byte with its accepted PR head. No release tag, main promotion, package
publication or owner-service restart was part of this integration.

A subsequent independent session completed the overlapping release work through
PRs [160](https://github.com/anvai-labs/agentbrowser/pull/160),
[161](https://github.com/anvai-labs/agentbrowser/pull/161), and
[162](https://github.com/anvai-labs/agentbrowser/pull/162). Main at
`ae91d34317a9113c7a02be759937b965c1148905` and develop at
`0ad12776a62a750267362c25e673cf80eaf906e8` both passed their post-merge CI.
Release [v1.8.14](https://github.com/anvai-labs/agentbrowser/releases/tag/v1.8.14)
published successfully, with fifteen assets including checksums; npm independently
reported version 1.8.14 and its integrity digest. The Homebrew formula update is
remote commit `fcc21d8f6c1d5b7dd6ffe8c643b0665500281315` in `anvai-labs/homebrew-tap`.

Our redundant PR 163 was closed after comparing its candidate with released main:
the only remaining differences were the unnecessary 1.8.15 version bump and a
workflow comment. It had no CI run to cancel. This session did not retag v1.8.14.
Victor's isolated transport fix is PR
[1067](https://github.com/anvai-labs/victor/pull/1067), accepted CI candidate
`88ded936749ef03520e8579167323f39f3dde9b2`; CI Success passed, while maintainer
review remained required. Auto-merge is queued without bypassing that review.

The first develop [post-merge run](https://github.com/anvai-labs/agentbrowser/actions/runs/34982827120)
failed during Firefox session startup. Its history remains visible. The bounded
follow-up then exposed permitted IPv4-mapped loopback failure on the
`dataserver2-standard-5` container. The organization's generic `ubuntu-latest`
label also selects shared containers and WSL workers; it is not a native-host
qualification. Test now defaults to Ubuntu 24.04, the hosted image used by the
complete green integration run, with `CI_TEST_RUNNER` for a qualified alternate.
Obscura retains its own qualified runner override. Docker uses `CI_DOCKER_RUNNER`,
with a hosted default; this repository sets it to the existing `docker-host` pool
after the generic label selected WSL without a reachable daemon. These fixes do not remove a test,
change a production deadline, relax network policy, or retry failed writes.

Workspace packages execute sequentially in CI, with at most two Vitest workers;
Firefox files execute sequentially. Tests still create their own overlapping
operations to exercise concurrency. All eight existing CI jobs remain in place.
Only obsolete failed PR runs were cancelled; integration push runs were retained.

The exact bounded test command passed locally with native Firefox, Chromium and
Victor configured: **1,496 passed, 14 existing platform skips**. Both full commit
and push hooks passed. Native Firefox qualification includes ten tests; the
separate deterministic egress/transport/worker suite passed seventeen tests.
CI reports its own platform/client skips and retains extracted-package acceptance.

The second develop [post-merge run](https://github.com/anvai-labs/agentbrowser/actions/runs/34986768453)
exposed a popup closing during interception setup. A native regression reproduced
the driver error; PR 159 records verified target closure as a structured error
that still rejects qualification. Unexpected errors still propagate. See the
[Firefox evidence gate](../firefox-egress-gate.md) for the exact limits.

## Parallel-session audit

The attempted force-push shown in the parallel transcript had not reached the
remote when the session stopped. The audited remote tips were:

| Snapshot | Commit |
| --- | --- |
| Original develop | `e25a0b2369bb93c6498786aaccec0f8001d35cac` |
| Remote fill-expect-value | `cab37fe6e27aef2a4c2d4bb77ae5dc593a0e27ed` |
| Remote workday-recipe-patterns | `9733507413b7c6b58d011804b6f35c1a14ce6e14` |
| Rewritten local fill-expect-value | `c508f2c0aaedc6435f2267f0a06964b4708354d9` |

The local rewrite removed the ADR-021 documentation index entry and the
formControls troubleshooting entry. Its union conflict resolution introduced a
TypeScript parser error in `action-contract.test.ts` (`'}' expected`). The
integration preserves both documentation entries and both complete test sets.
The original checkout was left clean and unchanged on the rewritten local tip.

The original fill branch's automatic refill, value echo and retained refs after
mismatch were deliberately replaced with one-write, value-free verification and
stale-reference invalidation. That reviewed behavior change is not a claim that
the old branch is byte-identical to the integration. The recipe snapshot and
previous packaged-coexistence snapshot remain ancestors of merged develop.

Six recovery refs under `refs/archive/promotion-audit-20260915/` retain the
original and rewritten histories (`integration`, `packaged`, `fill-before`,
`fill-rebased`, `recipe`, `develop`). A complete recovery bundle was created and
verified at `/private/tmp/agentbrowser-promotion-audit-20260915.bundle`.
No parallel branch was force-pushed, reset or deleted during this work.

Resume further work from fresh develop or the isolated integration worktree.
Do not force-push the old local fill branch or merge overlapping PRs 154/155
without reconciling their differences with the accepted verification contract.

## Next bounded slice

The [application-authority design](../application-operation-authority.md) resumes
work on a typed, application-owned operation port sharing human takeover and
browser admission. The typed port and independent application-only lifecycle are implemented in
`@agentbrowser/control`; HTTP/MCP surfaces and durable receipts remain pending. In particular, current session creation
still invokes a browser engine; a new tool alone would not remove that dependency.
