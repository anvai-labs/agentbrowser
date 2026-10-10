# Release 1.15.2 delivery record

Status: **released 2026-10-07.** Tag `v1.15.2` on main `47a32a6` (release run
37689266638, all assets + `sha256sums.txt` on the GitHub Release;
`@anvailabs/agentbrowser-mcp@1.15.2` on npm). Homebrew tap updated the same day
(anvai-labs/homebrew-tap PR #96, squash `99c4fc5`); main and develop back in sync
at `64f7362` (PR #380). Local 5709 brew service upgraded and restarted to 1.15.2.

## What shipped (TD-BROWSER-13: observation secret redaction — security)

Incident: an operator credential appeared in plaintext in an `observe` response
after a password fill (`../../AGENTBROWSER_PASSWORD_OBSERVATION_HANDOFF_2026-10-06.md`;
synthetic-only reproduction and qualification, the real credential never entered
this repository).

- Root cause (reproduced on HEAD): Playwright 1.62.1's `ariaSnapshot()` emits
  password inputs as plaintext `textbox` values (both the inline and `/value:`
  syntaxes); the parsed value flowed into observations, the ref store,
  `canonicalFingerprint` (targetFingerprint, STALE_TARGET messages) and native
  form evidence.
- One trusted sensitivity boundary at the DOM-binding point: ARIA values ride
  as untrusted until the bound node classifies non-sensitive; policy = native
  password/hidden inputs, credential autocomplete (`current-password`,
  `new-password`, `one-time-code`, `cc-number`, `cc-csc`, `cc-exp`), and
  node-lifetime explicit `sensitive` marks surviving show-password toggles,
  revisions and frames; unbound/unclassifiable elements fail closed.
- Engine-neutral: Playwright, Safari and Firefox engines each enforce the
  policy at their own describe/fill boundaries.
- `PageElement.valueRedacted` / `NativeFormControlEvidence.valueRedacted`
  (withheld, not empty); native evidence keeps unmarked hidden-input tokens as
  the documented witness-tamper exception; an explicit mark overrides it.
- Autofill: withheld receipts are `unverified` + `verificationWithheld` (per
  field and in the final sweep), never a false mismatch, never abort the loop;
  committed-selection attributes withheld for classified widgets.
- Approval-gate action fingerprints: per-instance keyed HMAC.
- Events envelope fix (the incident's CLI tooling bug): SDK object selectors
  always resolve to `{events, nextCursor}`; limit-only no longer returns a
  bare array; unfiltered selector returns the merged console+request ledger;
  REST `limit` without `type` answers 400; undefined/string selector keeps
  the legacy array.
- Honest boundaries documented (screenshots/PDFs, raw HTML, page-side
  exfiltration) in the TD and threat model.

## Qualification

- `packages/engine-playwright/src/observation-redaction.test.ts` (11 tests:
  both ARIA syntaxes; default + formControls observe; autocomplete classes
  incl. cc-*; show/hide toggles + explicit marks; frames; repeated
  observe/refStore; fingerprints + mismatch details; committed-selection
  withholding; marked-hidden native evidence; ordinary-field positive control).
- Full monorepo green (`pnpm -r test` exit 0; CI 13/13 on the release PR).
- Observation overhead (120-element fixture, 10 observes): mean 1027.1 →
  980.6 ms, p50 1086.8 → 1028.6 ms — no regression.
- Two adversarial review rounds; every finding fixed or recorded as wontfix
  with rationale (PRs #377, #378 conversations).

## Release-infra fixes landed during promotion

- `8956ddd` Windows server-exe compile: externalize playwright-core's
  undeclared lazy transports (`chromium-bidi`, `electron`) — Windows' static
  Bun resolution cannot resolve them (darwin can; host validation had missed it).
- `99c5dc3` cli-outcome acceptance budget 150 s (measured ~88 s of real work
  against the 90 s default; v1.15.1 passed at ~88 s, variance now tips it).
- `6ad6c75` Windows G2 gate assertion corrected (had never been green).
- Docs: TD-13 indexed; catalog counts corrected (17/15); threat-model rows;
  operations troubleshooting + upgrade notes; CLI events guide.

## Residual and follow-up

- Local live-canary against the 5709 service is blocked by the SSRF policy
  (loopback + `data:` both refused, by design) pending the owner's
  `AGENTBROWSER_ALLOW_LOOPBACK` decision; engine-level qualification above
  carries the release evidence. Note: brew plist env customizations (the old
  `AGENTBROWSER_ALLOWED_CIDRS` entry) are lost on `brew upgrade` — re-apply
  after upgrades or move the config out of the plist.
- Sandesha closeout (owner): credential rotation (SentinelPass entry 53),
  passkey enrollment retry (origin state verified clean through the full
  engine stack during the investigation —
  `../../AGENTBROWSER_WEBAUTHN_TLS_INVESTIGATION_2026-10-06.md`).
- WebAuthn TLS incident: not reproducible on the deployed binary across all
  commit modes; residual hypotheses + capture guidance in the investigation
  record.
