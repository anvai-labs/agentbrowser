# T6 widget commitment repair

Status: implemented candidate after develop `cc4d72e` (T3 completion). Independent
review and delivery remain pending. This is a bounded repair of existing strategies,
not completion of T6 or a new release.

## Failure and shared ownership

The [research code audit](../../research/2026-09-browser-agents/code-findings.md)
found 15 autofill test declarations but only 11 registered tests. Moving the nested
widget suite to its intended scope, before changing expectations or runtime code,
produced 15 executed tests: 12 passed and three failed. The dormant malformed-request
case expected a report, although the existing parser rejects before observation or
dispatch. Its corrected assertion preserves that preflight contract and proves zero
browser calls; it does not weaken request validation.

Immediate verification could accept the custom search input as a selection, while final
verification discarded valid committed evidence if that input was empty. Each trusted
strategy now owns one commitment predicate, used by both passes. Native controls retain
native-value comparison. The single-select strategy requires the committed label;
add-only chip selection requires the requested label in complete bounded membership.
Query text, missing commitment and incomplete membership cannot prove success.

The existing Playwright DOM evidence capture recognizes only known React Select-style
value-container markup. Membership is limited to 32 labels, 512 characters per label
and 16,384 serialized characters. Excess count is rejected before label traversal;
oversized evidence is marked incomplete rather than truncated into a matching value.
These bounds constrain retained evidence, not every intermediate DOM allocation.

Real-browser qualification exposed an additional stale-ref failure after the initial
widget click. The strategy now reobserves and uses the existing scoped resolver and
pinned node and original block identity before typing and option selection. It does
not make old refs valid or introduce automatic remapping. Adversarial review found
that reacquiring a ref must not adopt a new block after a click/input handler moves
the same node. Both movement regressions failed first, then require exactly one or
two dispatched actions respectively and an untouched suffix. Ambiguity or replacement
also stops further strategy writes.

No new orchestrator, dependency, protocol command, transport or CI job is introduced.
The existing serial loop, admission, observation budget, scoped resolver and receipts
remain authoritative. `actual` retains native input readback, which may be empty for
a successfully committed custom selection.

## Falsifying checks

Unit cases cover valid committed selection with empty input, query-only false success,
lost commitment before the final pass, incomplete chip membership and changed matching
scope before typing/selection. Real engine capture also rejects overlong single/chip
labels and oversized serialized membership without truncating them into valid proof.
Existing native value, identity, suffix-stop and no-replay cases
remain required.

The existing real Chromium/stdio fixture submits one structured five-field payload:
two repeated-block inputs, one native select, one custom single-select and one chip
addition. Separate negative-control requests prove query-only and 33-chip incomplete
capture fail verification. Duplicate operation refusal and no form submission remain
asserted. The shared test harness accepts an explicit bounded 30-second request timeout
for this fixture; its 10-second default and production transport budgets are unchanged.
This avoids splitting the successful bulk case into per-widget requests.

On Node 24.21.0, the focused autofill/service selection passes 26 tests (21 + 5);
the real Chromium/stdio fixture passes in 28.30 seconds, the existing real engine
identity fixture passes, and stdio continuity passes. API/engine type checks and lint
pass; lint retains pre-existing warnings. The expanded failing-first run independently
reproduced query-only false success plus valid committed single-selection and chip
membership failures before the predicates changed. Documentation links and all
82 spec-context selections pass, with 11 context tests including the T3 gate transition.
Independent review and PR/post-merge CI identities belong in the delivery record.
The optional Victor test path is not an installed-harness qualification unless that
specific environment is explicitly run and recorded.

## Remaining scope

This qualifies a synthetic markup contract, not a particular installed React library
version or the two live application targets. Option matching still chooses the existing
first exact/prefix candidate; popup scoping, duplicate-option ambiguity, async readiness,
focus purity, recycled options, removal/replacement, reusable mappings and alternate
browser engines need their own qualification. Fixed strategy waits remain. A successful
field receipt is not proof of business submission, durable recovery or transactionality.

T6 remains active. Next concrete repair is Q0a's fail-closed application authorization
callback guard, followed by the mapping and commitment packets. Keep those changes in
their existing owners and retain CLI-first, optional-MCP composition.
