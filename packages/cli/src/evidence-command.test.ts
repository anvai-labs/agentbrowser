import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { runCli } from './test-support/cli-run.js';

it('refuses explicit restrictions or engine settings it cannot carry before requesting an operator credential', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'evidence-cli-'));
  try {
    const scope = join(directory, 'scope.json');
    await writeFile(scope, JSON.stringify({ allowedHosts: ['example.com'] }));
    for (const flags of [
      ['--blocked-hosts', 'prod.example.com'],
      ['--allow-hosts', 'app.example.com'],
      ['--engine', 'firefox'],
      ['--viewport', '1000x800'],
      ['--locale', 'en-US'],
      ['--snapshot-timeout', '2000'],
    ]) {
      const result = await runCli([
        'session',
        'create',
        '--tenant',
        'one',
        '--evidence',
        '--from',
        'source',
        '--scope-file',
        scope,
        ...flags,
      ]);
      expect(result.code).not.toBe(0);
      expect(result.out + result.err).toContain('cannot honor extra launch or policy flags');
      expect(result.out + result.err).not.toContain('operator key is required');
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
