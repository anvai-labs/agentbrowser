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
   clients require stable catalogs. Enforce profile policy at the service as well. **Implemented.**
3. Add scoped run-cursor/memory selection and accessible inline mode/decision UI using
   existing components. Measure cold/warm footprint before expanding functionality.
   **Delivered through PR #182.**

## TDD and acceptance

Reject unknown/missing modes, cycles, missing dependencies, escaped/symlinked paths
and oversized complete output with no partial emission. Every agent selection includes
core; only bounty inherits appsec. Engineering/task expansion is explicit. Test same
tenant/different principal and operator-mediated account/mode switches for stale-memory
leakage. An account change inside a live grant remains page/document-revision state.

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

The first local slice merged through [PR #180](https://github.com/anvai-labs/agentbrowser/pull/180)
at develop commit `a4b3328`:
`scripts/spec-context.mjs` resolves the manifest with deterministic dependency order,
reads only selected declared Markdown files, rejects unsafe paths/symlinks/cycles and
fails before output on file or complete-bundle budget violations. Markdown and JSON
outputs include exact serialized UTF-8 bytes and per-module SHA-256 hashes. The explicit
engineering check covers all 82 allowed mode/view/task selections and is wired into the
existing release-artifact gate; no runtime or development dependency was added.

The second slice adds one frozen protocol-owned mode/capability registry. Operators bind
a mode into each delegated bearer grant (`qa` remains the compatibility default); API
admission checks that profile before dispatch, and MCP projects the same capabilities
into a catalog fixed for the connection lifetime. CLI, SDK, OpenAPI and generated MCP
catalogs share that contract. Direct calls to omitted tools are denied at MCP and REST
boundaries. No dependency was added. Generated modern `tools/list` result sizes are
24,964 bytes unbound / 22,355 delegated for the full current browser profiles, 20,444 /
17,833 for audit, and 12 / 293 for application. These are serialized result bytes, not
model tokens or process memory; equivalent current profiles make no savings claim.

The third slice adds a non-secret cursor from the existing session authority. Service,
binding, session, epoch, mode and profile revision form the harness memory scope; the
cursor carries no credential, tenant, page content or private value. Mutable operation
status remains beside the stable cursor in the existing control/operation records.
Re-delegation, operator-mediated account/mode changes, session changes and restart
invalidate that scope. The existing operator page renders the canonical mode registry
as an inline native select and capability summary with normal keyboard controls.

The manual [qualification record](../evidence/t1-context-profiles.md) separates exact
catalog bytes, exact cl100k/o200k token counts and fresh-process cold/warm RSS medians.
The common MCP import dominates RSS, so no general memory-saving claim is made. No
dependency was added. Installed Codex/Claude/Victor cursor consumption remains T8 work;
the loader, cursor and catalog projection do not confer permissions.
