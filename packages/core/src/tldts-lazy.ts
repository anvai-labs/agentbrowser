import { createRequire } from 'node:module';

/**
 * tldts builds its packed public-suffix trie at module-initialization time
 * (~7-9 MB idle RSS in v7 — the PR #604 regression). The T8 footprint gates
 * measure the idle MCP bridge and the CLI one-shot at 75 MB, and neither
 * answers a host question before its first request — so the list must not
 * load until then.
 *
 * The loader is a dynamic `import()` on purpose: bun --compile and esbuild
 * both BUNDLE dynamic imports of resolvable dependencies (so the single-file
 * binaries and the npm bundle stay self-contained — a `createRequire`-only
 * form is bundler-invisible and silently drops tldts, crashing the released
 * artifacts) while DEFERRING the trie build to the first `loadTldts()`.
 *
 * Surfaces differ in how they may initialize:
 * - bundled surfaces (compiled binaries, npm bundle): `await loadTldts()`
 *   at the async entry points that answer host questions (CLI `scope import`
 *   and `finding check|sarif`; MCP `finding_check`/`finding_sarif`) — the
 *   sync accessor refuses to guess there, because there is no node_modules
 *   to fall back to.
 * - node_modules surfaces (api service, policy packages): the sync accessor
 *   resolves tldts synchronously via `createRequire` on first call, so no
 *   call-site wiring is needed.
 */
export type Tldts = typeof import('tldts');

let mod: Tldts | undefined;
let loading: Promise<void> | undefined;

/** Load tldts once (bundler-visible; initialization happens here, not at import). */
export async function loadTldts(): Promise<void> {
  if (mod === undefined) {
    loading ??= import('tldts').then((m) => {
      mod = m as Tldts;
    });
    await loading;
  }
}

/** Sync accessor for matcher hot paths; see the module doc for the two modes. */
export function tldts(): Tldts {
  if (mod === undefined) {
    try {
      mod = createRequire(import.meta.url)('tldts') as Tldts;
    } catch (cause) {
      throw new Error(
        'tldts is not loaded and cannot be required: bundled surfaces must await loadTldts() before host matching',
        { cause }
      );
    }
  }
  return mod;
}
