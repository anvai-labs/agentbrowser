# Agent implementation task packets

Status: implementation activated by the user's subsequent foundation-first instruction.
The table records the delivered state as of 2026-10-15, reconciled item by item against the
packets' acceptance lists (published baseline 1.18.0, promoted to main via #471). "Complete"
means the manifest dependency gate is satisfied; open follow-ons are named in the row.
Reading this task list alone does not authorize implementation or publication;
follow the current user-authorized scope.

## Start a task with minimal context

Read shared core, the selected mode, this execution protocol once, and one task packet
with its declared inputs from the manifest. Do not read every mode or historic ADR.
Use `node scripts/spec-context.mjs --mode qa --task t2`; it selects the explicit task
view with a 64 KiB complete-context ceiling. A task whose hard dependency is not marked
complete is rejected. `--list` and `--check` expose selection metadata and validate all
declared files and budgets without contacting a service.

| Task | Current state | Delivered or next gate | Hard task dependencies |
| --- | --- | --- | --- |
| [T0](t0-contract-catalog.md) | Complete | Released discovery/catalog foundation. Delivered since: the 100-step plan cap (#478) and output schemas for six more MCP tools with the structured-error envelope (#482); the last six tools' schemas are in flight | None |
| [T1](t1-context-profiles.md) | Active | Local loader, fixed profiles and run cursor delivered; Codex-path and Claude-path cursor consumption/retirement qualified (2026-10-03/04); same-tenant/different-principal admission pinned (#476). Open: the mode-footprint refresh. Victor gated on aiserver1's gateway (owner reconciliation 2026-10-15) | T0 |
| [T2](t2-shared-execution.md) | Complete | Shared execution/evidence shipped; production evidence still gated | T0 |
| [T3](t3-qa-regressions.md) | Complete | Delivered through #231, released in 1.9.1. Follow-on: a documented `test evaluate` CI entrypoint | T2 |
| [T4](t4-application-parity.md) | Active | REST/SDK/CLI shipped; synthetic UI/API parity, C3c public consent, trusted native-read composition (#259), binding UI (#261), receipt UX (#262) qualified; production gates remain (requires authorized live targets) | T2 |
| [T5](t5-durable-recovery.md) | Active | FULL CI-gated adversarial matrix (32 distinct rows): process-loss, anchor, quota, privacy, read-only-FS, disk-full — all CI-blocking. Operator reconciliation procedure DELIVERED. C4b PARTIAL: the protocol field, capability check and discovery exist, but the requirement is not yet in the operation fingerprint or review intent, an explicit `ephemeral` is refused, and REST does not publish `writeExecution`; the journal is not wired into the service. Remaining: F3 deployment (launch durable store), historical recovery (J3/J4, proposed) | T2 |
| [T6](t6-widget-strategies.md) | Active | Mapping, uploads, native/app witnesses, C3c synthetic submission, E0a/E0b eligibility, N0 document read, first E0c listing-capture slice delivered; remaining gates owned by the consuming workflow (E0c/E1 private policy, live workflow qualification) | T2 |
| [T7](t7-audit-security.md) | **Complete** | ALL slices delivered (the appsec/bounty parity condition on T4 stays open): 2a scope enforcement (primitive + surface, 12 real-Chromium gates plus 14 policy unit tests), 1a visual audit adapter, 1b accessibility adapter (axe-core, page-scripts-never-executed), 3 ZAP scanner-regression adapter + real-ZAP recorded run (2.17.0), 4 SARIF 2.1.0 report adapter, shared finding-baseline store — 36/36 gates; audit suite 53 tests after the 2026-10-15 labelling and role-access work | T3; T4 additionally for application-security parity |
| [T8](t8-harness-qualification.md) | Active | Codex-path qualification COMPLETE (tool-call, slice-2 dimensions, cursor choreography, resilience, real-ZAP run — 2026-10-02/03); Claude-path cursor choreography COMPLETE (2026-10-04); Victor gated on aiserver1's gateway, not TLS (owner reconciliation 2026-10-15). Open: MCP cancellation, then the qualification re-runs on both CLIs | T0; profile/full-run slices also require T1/T3 |
| [T9](t9-release-hardening.md) | Recurring | 1.18.0 released 2026-10-15 (run 38741154969); the tag-ancestry gate (#475) passed on it; least-privilege permissions and SHA-pinned actions delivered (#481). Every release needs fresh promotion evidence. R14 closes with the owner's tag ruleset and `npm` environment protection | T0; each release also requires its changed tasks' acceptance |

## Current continuation (2026-10-15)

Published baseline **1.18.0** (TD-BROWSER-15/16, data-review fixes, tag-ancestry gate); records
in ../evidence/release-1.16.0.md through release-1.18.0.md. Main and develop in sync (#483).

## Earlier continuation (2026-10-07)

Published baseline: **1.15.2** (security release, 2026-10-07) — TD-BROWSER-13
observation secret redaction: engine-neutral value withholding at the
DOM-binding boundary (password/hidden inputs, credential autocomplete incl.
cc-*, explicit sensitive-fill marks with node-lifetime persistence),
`valueRedacted` surfaces across protocol/native evidence, autofill
`verificationWithheld` receipts, keyed-HMAC approval fingerprints, and the
events-envelope fix. Full delivery record with exact identities:
../evidence/release-1.15.2.md. Homebrew tap shipped same-day (tap PR #96);
the local 5709 service runs 1.15.2; main and develop are in sync at `64f7362`.
Prior baseline: **1.15.1** (maintenance, 2026-10-03, promoted via #374).

Delivered this session (2026-10-02..05, 14 merged PRs #356–#372):

- **T7 scope enforcement** — `EngagementScopePolicy` (hosts/paths/methods/
  identity-bindings/expiry/budget) as the outermost restrict-only layer;
  service surface (`policy.scope` / MCP `scope` / CLI `--scope-file`);
  12 real-Chromium gates plus 14 policy unit tests (corrected 2026-10-15; earlier
  records said 24). ALL slice-2a gates green.
- **T7 audit adapters** — visual (pixelmatch), accessibility (axe-core in a
  Node DOM, page scripts never executed), scanner-regression (OWASP ZAP),
  shared finding-baseline store, SARIF 2.1.0 report adapter — 36/36 gates.
  Real-ZAP recorded run executed against ZAP 2.17.0.
- **T5 journal** — read-only-filesystem and disk-full adversarial lanes;
  the operator quarantine/reconciliation procedure; the C4b precondition
  audit (all five delivery gates pass); the C4b execution-requirement
  protocol field + capability check + discovery surface.
- **T1/T8** — Codex-path cursor consumption/retirement (all seven fields,
  takeover revocation, fresh-grant recovery, old-epoch refusal); Claude-path
  cursor choreography (same lifecycle); provider-path resilience
  (service down / restored / blackhole timeout); slice-2 acceptance
  dimensions (union, enum, nested-object/array, typed evidence).
- **N2** — the OS-enforced egress pairing prerequisite documented.
- **Records** — the operator quarantine/reconciliation procedure; the docs
  consistency sweep (30 stale status lines corrected across 24 files).

## Next items (gated or on demand)

### User gates

- **F3 authorization** — every technical precondition passed (the C4b
  precondition audit confirmed all five delivery gates; the operator
  reconciliation procedure is delivered). C4b execution-requirement selection
  is partial: explicit `ephemeral`, discovery and the durable operation identity
  (J-b) are in place, but `durable` execution is refused until a journal store
  is wired into the service (J-d); the `durableJournalAvailable` flag alone does
  not enable it.
- **T4 live-target evidence** — requires named authorized targets and the
  consuming workflow to drive the gates.
- **Victor TLS trust** — the Sandhi gateway CA must be trusted in Victor's
  transport; the aiserver1 infrastructure (inferflux, sandhi-proxy) needs
  systemd units so services survive WSL restarts.
- **develop→main release promotion** — the full stack is promoted (#374);
  the next release checkpoint (1.16.0+) needs fresh promotion evidence
  for the post-#374 commits.

### On demand

- T7 slice 1b depth: axe in a browser context (needs the injection decision)
- CI-hosted ZAP depth run (docker present; adapter ready)
- T8 Claude depth: act/navigate under delegation (not just control reads)

### Owned elsewhere

- T6 E0c/E1 gates: private policy, live workflow qualification (the
  consuming workflow must drive them)
- T8 Victor live loop: blocked on the TLS trust decision (above)

Use-case gates: the automated-testing use case (vision priority 1) needs T4
production evidence, T6 live gates and T8 installed qualification.

## Next items (post-1.15.2, in dependency order)

1. **Credential-handling milestone (TD-BROWSER-13 §5)** — the durable fix the
   redaction release paved the way for: opaque vault-secret references
   resolved inside a trusted local broker, filled only into the bound HTTPS
   origin and freshly identified field, redacted success/mismatch receipts;
   no secret in model context, argv, environment, logs or files. Preserves
   SentinelPass master-password step-up for grant creation; retrieval grants
   stay exact-entry/read-only.
2. **Observation probe batching** — fold the per-element sensitivity probe
   into the existing isVisible/isEnabled round trips or batch per frame
   (measured within noise on the 120-element fixture; batching removes the
   extra round trip on value-bearing-heavy pages).
3. **T9/ops: branch-protection docs-context fix (owner decision)** — the
   required `build`/`deploy` contexts exist only in the path-filtered docs
   workflow, so any PR without a docs/ delta stays BLOCKED (release-prep and
   back-sync PRs hit this repeatedly during 1.15.2; dispatch-created check
   runs do not satisfy merge validation). Drop those contexts from required,
   or adopt the docs-delta convention permanently.
4. **T9/ops: brew service env durability** — plist env customizations are
   lost on every `brew upgrade` (the stale ALLOWED_CIDRS entry vanished
   during the 1.15.2 upgrade). Re-apply per upgrade or move the decisions to
   a durable config surface; the AGENTBROWSER_ALLOW_LOOPBACK choice is the
   owner's (page→service-self escalation disclosure applies).
5. **T7 reports (slice 4, on demand)** and the availability-gated real-ZAP
   depth run.
6. **T5 durable-recovery enablement** — runtime selection, concrete store
   enablement, recovery (F3); still gated on explicit authorization.
7. **T1/T8 installed-harness qualification for Victor and Claude** (Victor
   still gated on the TLS trust operator call).
8. **Sandesha closeout (owner, outside this repo)** — credential rotation
   (SentinelPass entry 53) and passkey enrollment retry on the fixed 1.15.2
   service; the WebAuthn investigation record holds retry + capture guidance. The bounty
use case (vision priority 5) additionally needs T7 scope enforcement
(DELIVERED), stays manual-submission by policy, and permits live targets
only with explicit authorization.

## Foundation-first refinements

F1 all-hop egress enforcement: DELIVERED 2026-09-30.
F2 clock-movement conformance rows: DELIVERED 2026-09-30.
F3 durable-journal runtime enablement: **user authorized**; C4b is partial
(J-b identity, J-d runtime wiring and deployment of the durable store remain).
N1 bounded network-error observation: DELIVERED (slice 1 in 1.15.0; G4
events replay in 1.15.0).
N2 OS-enforced egress pairing: prerequisite documented
([t7-os-egress-pairing](../design/t7-os-egress-pairing.md)); enforcement NOT SHIPPED.
Rationale and sequencing: [foundation-refinements.md](foundation-refinements.md).
