import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * T8 footprint gate follow-up (PR #604 unblock): tldts's packed public-suffix
 * trie is built at module-initialization time and costs ~7-9 MB of idle RSS in
 * v7 — measured against the 75 MB MCP-bridge/CLI gates. The matcher must load
 * tldts LAZILY: importing the module is free; the first host question pays.
 *
 * Two surfaces, two modes (see tldts-lazy.ts):
 * - node_modules surfaces: the sync accessor's createRequire fallback loads
 *   tldts on first matcher call — no preloading discipline.
 * - bundled surfaces (bun --compile, esbuild): `await loadTldts()` at the
 *   entry points; the dynamic import() is what keeps tldts IN the bundle.
 *
 * The probe runs in a fresh node child process so no other test's imports can
 * have loaded tldts into the CJS require cache first, and it observes the
 * COMPILED dist graph (CI builds the workspace before the test job).
 */
describe('tldts lazy loading', () => {
  it('does not initialize tldts at import; the sync fallback loads it on first use', async () => {
    const result = await runProbe(`
const beforeImport = tldtsEntries();
const matcher = await import(${JSON.stringify(matcherUrl())});
const scope = await import(${JSON.stringify(scopeUrl())});
const afterImport = tldtsEntries();
// No loadTldts() call: the node_modules surface's sync fallback must answer.
const match = matcher.hostMatchesPattern('cdn.app.example.com', 'app.example.com');
const noMatch = matcher.hostMatchesPattern('other.example.com', 'app.example.com');
const afterUse = tldtsEntries();
const suffix = typeof scope.importProgramScope === 'function' ? 'present' : 'absent';
console.log(JSON.stringify({ beforeImport, afterImport, afterUse, match, noMatch, suffix }));
`);
    expect(result.beforeImport).toBe(0);
    expect(result.afterImport).toBe(0); // import alone must not build the trie
    expect(result.afterUse).toBeGreaterThan(0); // first use loads it
    expect(result.match).toBe(true); // bare bounded domain covers its subtree
    expect(result.noMatch).toBe(false);
    expect(result.suffix).toBe('present');
  });

  it('loadTldts() preloads once and the matcher answers without a require fallback', async () => {
    const result = await runProbe(`
const { loadTldts } = await import(${JSON.stringify(lazyUrl())});
const matcher = await import(${JSON.stringify(matcherUrl())});
await loadTldts();
await loadTldts(); // idempotent: the second await must reuse the first load
const match = matcher.hostMatchesPattern('cdn.app.example.com', 'app.example.com');
const noMatch = matcher.hostMatchesPattern('other.example.com', 'app.example.com');
console.log(JSON.stringify({ match, noMatch }));
`);
    expect(result.match).toBe(true);
    expect(result.noMatch).toBe(false);
    // On a BUNDLED surface the require fallback cannot resolve anything, so a
    // passing match here can only mean the preloaded module answered. That
    // end-to-end property is pinned by scripts/binary-host-question.test.mjs
    // against the compiled CLI.
  });
});

let dir: string | undefined;

async function runProbe(body: string): Promise<Record<string, unknown>> {
  dir ??= await mkdtemp(join(tmpdir(), 'tldts-lazy-'));
  const probe = join(dir, `probe-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`);
  await writeFile(
    probe,
    `const { createRequire } = await import('node:module');
const require_ = createRequire(import.meta.url);
const tldtsEntries = () =>
  Object.keys(require_.cache).filter((k) => k.replaceAll('\\\\', '/').includes('/tldts/')).length;
${body}
`,
    'utf8'
  );
  const stdout = execFileSync(process.execPath, [probe], { encoding: 'utf8' });
  return JSON.parse(stdout.trim().split('\n').at(-1) ?? '{}') as Record<string, unknown>;
}

function matcherUrl(): string {
  return new URL('../dist/domain-matcher.js', import.meta.url).href;
}

function scopeUrl(): string {
  return new URL('../dist/program-scope-import.js', import.meta.url).href;
}

function lazyUrl(): string {
  return new URL('../dist/tldts-lazy.js', import.meta.url).href;
}
