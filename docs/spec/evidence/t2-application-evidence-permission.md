# T2 application-bound receipt permission

Status: application permission composition delivered in PR #207 on develop. The separate
[installed CLI qualification](t2-cli-application-outcome.md) follows in PR #208.
These increments are not a release.

## Ownership and interfaces

`defineApplicationReceiptEvidenceSource` composes the existing application receipt
reader, evidence registry and permission guard inside the original admitted operation.
It adds no operation lock, executor, retry loop, receipt cache, store or dependency.
The source always requires both a business correlation ID and explicit permission.
An application binding or valid receipt ID alone does not grant delegated access.

The synchronous policy receives only the frozen registered source, exact verifier
ID/version, bounded frozen raw input, correlation ID and authority-owned identity:
admitted actor/tenant/mode, adapter, resource, session ID and incarnation. Session
metadata is not authentication. Policy must explicitly allow the complete predicate
and identity domain; there is no permissive mode default. Missing, denied, malformed,
throwing and asynchronous policies fail before action dispatch or receipt I/O.

The registry additionally accepts an exact `authorized_access_v1` permission envelope.
Its opaque access stays private to one prepared read and is sent only to the paired
source implementation. Legacy permission-only definitions and their three-argument
read callbacks retain their contract. Invalid envelopes never fall back to legacy
parsing. Direct registry reads use the same preparation and permission fences.

The application helper captures its prepared receipt capability and correlation in a
private read closure. The existing generation guard validates policy once and fences
permission changes, including revoke/regrant. Application authority checks surround
policy checks, receipt I/O and reference processing, and participate in the runner's
pre-execution and post-cleanup output checks. Revocation withholds late results and
references while preserving conservative execution status and eligible cleanup.

The service accepts either a prebuilt evidence registry or a synchronous lazy provider,
never both. The provider runs once after the service-owned application authority is
created and before allocation of owned background resources. Its frozen builder exposes
only `applicationReceipt(config)`, not the authority or arbitrary receipt methods.
Invalid or asynchronous providers fail construction; rejected promises are consumed.
This is trusted deployment configuration, not a request-provided plugin mechanism.
REST, SDK, CLI, OpenAPI and mode-profile permissions do not change; MCP stays optional.

## Qualification boundaries

Local deterministic tests exercise admitted identity, explicit policy mismatch,
malformed/async denial, captured callbacks, overlapping sessions with the same business
ID, and revocation in policy, generation checks, I/O and cleanup. They distinguish an
absent receipt (pending) from an available receipt. HTTP fixtures use the real service
provider and existing delegated outcome route; operation replay must not redispatch.
The application reader retains the existing admission-drain behavior for pending I/O.

These tests qualify permission to observe scoped application receipts. They do not
prove that this run's UI action caused a commit. The application adapter and deployment
policy are trusted synchronous configuration; this is not isolation from malicious
in-process host code. Generation owners must monotonically increment on policy changes.
Receipt retention and durable application identity remain application responsibilities.
No production evidence source is registered by default. Current T2 readiness and its
acceptance mapping are recorded in [foundation qualification](t2-foundation-qualification.md).

Validation on 2026-09-19: 185 control tests and 35 focused API tests pass,
including actual delegated HTTP observation and replay. Packaged browser-free
application acceptance, type checks, all 82 spec selections and documentation links
also pass. Failure-first tests reproduced
reference processing after revocation, mutable preparation callbacks, invalid provider
acceptance, resource allocation before construction failure and an unconsumed rejected
provider promise. The fixes reuse existing guards and keep legacy callback receiver and
argument counts. Independent adversarial review, commit/push hooks and delivery CI
passed for PR #207; its delivery record remains in that PR.

## Follow-up acceptance

The [installed CLI matrix](t2-cli-application-outcome.md) extends this permission boundary
with a controlled application-owned UI-to-receipt contract and independent negative
controls. Its G4 qualification does not make this helper a production causal source.
Durable recovery remains T5; independent production UI/API parity remains T4.
