# Application operations under delegated authority

Status: typed in-process port, application-only lifecycle and the REST/SDK/CLI
surface are implemented; MCP tools, the operator binding UI and durable
application receipt qualification remain pending.
Transport, reconnection and durable recovery are specified in the
[shared infrastructure design](shared-session-infrastructure.md).
Baseline: `develop` at `ed8ac67`, after PRs [156](https://github.com/anvai-labs/agentbrowser/pull/156),
[157](https://github.com/anvai-labs/agentbrowser/pull/157), and
[159](https://github.com/anvai-labs/agentbrowser/pull/159). See the
[promotion and recovery audit](evidence/coexistence-promotion.md).

## Problem and boundary

A browser action receipt proves command completion, not an application commit.
The existing versioned-counter fixture proves UI/API parity, but direct commands
currently bypass session authority because it is test-only infrastructure. Exposing
that path as an agent tool before admission and resource binding would introduce
a second writer outside human takeover.

The implemented `@agentbrowser/control` package adds an application-owned operation
port behind the shared session authority. It requires no browser, WebMCP, model
SDK, planner, or service database. UI qualification remains a separate executable path against
the same application outcome oracle.

## Minimal contract

- Register a typed adapter in trusted server configuration, disabled by default.
  Its registration owns validation, application identity, permitted operations,
  resource/account scope, execute, and receipt lookup. Agent input cannot supply
  arbitrary endpoints, credentials, executable code, or replacement schemas.
- Bind an allowed adapter/resource to the session through operator control. A
  binding change invalidates review and grants. Agent discovery exposes only the
  current binding and its allowed operations.
- Admit every read and write through SessionAuthority, sharing the browser's one
  active-operation limit. Recheck the epoch immediately before external dispatch
  and before exposing output. Takeover revokes access immediately and waits for
  admitted work to settle.
- Require a caller-known operation ID and expected application version on writes.
  Fingerprints include adapter identity, resource, operation, arguments and actor.
  Preserve the explicit distinction between the service's control epoch and the
  application's business version.
- Let the application enforce authorization, compare-and-swap and durable
  idempotency atomically in its own transaction. An adapter acknowledgment cannot
  manufacture a verified application receipt. The existing in-memory fixture
  qualifies protocol behavior only; it is not durable storage evidence.
- Never replay an uncertain write or switch to a browser action automatically.
  Preserve its identifier for operator reconciliation through the application
  receipt port. Receipt reads also require current authority and resource scope.

## TDD acceptance sequence

1. No binding, wrong resource, wrong tenant, unknown operation and invalid input
   fail before any adapter callback. A default server exposes no application tool.
2. Browser and application operations cannot overlap. A takeover before dispatch
   produces no effect; takeover after dispatch withholds output and records
   uncertainty until work drains. Delayed callbacks cannot resume under a new grant.
3. Identical IDs do not dispatch twice; changed payloads conflict. A stale expected
   version produces no effect. Bindings cannot change under agent control.
4. A committed operation with a lost response is reconciled by receipt and the
   independent oracle; an adapter claiming success without an effect fails.
5. Human UI edits invalidate application versions. Direct API edits make a stale
   UI write conflict. Both paths independently demonstrate their expected effects.
6. A fresh service session can reconcile an application-persisted receipt without
   reviving an old grant. Use an application-owned persistence fixture before
   claiming restart recovery; never treat an in-memory record as such evidence.
7. Run the bound MCP path through Node and the configured Victor client. Add one
   extracted-package scenario after the port is qualified. Reuse existing CI jobs.

## Operator experience

The existing control panel should identify the bound application and resource,
the permitted operation names, the current authority state and any unsettled
write ID before delegation. Changing a binding requires a fresh review. Show
business-version conflicts separately from revoked control; they require
different recovery actions. An unknown outcome offers an authorized receipt
lookup and human reconciliation, never a default Retry button. Explain that
takeover withholds agent output immediately but cannot undo a committed external
transaction. Human edits outside this panel remain governed by application
authorization and version checks, not by a claimed global browser lock.

## Delivery order

First land the typed port, explicit operator binding and deterministic admission
regressions locally. Then wire REST and bound MCP with schema/SDK parity, and run
native UI/API outcome qualification. Keep provider registration and production
application credentials outside this fixture milestone. Defer transport-specific
WebMCP integration until it adds evidence beyond the stable application contract.

## Existing implementation seams

The browser `SessionCoordinator.create` path invokes `engine.createSession`
before storing session state. Adding an application command to that existing
browser-session endpoint alone would therefore retain a browser availability
dependency. Qualify the authority/adapter port without an engine first; before
claiming runtime redundancy, add an explicit application-only session lifecycle
or make browser attachment optional. Reuse the same tenant, TTL, cancellation,
takeover and operation controls, and test that a throwing browser factory is
never called for application-only work. Existing browser-session defaults must
remain unchanged. Packaged independence additionally requires checking imports
and execution from a production tree without installed browser drivers.
Keep the application-only composition path free of eager browser-adapter imports;
use a dedicated composition entry point or lazy attachment behind the existing
typed engine port. A fake browser engine is a test double, not the application
runtime's substitute for independent session ownership.

Use `packages/control/src/session-authority.ts` (re-exported by the API) for admission and dispatch/output
checks. Its `run` method owns the same `SessionControl` ticket used by guarded
browser pages; an application adapter must not create a second control instance.
`assert(sessionId, true)` immediately before a mutating callback marks dispatch,
and a revoked callback result is withheld by `run`. Application reads also need
admission, even though they do not create a write record.

Keep application bindings alongside the shared authority, weakly keyed by its
control instance so session removal cannot restore a binding. Core control state remains independent of
HTTP, credentials and adapter implementations. An operator binding change must
be rejected while work is active and invalidate any prepared review. Resource
authorization must use the authenticated tenant and trusted adapter policy;
accepting an operator-supplied resource string alone is insufficient.

The initial fixture can reuse `packages/testkit/src/versioned-app.ts` for the
independent business-state oracle. Its in-memory ledger cannot satisfy the
restart case. Add durable fixture acceptance only when the application port is
stable, without introducing storage dependencies into the browser control plane.

Before exposing REST/MCP operations, define how success, application rejection,
and uncertain delivery map to the existing operation record. A rejected business
version is a known no-effect result; it must not be reported as a verified commit.
A duplicate service request returns its control record, while application receipt
lookup is a separate authorized read. Neither permits automatic write replay.

## Delivered first slice

`ApplicationSessions` creates bounded, expiring application-only sessions without
constructing an engine. `ApplicationAuthority` also accepts the existing browser
session authority, so both paths share admission. Trusted adapters bind only to
operator-approved tenant/resources; a binding change invalidates prepared review.
Discovery, execution and receipt reads respect takeover. Writes require a stable
operation ID and expected business version; duplicate IDs return the operation
record, changed identities conflict, known application rejection records failure,
and lost results remain uncertain. No write fallback or automatic replay exists.

The package's deterministic tests cover these boundaries. The production
qualification deploys only control dependencies and rejects installed API/browser
packages and links escaping the extracted tree, then executes delegation, an
application effect, duplicate suppression, takeover and receipt lookup. Separate
negative controls prove the dependency auditor rejects contaminated trees.
This evidence uses an in-memory application oracle and does not establish durable
receipts, external application authorization, or HTTP/MCP delivery. The host must
authenticate principals before using the programmatic API. Existing HTTP, CLI,
MCP and operator-panel behavior is unchanged until those surfaces are qualified.

The resource-bound refinement enforces the 64 KiB canonical JSON limit during
serialization, including UTF-8 escaping and structure. It reuses serialized input
for write fingerprints and preserves a separate budget for binding metadata.
Inputs must contain own JSON data; accessors and sparse arrays are rejected.
Application-only sessions enforce monotonic TTL at admission, dispatch and output,
even when the event loop delays cleanup timers. Duplicate registration and stale
abort/page callbacks cannot replace or act under another owner. See the
[shared infrastructure refinement](shared-session-infrastructure.md#resource-bounds-and-lifecycle-refinement)
for the reasoning, continuity qualification and remaining transport boundaries.

## Delivered HTTP/SDK/CLI surface

The service composes an `ApplicationAuthority` over its own `SessionAuthority`
(`ServiceDependencies.applicationAdapters`; the server mirrors this as
`ServerOptions.applicationAdapters`). Adapters are deployment-injected trusted
code; request bodies can never register, select or re-scope one. Without
adapters the surface fails closed - no binding can exist, so discovery returns
none and execution is refused. Binding additionally requires a tenant, so the
unauthenticated local mode cannot bind even with a configured adapter.

Routes (all documented in `openapi.json`):

| Method | Path | Authority |
| --- | --- | --- |
| PUT | `/v1/sessions/{sessionId}/application` | Operator only, human-owned session (bind) |
| DELETE | `/v1/sessions/{sessionId}/application` | Operator only (unbind) |
| GET | `/v1/sessions/{sessionId}/application` | Operator with ownership, or delegated `application.discover` |
| POST | `/v1/sessions/{sessionId}/application/execute` | Operator with ownership, or delegated `application.execute` |
| GET | `/v1/sessions/{sessionId}/application/receipts/{operationId}` | Same read authority as discovery |

The delegated capability vocabulary gained `application.discover` and
`application.execute`. They are granted only to the dedicated `application`
agent mode - browser modes (qa/audit/forms/...) are deliberately fenced out so
an agent driving pages can never fall back from an application operation to a
browser click, and the application mode never receives browser capabilities.

Application routes are excluded from the controlled-session route envelope:
they admit themselves through the `ApplicationAuthority` (bind is an operator
`configure`; execute and receipt reads open their own scoped admissions
carrying the body's operation identity). An envelope ticket would nest a
second `begin()` and always report the session busy. The envelope's
principal/tenant match check still applies.

The SDK exposes `sessions.applicationBind/applicationUnbind/applicationDiscover/
applicationExecute/applicationReceipt`. The CLI adds an `application` command
group (`bind`, `unbind`, `discover`, `execute`, `receipt`); the write identity
for `application execute` is the existing global `--operation-id`, so repeats
of the same command print the recorded operation instead of re-executing.
Replays are first-class results shaped `{replay: true, operation}` (the
recorded operation carries the settled status) - the SDK's mutation machinery
deliberately does not intercept them, and read operations refuse a write
identity. Unbind, like bind, requires the human to own the session and takes
control as a side effect (epoch bump, prepared review invalidated) even when
nothing is bound.

An HTTP oracle test (`packages/api/src/application-http.test.ts`) re-drives the
versioned-counter fixture over the wire: wrong tenant and stale grants produce
zero effects; duplicate operation IDs replay without re-execution; a stale
business version is an admitted rejection, not an error; receipts remain
operator-readable after the grant that produced them is revoked; and one
admitted principal at a time holds for application calls too.
