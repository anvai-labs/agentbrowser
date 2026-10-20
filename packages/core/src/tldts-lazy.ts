import { createRequire } from 'node:module';

/**
 * tldts builds its packed public-suffix trie at module-initialization time
 * (~7 MB idle RSS in v7 — the PR #604 regression). The T8 footprint gates
 * measure the idle MCP bridge and the CLI one-shot at 75 MB, and neither
 * answers a host question before its first request — so the list must not
 * load until then. The synchronous `createRequire` probe keeps every matcher
 * function sync; the trie is built once, on first use, and cached for the
 * process lifetime.
 */
export type Tldts = typeof import('tldts');

let cached: Tldts | undefined;

/** The pinned tldts module, loaded on first call (never at import time). */
export function tldts(): Tldts {
  if (cached === undefined) {
    cached = createRequire(import.meta.url)('tldts') as Tldts;
  }
  return cached;
}
