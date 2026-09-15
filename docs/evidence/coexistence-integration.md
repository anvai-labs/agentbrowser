# Coexistence integration candidate

This candidate combines the completed coexistence branch through `2db4b5a`
with the other workstream's committed form-workflow snapshot `9733507`.
It is prepared on `feat/delegated-coexistence-integration` in the existing
isolated worktree. The original AgentBrowser and codingagent checkouts are
not modified. No remote branch, workflow, registration or release is changed.

## Ancestry and scope

The earlier checkout baseline `5016364` was already an ancestor of our release
base `db860b6`; it did not require another integration. During this recheck, the
other workstream replaced that form-workflow commit with `9733507`, whose common
ancestor with our branch is `2acecaa`. This candidate merges that explicit
snapshot. It does not silently include later work or uncommitted files.

The automatic merge combined the code and found one add/add documentation
conflict in the interactive-forms recipe. The resolution keeps the recipe's
additional form guidance and corrects its fill-verification semantics below.
Formatting/build-script changes belonging to the input snapshot are retained.

## Integration fixes driven by regression evidence

The imported `expectValue` implementation issued **three input writes** for one
request when a page reverted the field. Its success payload also echoed a
password value. These behaviors conflict with delegated authority and the
single-operation reconciliation contract.

- Chromium now fills once, reads a native input/textarea once, and compares.
  A mismatch returns non-retryable `VALUE_MISMATCH` without refilling or exposing
  expected/actual values. Success returns `verified: true`, not the field value.
- Unsupported contenteditable readback is refused before filling. Firefox and
  Safari explicitly refuse this unqualified option before writing.
- The service passes only the verification boolean to REST/MCP/SDK callers.
  If a custom adapter accepts the option but supplies no verification evidence,
  the service reports failure and says the fill may have completed; it does not
  claim verified success or replay the write.
- The shared operator-panel scenario now checks mismatch and successful
  verification through in-process MCP, built Node stdio and Victor stdio before
  exercising duplicate suppression, takeover, manual input and grant replacement.
- OpenAPI is regenerated from the integrated implementation, including the
  previously unrefreshed delegated-control/operation endpoints and schemas.

The readback comparison is evidence at one instant. It does not prove a durable
application save or allow automatic retries. The independent application-outcome
fixture remains the business-state oracle. Firefox guarded-service promotion
remains refused; the two failed egress hypotheses are unchanged.

**Addendum (2026-09-15, from live validation on production form widgets):** the
single-read contract produced false `VALUE_MISMATCH` failures where a field's
async normalization landed after the readback. The mismatch path now settles
briefly and re-reads once — still one write, never replayed. `VALUE_MISMATCH`
details now carry `expected`/`actual` for fills not marked `sensitive`, giving
callers the widget's normalization without a second round trip; `sensitive`
fills keep the value-free error contract above, and success payloads still
return only the verification boolean.

## Validation

The native regression first observed three writes instead of one, and a password
string instead of a boolean. After the fix, the two new Chromium verification
tests and seventeen action-contract tests passed. The API missing-evidence
regression and the three shared transport variants pass. Safari's mock transport
suite verifies no driver call on refusal; native Firefox verifies the field stays
unchanged and ordinary filling still works with fresh refs.

The [Victor/native-browser evidence](victor-chromium-coexistence.md) describes
the combined acceptance and reproduction command. Full workspace checks use
explicit Victor and pinned Firefox configuration locally; ordinary CI retains
the native Node stdio path and labels unconfigured Victor as skipped. Existing
required jobs are preserved, and no GitHub runner is used to debug this candidate.

Before promotion, review this combined snapshot and run one consolidated CI
candidate. This local integration commit is not a pushed PR, published package,
live-account acceptance or contained-browser release.

The [packaged follow-up](packaged-coexistence.md) extends the existing artifact
acceptance job to check delegated operator/MCP handoff against extracted modules
and compiled clients, with independent application effects.

## Develop promotion review

Before the promotion PR, the candidate incorporated `develop` at `e25a0b2`,
including page URL/title discovery and `include: ["formControls"]`. The one
textual conflict joined both sets of action-contract regressions; no test set
was dropped. Review of the metadata change reproduced a registered secret in
the page title even though the URL was redacted. Both fields now use secret
redaction, with a regression that first failed on the leaked title.

An admitted title read that settles after takeover returns `CONTROL_REVOKED`
without its title and drains before human control resumes. The shared native
scenario now runs against both ordinary buttons and enriched role-less controls
through in-process, Node stdio and Victor MCP. All six variants preserve the
same independent two-effect oracle, revoked grants and stale-reference refusal.
Together with metadata/service and authority tests, the focused merge validation
passed 158 tests locally before CI submission.
