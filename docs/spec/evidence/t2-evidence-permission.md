# T2 evidence permission gate

Status: implemented generic foundation (PR #206). Follow-up boundaries are documented
in [application permission](t2-application-evidence-permission.md) and the
[installed CLI matrix](t2-cli-application-outcome.md). Owner: `@agentbrowser/control`.

## Contract and reuse

An evidence source can declare `authorization: 'required'`. Its synchronous
`authorize(request)` receives the immutable registered source descriptor, exact verifier
ID/version, detached frozen raw verifier input, optional correlation ID and trusted
host context. The existing verifier parser still runs once against a separate copy;
policy inspection and caller/parser mutation cannot change the captured expectation.
The existing bounded JSON snapshot and synchronous-callback checks are shared through
one internal preparation helper, with no new package or dependency.

An authorized source returns `{ generation, currentGeneration }`, using a nonnegative
safe-integer generation. Missing/denied/throwing/asynchronous/malformed permission
blocks execution; rejected promises are consumed without exposing private errors.
The captured callback must report the same generation throughout the run. Policy owners
must advance it monotonically for every revoke/regrant or other permission change.
The registry cannot detect a policy owner silently reusing an old generation; after
any observed mismatch or failure, the prepared reader permanently fails closed.

`prepareRead` keeps its callable interface and adds `assertAuthorized()`. Protected
reads guard both sides of I/O, including calls outside the outcome polling loop.
The runner composes that guard with host authority around execution, reads, evaluation
and final output after all cleanup. Late invalidation removes the result and evidence
references, reporting dispatched work as unknown. Registered cleanup remains eligible
after denial/revocation. Unknown sources/capabilities and correlation mismatches remain
unsupported, checked before input parsing or policy invocation. Existing unprotected
sources retain their prior behavior.

## Reentrancy and provenance

Policy callbacks can synchronously change surrounding state. A failure-first review
test showed that replacing the caller's `assertAuthority` or cancellation signal could
bypass a subsequent check. The runner now captures all composition references and
verifier identity at entry, and copies cleanup registrations before invoking callbacks.
Correlation is captured once; a second preflight refusal cannot accidentally permit
dispatch. The host authority check sandwiches permission checks, with irreversible
invalidation after an observed failure.

## Qualification

Control regressions cover exact request identity, bounded frozen input, missing/denied
policies, asynchronous and thenable callbacks, malformed/accessor-backed grants,
descriptor/callback capture, generation change during execution/read/evaluation/cleanup,
late output withholding, and observed revoke/regrant. Reentrancy tests also replace
authority, signal, executor, dispatch classification, context, tested seam and cleanup
options while proving the original host contract remains in force.

Real delegated HTTP tests verify denied preflight returns blocked/not-started without
execution or evidence I/O, while cleanup-time revocation withholds output and records
an uncertain dispatched operation. Replayed operation IDs never redispatch. The tests
use a generic fixture and make no application-commit claim.

Validation on 2026-09-18: 146 control tests and 24 focused application HTTP/outcome
tests pass, along with control/API type-checks, packaged browser-free application
acceptance, all 82 spec context selections and documentation-link checks. Independent
review reproduced the callback replacement defect before the passing regression.

## Application composition boundary

Context is an opaque trusted host reference, not a new authenticated wire object.
Application composition must supply frozen authority-owned actor/mode/tenant, captured
adapter/resource/session-incarnation identity, and a prepared receipt reader. Its policy
must authorize the exact predicate and bounded input domain, and the narrow receipt
capability must retain that permission guard. The earlier receipt-drain foundation
remains necessary for deadline-abandoned application I/O; this gate does not track
arbitrary source or cleanup work.

No raw application route permission, mode profile, CLI/MCP command, wire schema,
production source or durable policy store was added by this generic slice. Qualify
application-bound permission through the existing CLI/service path, then use an independent app-issued
event/version discriminator to prove UI-caused commits. A pre-existing receipt alone
must never establish causality.
