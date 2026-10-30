import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ENGAGEMENT_GENESIS,
  engagementChainHash,
  verifyEngagementLedger,
} from '@agentbrowser/core';
import { expect, it } from 'vitest';
import { adoptScopeAssets } from './scope-assets-file.js';

it('previews by default and commits only named assets with a private, append-only amendment chain', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'adopt-assets-'));
  try {
    const scopeFile = join(directory, 'scope.json');
    const ledger = join(directory, 'ledger.jsonl');
    const original = {
      allowedHosts: ['app.test'],
      requestBudget: 80,
      requestHeaders: [{ header: 'x-research', value: 'private-marker-value' }],
    };
    await writeFile(scopeFile, JSON.stringify(original));
    let prev = ENGAGEMENT_GENESIS;
    const lines = `${[
      { type: 'engagement.opened', data: {} },
      {
        type: 'request',
        data: {
          outcome: 'failed',
          url: 'https://app.test/redirect',
          redirect: 'https://cdn.test/a.js',
          scope: 'SCOPE_HOST_DENIED',
          resourceType: 'script',
        },
      },
    ]
      .map((entry, seq) => {
        const body = { seq, at: new Date().toISOString(), ...entry };
        const hash = engagementChainHash(prev, JSON.stringify(body));
        const line = JSON.stringify({ ...body, prev, hash });
        prev = hash;
        return line;
      })
      .join('\n')}\n`;
    await writeFile(ledger, lines);
    expect((await adoptScopeAssets(scopeFile, ledger)).preview).toBe(true);
    expect(JSON.parse(await readFile(scopeFile, 'utf8'))).toEqual(original);
    await expect(adoptScopeAssets(scopeFile, ledger, ['unseen.test'])).rejects.toThrow();
    await expect(
      adoptScopeAssets(scopeFile, ledger, ['cdn.test'], {
        replace: async () => {
          throw new Error('rename failed');
        },
      })
    ).rejects.toThrow('aborted');
    expect(JSON.parse(await readFile(scopeFile, 'utf8'))).toEqual(original);
    // Simulate a crash after durable authorization but before replacement/abort.
    const interrupted = `${(await readFile(`${scopeFile}.amendments.ndjson`, 'utf8'))
      .trim()
      .split('\n')
      .slice(0, 2)
      .join('\n')}\n`;
    await writeFile(`${scopeFile}.amendments.ndjson`, interrupted);
    const result = await adoptScopeAssets(scopeFile, ledger, ['cdn.test']);
    expect(result.scope).toEqual({
      ...original,
      assetHosts: [{ host: 'cdn.test', class: 'asset' }],
    });
    expect((await stat(scopeFile)).mode & 0o777).toBe(0o600);
    const log = await readFile(`${scopeFile}.amendments.ndjson`, 'utf8');
    expect(verifyEngagementLedger(log)).toMatchObject({ ok: true, records: 5 });
    expect(log).toContain('scope.assets.recovered.aborted');
    expect(log).toContain('scope.assets.committed');
    expect(log).not.toContain('private-marker-value');
    await adoptScopeAssets(scopeFile, ledger, ['cdn.test']);
    expect(await readFile(`${scopeFile}.amendments.ndjson`, 'utf8')).toBe(log);
    await writeFile(ledger, lines.replace('cdn.test', 'evil.test'));
    await expect(adoptScopeAssets(scopeFile, ledger, ['evil.test'])).rejects.toThrow();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
