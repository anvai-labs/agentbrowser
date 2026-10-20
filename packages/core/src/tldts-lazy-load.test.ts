import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * T8 footprint gate follow-up (PR #604 unblock): tldts's packed public-suffix
 * trie is built at module-initialization time and costs ~7 MB of idle RSS in
 * v7 — measured against the 75 MB MCP-bridge/CLI gates. The matcher must load
 * tldts LAZILY: importing the module is free; the first host question pays.
 * The probe runs in a fresh node child process so no other test's imports can
 * have loaded tldts into the CJS require cache first.
 */
describe('tldts lazy loading', () => {
  it('does not initialize tldts at import; first use does', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tldts-lazy-'));
    const probe = join(dir, 'probe.mjs');
    // CI builds the workspace (`pnpm -r build`) before the test job; the probe
    // must observe the COMPILED module graph, which is what the gates measure.
    const matcherUrl = new URL('../dist/domain-matcher.js', import.meta.url).href;
    const scopeUrl = new URL('../dist/program-scope-import.js', import.meta.url).href;
    await writeFile(
      probe,
      // language=javascript
      `const { createRequire } = await import('node:module');
const require_ = createRequire(import.meta.url);
const tldtsEntries = () =>
  Object.keys(require_.cache).filter((k) => k.replaceAll('\\\\', '/').includes('/tldts/')).length;
const beforeImport = tldtsEntries();
const matcher = await import(${JSON.stringify(matcherUrl)});
const scope = await import(${JSON.stringify(scopeUrl)});
const afterImport = tldtsEntries();
// One real question through each consumer, plus a behavior pin: the answer
// must be identical to the eagerly-loaded semantics.
const match = matcher.hostMatchesPattern('cdn.app.example.com', 'app.example.com');
const noMatch = matcher.hostMatchesPattern('other.example.com', 'app.example.com');
const suffix = typeof scope.importProgramScope === 'function' ? 'present' : 'absent';
const afterUse = tldtsEntries();
console.log(
  JSON.stringify({ beforeImport, afterImport, afterUse, match, noMatch, suffix })
);
`,
      'utf8'
    );
    const stdout = execFileSync(process.execPath, [probe], { encoding: 'utf8' });
    const result = JSON.parse(stdout.trim().split('\n').at(-1) ?? '{}');
    expect(result.beforeImport).toBe(0);
    expect(result.afterImport).toBe(0); // import alone must not build the trie
    expect(result.afterUse).toBeGreaterThan(0); // first use loads it
    expect(result.match).toBe(true); // bare bounded domain covers its subtree
    expect(result.noMatch).toBe(false);
    expect(result.suffix).toBe('present');
  });
});
