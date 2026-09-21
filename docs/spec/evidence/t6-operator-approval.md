# C1a operator action approval evidence

Base: develop `a57b143`, following #241. See the
[design](../design/t6-operator-approval.md) and [operator usage](../../operations.md#operator-approval-policy).

## Failing-first evidence

- Core reviewed lifecycle: 13 initial failures on absent owner operations; final
  coverage includes 17 reviewed tests plus 60 existing approval/budget tests (77).
- Service: six initial failures and one pass. Pending-token echo wrongly dispatched;
  uncontrolled reviewed mode was not rejected before allocation.
- Projection tests: SDK 6/6 red; CLI initially 5/6 red; routes 7/7 red on absent
  endpoints. New shared act-token forwarding and challenge diagnostics each received
  failing-first coverage, including a legacy-guidance regression.
- Registered-secret literal: one failing disclosure/refusal probe, then fixed by
  checking the same bounded detached data passed to the token owner. Vault and literal
  secret refusal assert no token/no dispatch; injected records cannot leak on query
  or decision. Missing reviewed-session tenant also received a failing-first probe.
- Adversarial mutation: four failing tests reproduced scalar and nested request
  substitution during awaited target resolution. Entry snapshot repair makes review
  and dispatch share captured parameters; approved originals remain stable and
  mismatched originals dispatch zero actions. Capture exceptions are sanitized.

## End-to-end and reuse

The compiled CLI fixture uses the existing FakeEngine/server/runAgentCli helpers:
pending action refuses, inspection returns the bounded action, explicit decision
approves, ordinary CLI action with the token dispatches once, and a fresh-ref token
reuse refuses with APPROVAL_REQUIRED. The approval token never enters engine data.
The synthetic effect is saving a setting, not submitting an application.

Protocol/SDK/CLI response contracts, OpenAPI freshness and bidirectional route parity
use existing checks. Review data uses existing bounded snapshot helpers; authority,
token capacity/index/cleanup and operation replay have one owner each. No dependency,
parallel store, executor, MCP privilege or CI job was added.

## Delivery and limits

Normal hooks, exact-head independent review and eight PR/post-merge checks remain
delivery gates. Preserve 1.9.1; record verified merge/run identities in the PR and
next checkpoint. This is explicit operator action consent only. C2/C3 complete
payload/attachment witness and qualified submission remain open. No live application
was submitted, and operator credentials do not prove human presence.
