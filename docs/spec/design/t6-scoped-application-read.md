# C2b foundation: prepared application reads

Base: develop `7f2e533` (#243). The named draft oracle can already be read through
ApplicationAuthority.execute. A service collecting evidence inside an admitted action
must not open a second admission or reinterpret an outcome receipt as draft data.
Add the smallest reusable read composition to the existing ApplicationAuthority.

## Interface and ownership

`prepareReadInScope(sessionId, {operation, input})` returns a prepared reader with
authority-owned identity, `assertAuthority()` and `read(signal?) -> Promise<unknown>`.
Pin a registered read-mode operation and private bounded input. Refuse unknown keys,
write operations and write-only identifiers before invoking an adapter's preparation
or execution callbacks. The outer request and input must be finite bounded JSON.
Do not expose private input in identity or diagnostics.

Share captured admission/binding/scope checks and trackReadInScope with the existing
prepared receipt reader. Receipt-specific semantics and its public surface stay
unchanged. No new registry, executor, operation ledger, route, CLI command or MCP tool.
Prepared read identity additionally names the operation; it is not a transferable
wire capability or a declaration that output is complete payload evidence.

Capture the exact session incarnation, admission object and application binding.
Check them before and after input inspection, authorization/preparation callbacks,
awaited execution and output snapshotting. Reentrant callbacks can replace authority.
Observed revocation is sticky; permission regrant cannot revive an old reader.
Combine caller cancellation with scope cancellation and account for outstanding reads
in the existing drain mechanism. Escaping a closed admission grants no future access.

Each read gets a fresh detached copy of the pinned input and runs preparation inside
the current checked scope. Require a read result and return only detached bounded
finite JSON from its value. Reject malformed/oversized output, wrong result kinds and
accessors. Preserve static authority errors; sanitize adapter/serialization exceptions
without private messages or causes. Trusted read adapters must remain side-effect-free:
the mode declaration does not sandbox arbitrary deployment callbacks.

## Failing-first acceptance

- Valid reads inside one operator admission; no new admission/ticket or write dispatch.
- Missing admission, wrong session, unknown/write operation and write-only fields
  refuse before preparation; caller input mutation cannot alter pinned input.
- Repeated reads detach output and prepare fresh input; primitive/null results work.
- Reentrant input/preparation/output inspection, binding replacement, same-ID session
  replacement, cancellation, scope closure and observed revoke/regrant refuse.
- Callback exceptions and malformed/oversized results produce static diagnostics.
- Outstanding unawaited reads drain; late results from revoked scopes are withheld.
- Existing prepared receipt/evidence tests remain green after shared-owner extraction.
- Read the actual C2a named draft fixture under an existing operator admission and
  prove unchanged version/bytes plus detached output, without browser installation.

## Remaining C2b and C3

This supplies authorized application data only. Next qualify explicit source/contract
selection, draft-to-page correlation, private review projections, UI commit agreement
and a fresh comparison before consent consumption. Identical answers from the wrong
draft cannot satisfy binding. C3 still owns atomic compare-and-submit and independent
acceptance; T5 owns restart durability. No live submissions or release promotion.
