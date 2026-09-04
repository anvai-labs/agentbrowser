# ADR-015: Single source of truth for cross-package contract primitives

**Status:** Proposed
**Context:** 2026-08-31
**Superseded by:** N/A

> Renumbered 2026-09-03 (v1.7.1 docs hygiene): landed as ADR-012, but that
> number was independently taken by
> [ADR-012: Snapshot-Plan Interaction Model](012-snapshot-plan-interaction-model.md)
> (Accepted, backs shipped code) before this one shipped. This doc — still
> Proposed, not load-bearing for any merged code — takes the new number so the
> Accepted one keeps 012.

## Context

ADR-002 established *protocol-over-implementation*: the versioned schemas and
types in `@agentbrowser/protocol` are the contract, and everything else consumes
them. In practice several primitives that **are** contract have been re-declared
independently inside each consumer, and the copies have already drifted. The
engineering-hygiene audit (`docs/hygiene-audit.md`, Theme B) enumerated the
concrete divergences; the ones that force this decision:

1. **Name collision.** `ActionEffect` is exported as a classification *union* in
   `protocol/types.ts:230` and as an unrelated *result interface* in
   `engine/types.ts:162`. A module importing both silently keeps whichever it
   imported last. The engine's shape also duplicates protocol's existing
   `ActionResult` (`protocol/types.ts:426`) — so the name is simultaneously a
   collision and a synonym.

2. **The `e<rev>_<ord>` ref grammar** (an ADR-004 protocol concept) is declared
   **four times in three incompatible forms**: capture-group regexes in
   `core/action-executor.ts:39` and `api/service.ts:161`, a capture-less regex in
   `cli/cli.ts:67`, and a **string** in `mcp-server.ts:71` that gets re-wrapped as
   ``new RegExp(`^${REF_PATTERN}$`)`` (double-anchored).

3. **Validation is hand-rolled per surface** (`typeof x !== 'string'` checks in
   `api/server.ts`, MCP, CLI) even though `protocol/schemas.ts` already defines
   `SessionRequestSchema`/`NavigationRequestSchema`/etc. with the real min/max/enum
   constraints. The TypeBox schemas are never invoked at runtime.

4. **The SDK types have drifted from the protocol** despite `docs/audit.md`
   recording `SessionRequest` as "reconciled": SDK `SessionRequest` has a
   *required* `tenantId` (protocol: optional), a loose `engine?: string`
   (protocol: `EngineType`), and is missing `policy`, `ttlMs`, `idleTimeoutMs`,
   and `cookies`. SDK clients therefore cannot express per-session policy at all.

5. **Utility taxonomy is copy-pasted**: `UsageError` (mcp + cli), `formatError`
   (mcp + cli, already diverged on the `STALE_TARGET` hint), and the
   supported-format list (5 places, only one includes `'schema'`).

The common failure mode is not "it's broken today" — it's that each of these
requires an N-file edit to change safely, with no compiler or test guaranteeing
the copies stay equal, and several have **already** fallen out of sync.

## Decision

**Contract primitives live once, in `@agentbrowser/protocol`, and every other
package imports them. Surfaces may present them at different altitudes but may
not re-derive them.**

Concretely:

1. **Canonical constants & grammar.** `protocol` exports the ref grammar as one
   regex plus a helper — `export const REF_PATTERN = /^e(\d+)_(\d+)$/;` and
   `export const parseRef = (s: string) => …` — and the supported-format list as
   one `const FORMATS = [...] as const`. All four surfaces + core import them.
   No local `REF_PATTERN`, no local format arrays.

2. **Runtime validation is derived from the existing TypeBox schemas, not
   re-hand-rolled.** `protocol` exports thin validators
   (`validateSessionRequest(body): SessionRequest`, etc.) compiled from
   `schemas.ts`. API middleware, MCP tool handlers, and the SDK client call these;
   the manual `typeof` checks are deleted. The schemas remain the single place
   constraints are stated (and stay the source for `openapi.json`).

