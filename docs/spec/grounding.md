# Grounding layers and verification

Status: proposed shared verification model. Reuse existing identity/value evidence
and application authority; do not duplicate their native-value or authorization logic.

## Evidence ladder

| Layer | Grounding source | What it establishes | What it cannot establish |
| --- | --- | --- | --- |
| G0 intent | User request, trusted configuration, approved scope | Desired outcome and permitted activity | Actual execution or success |
| G1 authority | Authenticated principal, live grant, control epoch | Who can operate this session now | Business permission outside the bound application |
| G2 capability | Installed adapter and qualification fingerprint | Supported operation and known limits | Success on every website |
| G3 target | Current page/document, scoped node identity, complete candidates | Which observed object is targeted | Semantic business identity of a recycled DOM node |
| G4 action | Dispatch record and engine/application acknowledgment | Which command was attempted/completed | Persisted business outcome |
| G5 observation | Native property/selection, fresh UI or API read | State observed at a recorded boundary | Atomic transaction across multiple observations |
| G6 outcome | Application-owned receipt/version, independent test oracle | Specified business outcome under stated assumptions | UI correctness if the UI was bypassed |

A result identifies its required layer and achieved layer. No numerical confidence
score can replace missing evidence. Combining several weak observations does not
automatically create an authoritative receipt. Observation and application versions
belong to different domains; do not compare them as a shared counter.

## Resolution contract

Use exact stable business/test identifiers when available, otherwise qualified
semantic matching within a unique explicit block. Index the current bounded candidate
set by block identity, role, label and automation ID. Intersect constraints; never
choose the first match or preserve a global ordinal through repeated sections.

Native autofill's nearest-fieldset identity is an existing implementation, not a
universal block model. A future application block strategy must specify its scope
identity and replacement tests separately. Restricted label matching stays linear;
do not introduce unrestricted regex or arbitrary selectors as a convenience fallback.

Candidate uniqueness requires complete evidence within the scope. A degraded or
truncated snapshot cannot prove absence/uniqueness. Reobserve after navigation,
replacement or stale generation; refuse if required evidence is unavailable. Recheck
scope and node identity immediately before dispatch. Business-critical mutations
also need a bound business precondition or an application version check.

## Verification contracts

A trusted verifier descriptor declares: ID/version, input/output schema, required
capability, evidence source, observation budget, commitment predicate, redaction rule,
known unsupported cases and cleanup behavior. Descriptors reference registered
functions; tool callers cannot supply scripts. Keep validators pure and reusable
where possible; inject time, randomness and external reads at the owning boundary.

| Example | Correct predicate | Negative control |
| --- | --- | --- |
| Native input | Full private native property equals expected normalized contract value | Display excerpt matches but private suffix differs |
| Select | Committed option identity/value equals expected | Highlighted menu item without committed selection |
| Chip membership | Stable committed member IDs match requested set | Search text matches while no chip exists |
| Save profile | Independent record/version or bound application receipt matches | Button animation succeeds while API rejects |
| UI authorization | Target user cannot cause/read the forbidden outcome through UI | Hidden button with callable unauthorized endpoint |
| API authorization | Role-specific API result and server state satisfy policy | UI restriction incorrectly counted as API enforcement |

Verification retries are bounded reads. They cannot replay writes unless a distinct
operation contract proves retry safety and fresh admission permits it. A later field
can invalidate an earlier one; final form verification rechecks the required set.
Label verification as sequential/non-atomic unless the application supplies an
atomic outcome. DOM markup is evidence about markup, not all live element properties.

## Evidence integrity and independence

Evidence references carry source, source version, binding/generation, capture time,
completeness, sensitivity and integrity digest. A digest detects byte changes, not
truth or authenticity of the producer. Evidence used by the oracle should not be
derived solely from the same execution receipt it is meant to verify.

For fixture-backed tests, trusted server state is read separately from browser
actions. In third-party sites without an oracle, report the strongest observable
claim and its limitations. Never infer acceptance from absence of an error message.
Preserve failed/unknown evidence rather than replacing it with a successful retry.

## Grounding regression gates

Include stale same-URL reloads, recycled nodes, repeated labels, truncated candidates,
cross-field resets, optimistic UI followed by server rejection, misleading page text,
forged success narration, delayed commits, revoke-before-output, and expired evidence.
Every verifier needs a false-positive control; a success-only fixture cannot qualify it.
