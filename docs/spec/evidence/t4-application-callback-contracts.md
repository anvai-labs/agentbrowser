# T4 Q0a application callback qualification

Base: develop `e69317ac8521228e84c189f69608dd3144e234f5`, after released 1.9.1.
Status: local qualification complete; PR/integration checks remain delivery gates.
Scope and invariants: [design](../design/t4-application-callback-contracts.md).

## Shared implementation

ApplicationAuthority uses existing synchronousResult for strict authorization and
preparation. Callback denial is generic; rejected promises are consumed. Binding
captures the checked tenant/resource and control identity/epoch, then refuses reentrant
replacement, takeover, rebind or busy state. Registration snapshots operation mode and
bound prepare functions and validates descriptors through the protocol-owned discovery
schema. The typed operation builder captures parser/executor references. Class receivers
and mutable authorization policy remain supported; caller objects are not frozen.

Recheck authorization after preparation, before the existing dispatch assertion. A
permission failure or malformed preparation records a failed, non-dispatched write;
restoring permission and retrying the same identity does not execute it. No new package,
service, persistence, protocol endpoint, dependency, MCP tool or engine was introduced.
CLI/SDK/REST continue through the existing shared authority owner.

## Falsifying evidence

All commands ran locally on Node 24.21.0. Synthetic fixtures only; no account/cookie data.

| Check | Result |
| --- | --- |
| Initial authority tests against prior implementation | 45 failed, 44 passed, 6 unhandled rejection errors |
| HTTP denial test against prior built control | 1 failed, 7 passed, 1 unhandled rejection error |
| Reviewer probe: policy revoked inside preparation | Reproduced unwanted effect before second authorization check |
| Added preparation/revocation regression tests before repair | 4 failed, 89 passed, 1 unhandled rejection error |
| Final authority suite | 93 passed; independent reviewer repeated 93/93 |
| `pnpm -r build` | Passed |
| Protocol package suite | 211 passed |
| Control package suite | 239 passed |
| API package suite, including real Chromium/stdio fixtures | 587 passed, 2 existing skips |
| `pnpm test:application-independence` | Passed production-tree audit and independent app-state oracle without API/browser adapters/drivers |
| `node scripts/check-doc-links.mjs .` | Passed |
| `node scripts/spec-context.mjs --check` | 82 selections passed budgets/structure |

The initial full API run was sandbox-blocked at local `listen` with EPERM, and the
initial deployment check hit sandbox DNS denial. Both were rerun with the required
execution permissions; the qualified results above are from those reruns. Deployment
reported an existing pnpm optional Vite-bin link warning; the audit and acceptance
process exited successfully. Do not count blocked attempts as product failures or passes.

Independent adversarial review found and then verified repair of preparation-time
permission loss: zero effects and `failed`/`dispatched:false`. Final commit review and
required CI must be green before merge. The PR records immutable head/check/merge IDs;
this file does not preclaim a merge or release.

## Limits and continuation

This hardens trusted deployment misconfiguration; it is not a stock remote exploit
claim. Catalog validation caps accepted descriptors at the protocol limit, but is not
a hard CPU/memory budget for hostile JavaScript getters. Trusted parser/executor closure
state and arbitrary application side effects remain deployment responsibilities.
Application authorization must be synchronous; asynchronous policy needs a separately
designed admission/lifetime contract. Production evidence, UI/API parity, binding UX and
T5 durable recovery remain open. Keep v1.9.1 immutable and use the
[progress/continuation checkpoint](foundation-progress-2026-09-20.md) for next slices.
