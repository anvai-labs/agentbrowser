# AgentBrowser 1.13.0 delivery record

Status: delivered and installed (2026-09-27).
Published from protected main `feddad9` (promotion PR #308); preparation PR #307
carried the 1.13.0 version synchronization onto develop `0b1daef`. Previous
published baseline: 1.12.0 at protected main `34b9b1b` (promotion PR #305), npm
publication 2026-09-26T11:27:23Z, Homebrew formula PR anvai-labs/homebrew-tap#77.
See the [changelog](../../../CHANGELOG.md#1130---2026-09-27).

## Scope

Minor release (new operator-facing surface):

- `AGENTBROWSER_CHROMIUM_ARGS`: extra Chromium launch flags, space-separated,
  applied to **headed chromium launches only**. The engine warns once at
  construction when the variable is set on either CDP attach path
  (`cdpEndpoint`, operator attachment), because attach paths can never apply
  launch flags. The headless pool keeps stock launch defaults by design
  (ADR-013) and firefox/webkit launches never receive the flags. Documented in
  `docs/operations.md`; six engine tests pin the working path, family scoping,
  and both warning variants.
- Repo-wide biome warning clearance with real enforcement: every warn-level
  source finding fixed individually, `noExplicitAny`/`noNonNullAssertion`
  promoted to error in source, a test-only override for `**/*.test.ts` and
  `**/test-support/**`, and `lint` scripts added to core, engine, protocol and
  testkit — previously absent, so `pnpm -r lint` silently skipped the packages
  holding most of the cleaned warnings.
- Docs: develop's hardened EDGAR recipe with the field-run one-query amendments
  technique grafted back; the consumer field handoff refreshed with 1.12.0
  dispositions; the research intake spec keeps develop's living status block.

## Review evidence

The feature PR (#306) took an independent adversarial review pass before merge.
The review confirmed the runtime behavior (attach-path unreachability,
semantics-preserving source fixes, test falsifiability) and falsified four
claims, all corrected pre-merge in commit `9f1dd16`: the variable is introduced
by this release (no prior occurrence in any tag — the "shipped inert" framing
was wrong), the zero-findings claim failed at the develop merge tip (three
findings fixed), the anti-drift claim was unenforced (lint scripts added), and
the new variable was undocumented. CI passed on PRs #306, #307 and #308 and on
the develop push merge (`9526432`).

## Publication evidence (independently checkable)

- Tag `v1.13.0` (annotated) → commit `feddad9`.
- Release workflow run 36334029648: all twelve jobs succeeded — tag-guard, five
  MCP binary builds and five CLI builds (native or Rosetta smoke), four server
  packages each passing extracted-package acceptance with real Chromium, npm
  publish, release publication (2026-09-27 16:39–16:47Z).
- npm: `@anvailabs/agentbrowser-mcp` dist-tag `latest` = 1.13.0; version
  published 2026-09-27T16:46:06Z (`npm view @anvailabs/agentbrowser-mcp
  version`).
- GitHub Release `v1.13.0`: 15 assets — 5 CLI binaries, 5 MCP binaries, 4
  server tarballs, `sha256sums.txt`.

## Homebrew and installed acceptance

- Tap: dispatch `update-agentbrowser.yml` (run 36334680136) opened
  anvai-labs/homebrew-tap#79. Its gated CI run 36334727711 required manual
  approval (`action_required` → approved) and passed, including the live
  victor PyPI contract test. The diff contained only versions, URLs and
  sha256 sums. Squash-merged 2026-09-27.
- Local Darwin ARM host: `brew upgrade` 1.12.0 → 1.13.0, `brew services
  restart`, `agentbrowser --version` → 1.13.0, service listening on
  127.0.0.1:5709, `brew livecheck --tap=anvai-labs/tap` clean for all five
  package definitions.

## Limits

Unchanged qualification limits: headed-session evidence is Darwin-only;
Windows has executable acceptance only; the release notes' smoke table states
per-artifact coverage. The new variable is an operator escape hatch, not a
policy channel — it widens what Chromium may do on launches the operator
already controls, and the egress choke point still gates every request. No
durability, recovery or anti-detection guarantee is implied.
