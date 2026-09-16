# T1: selective context and capability profiles

Status: active. Repository: agentbrowser; harness integration coordinated with T8.
Depends on: T0. Inputs: core, architecture, state-memory, interfaces.

## Reuse and scope

Use the documentation manifest as the context-loader input. Runtime mode descriptors
belong to the existing composition/registry owner and canonical schemas. Do not turn
Markdown into runtime permissions. Reuse one catalog projector and existing credentials.

## Slices

1. Implement the proposed dependency-free local spec loader and validate manifest
   closure/paths/budgets. Read declared files only; output hashes and exact bytes.
2. Add trusted runtime mode descriptors with fixed per-connection tool profiles where
   clients require stable catalogs. Enforce profile policy at the service as well.
3. Add scoped run-cursor/memory selection and accessible inline mode/decision UI using
   existing components. Measure cold/warm footprint before expanding functionality.

## TDD and acceptance

Reject unknown/missing modes, cycles, missing dependencies, escaped/symlinked paths
and oversized complete output with no partial emission. Every agent selection includes
core; only bounty inherits appsec. Engineering/task expansion is explicit. Test same
tenant/different principal and account/mode switches for stale-memory leakage.

A hidden tool called directly must still reject when the profile/grant disallows it.
Pending operations survive a bridge profile refresh without being replayed. Document
when a fresh harness context is required to remove already-loaded sensitive information.
Compare loaded modules, schemas, transmitted bytes, actual model tokens and RSS separately.

## Completion / stop

Close R06/R07 and context parts of R11/R16 with evidence. No new browser/scanner/model
dependency in the bridge or application-only composition. Do not claim runtime savings
from Markdown size alone. Stop dynamic catalog switching if the installed client cannot
refresh safely; qualify a fixed-profile connection instead.

## Current implementation state

The first local slice is implemented on the stacked `feat/context-profiles` branch:
`scripts/spec-context.mjs` resolves the manifest with deterministic dependency order,
reads only selected declared Markdown files, rejects unsafe paths/symlinks/cycles and
fails before output on file or complete-bundle budget violations. Markdown and JSON
outputs include exact serialized UTF-8 bytes and per-module SHA-256 hashes. The explicit
engineering check covers all 82 allowed mode/view/task selections and is wired into the
existing release-artifact gate; no runtime or development dependency was added.

Runtime tool profiles, service-side profile admission, run cursors, UI and model-token/
RSS measurements remain separate slices. The loader does not confer permissions.