3. **No duplicate type names for distinct concepts, and no re-declared shapes.**
   Rename the engine's `ActionEffect` interface to reuse/extend protocol's
   `ActionResult`; keep protocol's `ActionEffect` union and give it a named alias
   (`ActionEffectType`) reused by the engine/testkit element shapes. Replace
   `EngineTarget` with `type EngineTarget = ElementTarget`. Fix the
   `'page navigated'` event literal to `'page.navigated'`.

4. **SDK types mirror the protocol.** The SDK re-exports protocol request/response
   types (or derives thin aliases) rather than defining parallel interfaces;
   `ActionRequest` adopts the protocol `SupportedAction` discriminated union so
   invalid action/field combinations fail at compile time.

5. **Shared surface utilities get one home.** `UsageError` and `formatError`
   (including the `STALE_TARGET` remediation hint) move to a single module both
   MCP and CLI import — either `protocol` (for `UsageError`, a contract-level
   error taxonomy) or a small internal `surfaces` helper for presentation-only
   formatting. The engine's `RequestPolicy` contract documents the exact error
   type/code an implementation must throw to block.

## Consequences

- **Easier:** a grammar/constraint/format change is a one-file edit that
  propagates by import; the compiler catches consumers that fall behind. SDK
  clients gain per-session policy and compile-time action validation for free.
  Adversarial review is simpler — there is one definition to check, not four.
- **Harder / trade-offs:** `protocol` gains a small runtime surface (validators,
  helpers) beyond pure types — it already ships `@sinclair/typebox`, so this is
  in-character, but it must stay dependency-light to preserve ADR-002's
  zero-implementation-dependency rule. Compiling validators has a tiny startup
  cost, paid once.
- **Migration:** mechanical and incremental — each consumer swaps a local
  definition for an import in isolation; no behavioral change is intended, so the
  existing contract tests are the safety net.
- **Alternative — a separate `@agentbrowser/shared` package** for constants +
  surface utilities: **rejected as the primary home** for anything that is
  genuinely contract (ref grammar, validators, error codes) because that is
  precisely what `protocol` is for; a thin internal helper is acceptable only for
  presentation-layer formatting that is not part of the wire contract.
- **Alternative — leave the copies and add a "keep-in-sync" comment**: rejected;
  the audit shows the copies have *already* diverged (REF_PATTERN forms,
  `formatError` hint, format lists), so comments demonstrably do not hold the line.

## Rationale

DRY here is not aesthetic — it is the mechanism by which ADR-002's
"protocol is the source of truth" is actually enforceable. A contract that is
re-typed in every consumer is a contract only by convention, and convention has
already failed in this codebase (four ref patterns, a drifted SDK, divergent
format lists). Making the compiler enforce the single definition converts a class
of silent cross-package drift into build errors. The name collision (B1) is the
sharpest case: TypeScript will not warn when two imported `ActionEffect`s shadow,
so the current state is a latent, invisible foot-gun that only a naming decision
removes.

## Related Decisions

- **ADR-002**: Engine-neutral protocol — this ADR is its enforcement mechanism.
- **ADR-004**: Stable element refs — the `e<rev>_<ord>` grammar this centralizes.
- **ADR-009**: MCP high-level tools — surfaces still differ in altitude; only the
  *underlying contract primitives* are unified.
- `docs/hygiene-audit.md` Theme B — the verified findings this decision resolves.

## Implementation Notes

- Land as small, reviewable PRs, one primitive at a time; start with B1
  (`ActionEffect` rename) and B8 (`'page navigated'`) because they are pure
  renames with the widest confusion-to-effort ratio.
- Add a contract test that imports each surface's request types and structurally
  asserts assignability to the protocol type, so future SDK drift (B2) fails CI.
- Keep `protocol`'s runtime additions tree-shakeable and free of any engine or
  Playwright dependency; verify with the existing neutrality grep.
- `parseRef`/`REF_PATTERN` must remain byte-for-byte the grammar in ADR-004;
  changing the grammar is a protocol-version event, not a refactor.
