# T3 bound regression report: delivered foundation

Status: delivered to develop through PR #212 at commit `4dd96e9`. T3 remains active;
T7 and the T3-dependent T8 gates remain closed.

## Delivered foundation boundary

The first T3 foundation adds one protocol-owned bound TestCase report and extends the
existing packaged CLI/application acceptance. The descriptor has 1–16 assertions and
requires at least one required assertion. Completed results and captured invocations
are an exact ordered bijection; skipped assertions have no invocation. Aggregate truth
is bound to the captured case, environment, request, verifier, UI seam and operation
IDs. Required skip, unknown verification, setup failure and cleanup failure cannot pass.

The implementation reuses the bounded JSON snapshot, request-relative outcome parser,
outcome pass predicate, compiled CLI/service fixture and independent application
oracle. It adds no public CLI command, API endpoint, SDK or MCP projection, dependency,
runner, store or CI job.

## Controlled 12-case matrix

| Case | Qualified observation |
| --- | --- |
| `pass`, `pass-repeat` | Both pass from fresh sessions and produce distinct scoped UI application events. |
| `lost-response` | One effect and its receipt pass without replaying the write. |
| `historical` | A same-business-ID generic receipt created through operator application execute remains exactly equal in the independent oracle but cannot satisfy this UI run. |
| `ignored` | Browser acknowledgement without an application receipt remains unknown and non-passing. |
| `failed-action` | Failed browser execution cannot be repaired by evidence reads. |
| `stale`, `wrong-resource` | Competing state or a changed resource cannot be attributed to the requested UI operation. |
| `api-shortcut` | A distinct-ID operator API mutation changes application state but cannot satisfy the UI assertion. |
| `required-skip` | Discovery may run; no assertion, replay, claim, read or effect occurs, and the case cannot pass. |
| `partial-setup` | Setup fails after resources exist; the report remains non-passing and the outer finalizer closes retained resources. |
| `cleanup-failure` | A passing assertion plus failed session operator cleanup remains non-passing; the outer finalizer still closes the retained session and fixture listeners. |

Case `cleanup: "complete"` means session operator cleanup completed before the report
was parsed. The later process-level finalizer owns fixture listeners and every session
retained after partial setup or cleanup failure. Its failure fails the whole harness,
even if the bound report itself passed.

## Local measurements

The pre-merge local matrix passed all 12 expected case verdicts. Ten cases executed one compiled
CLI assertion and one exact-operation-ID replay; required-skip and partial-setup
executed neither. Two offline CLI discovery calls established local version metadata.
Model calls: 0. MCP calls: 0. Serialized reports ranged from 340 to 923 bytes. The two
fixed runs returned different application event references. Independent oracle counts
confirmed effects, claims and reads rather than trusting the CLI projection alone.

The complete extracted-package acceptance passed all eight groups under Node
v22.23.2, 37 executable/package helper tests passed, and the protocol suite passed
206 tests. Independent code rereview was clean after five findings were fixed. The
candidate explicitly reported `releaseEvidence: false` because the tree was dirty.

PR run `35459535641` and merge run `35459717523` subsequently passed all eight
required checks. Adversarial review `133085aa` was clean. These gates qualify the
merged foundation; they do not convert the earlier dirty artifact into release evidence.

The environment report used the actual CLI `--version`, local CLI `describe`, service
health, authenticated engine state and child fixture identity; the bound parser pins
their projected values. This controlled fixture has an exclusive UI actor and qualifies
G4 only. It is not a production causal source or G6 qualification.

## Delivery limits

The foundation does not complete the reusable user-facing regression workflow,
Playwright/Vitest export, JUnit/HTML reporting or durable run history. Its 12-case
delivery did not include navigation reset; a separate
[13-case local candidate](t3-navigation-reset.md) now covers that risk and passes
full package acceptance; its exact-head CI and merge remain pending. Neither slice unlocks T7 or the
T3-dependent part of T8.
