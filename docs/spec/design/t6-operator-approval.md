# C1a: explicit operator action approval

Base: develop `a57b143` (#241). Scope: one existing action under stable human
control, not complete-payload consent or autonomous submission. Reuse ApprovalGate,
SessionAuthority review binding, route operation ledger and CLI/SDK command owners.
See [failing-first and compiled CLI evidence](../evidence/t6-operator-approval.md).

## State and authority

An operator selects `policy.approval.review: "operator"` when creating a controlled
session. Only actions classified `required` enter this lifecycle; `allow` remains
allowed and `deny` wins. Mode is stored by the service, not selected per action.
Uncontrolled session creation with this mode refuses before allocating a browser.

Existing ApprovalGate owns one shared bounded map/index/capacity for both token
kinds. Legacy confirmation remains compatible and cannot query/consume reviewed
tokens. Reviewed lifecycle: pending -> approved -> used, with pending/approved ->
denied and pending/approved -> expired. Repeated approve on approved or deny on
denied is idempotent without extending expiry. Denied/used never reapprove. Deny
and consume have one synchronous final check/transition ordering. Terminal entries
are queryable until expiry or ordinary bounded cleanup; absence proves no permission.

The private immutable snapshot binds the action and current authority context
(tenant/session/incarnation/epoch/review version). Core validates bounded data;
the service authenticates context through reviewBindingInScope for all operations.
Only current operator HUMAN_ACTIVE scope can create, inspect, decide or consume.
Takeover/configuration/handoff/session replacement invalidate old context; material
page/action drift is checked again on dispatch. Every returned nested view detaches
stored data. No raw private values enter errors or trace events.

Reviewed actions snapshot the complete finite JSON request at service entry, before
any await (64 KiB serialized UTF-8, 4,096 nodes, depth 16). Dispatch and consent use
that same private request, including nested targets/options/paths. Caller mutation
during target resolution cannot change either side of the binding. Legacy input
semantics stay unchanged. No callback/Proxy sandbox is implied.

## Surface and reconciliation

GET `/v1/sessions/{sessionId}/approvals/{tokenId}` returns a bounded private action
projection and status. POST to the same resource accepts only decision approve/deny.
Both require operator authority; POST uses the existing operation-ID wrapper. No
delegated capability or safe-read mutation bypass. SDK and CLI use these routes;
CLI creation enables the mode explicitly and existing JSON action input carries the
token. MCP is optional and receives no new approval privilege.

An APPROVAL_REQUIRED response gives a known challenge ID. Inspect and decide it,
then execute via the ordinary action route with a distinct execution operation ID.
After response loss, reconcile the operation record AND current challenge state:
replay returns historical operation status, not reusable approval. Do not retry an
uncertain dispatched action using a new ID or regenerate consent automatically.

## Qualification and limits

Failing-first tests: pending/legacy/denied/expired/reused tokens, wrong context,
mutation of nested views, reentrant inspection, concurrent consume/revoke, quota and
shutdown. Service/route tests: authenticated vs delegated/foreign/unauthenticated,
control invalidation, risk precedence, action drift and exactly one synthetic effect.
SDK/CLI validate bounded wire responses, command metadata and private-output handling.
Use existing OpenAPI/route/schema/release gates; add no CI job or dependency.

Vault references requiring reviewed approval are unsupported in this slice: reference
identity does not bind resolved value, and review output must not expose vault secrets.
Bounded snapshots containing registered secret values or dictionary keys also refuse
before token creation; private query/decision outputs use the same disclosure guard.
An upload action projection does not prove file bytes or the eventual transmitted
payload. Whole-form/PDF/job witness, qualified submit and independent receipt remain
C2/C3. Operator credentials identify authority, not human presence. Keep them outside
delegated harnesses. No live applications or release promotion belongs to this slice.
