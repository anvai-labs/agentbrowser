import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { expect, it, vi } from 'vitest';
import { type CliClient, buildCli } from './cli.js';

const body = {
  pageId: 'page-1',
  source: { ownerId: 'owner-1', contract: { id: 'draft', version: 'v1' } },
  request: {
    operation: 'submit',
    input: { answer: 'PRIVATE' },
    operationId: 'future-1',
    expectedVersion: 2,
  },
};
const view = {
  tokenId: 'token-1',
  status: 'pending',
  createdAt: 1,
  expiresAt: 100,
  action: { type: 'review', private: 'PRIVATE' },
};
function fixture(stdin?: Readable) {
  const out: string[] = [];
  const err: string[] = [];
  const sessions = {
    applicationReview: vi.fn().mockResolvedValue(view),
    applicationExecute: vi.fn().mockResolvedValue({ status: 'committed', value: {} }),
    applicationDiscover: vi.fn().mockResolvedValue({
      adapter: 'draft',
      resource: 'candidate',
      operations: [{ name: 'submit', mode: 'write', review: 'operator-submit' }],
    }),
  };
  const createClient = vi.fn(() => ({ sessions }) as unknown as CliClient);
  const cli = buildCli({
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    createClient,
    ...(stdin ? { stdin } : {}),
  });
  return { cli, out, err, sessions, createClient };
}
it.each(['inline', 'file', 'stdin'] as const)(
  'creates reviews through the common %s reader without private text output',
  async (mode) => {
    const directory = await mkdtemp(join(tmpdir(), 'application-review-'));
    try {
      const path = join(directory, 'review.json');
      const input = JSON.stringify(body);
      await writeFile(path, input);
      const f = fixture(Readable.from([input]));
      expect(
        await f.cli.run([
          'application',
          'review',
          'session',
          mode === 'file' ? `@${path}` : mode === 'stdin' ? '-' : input,
        ])
      ).toBe(0);
      expect(f.sessions.applicationReview).toHaveBeenCalledWith('session', body);
      expect(f.out.join('\n')).toContain('token-1: pending');
      expect(f.out.join('\n')).not.toContain('PRIVATE');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
);
it('advertises canonical schemas and explicitly exposes private JSON only on request', async () => {
  const f = fixture();
  expect(await f.cli.run(['describe', 'application', 'review', '--schema'])).toBe(0);
  expect(JSON.parse(f.out.join('\n')).command.schemas).toMatchObject({
    input: { properties: { pageId: {}, request: {}, source: {} } },
    output: { properties: { action: {} } },
  });
  expect(f.createClient).not.toHaveBeenCalled();
  f.out.length = 0;
  expect(
    await f.cli.run(['--json', 'application', 'review', 'session', JSON.stringify(body)])
  ).toBe(0);
  expect(JSON.parse(f.out.join('\n'))).toEqual(view);
});
it('refuses creation operation IDs and malformed bodies before invoking the SDK', async () => {
  const f = fixture();
  expect(
    await f.cli.run([
      '--operation-id',
      'create-1',
      'application',
      'review',
      'session',
      JSON.stringify(body),
    ])
  ).toBe(1);
  expect(
    await f.cli.run([
      'application',
      'review',
      'session',
      JSON.stringify({ ...body, decision: 'approve' }),
    ])
  ).toBe(1);
  expect(f.sessions.applicationReview).not.toHaveBeenCalled();
  expect(f.err.join('\n')).not.toContain('PRIVATE');
});
it('forwards consent on existing execution and displays captured discovery requirements', async () => {
  const f = fixture();
  expect(
    await f.cli.run([
      '--operation-id',
      'future-1',
      'application',
      'execute',
      'session',
      'submit',
      JSON.stringify(body.request.input),
      '--expected-version',
      '2',
      '--approval-token',
      'token-1',
    ])
  ).toBe(0);
  expect(f.sessions.applicationExecute).toHaveBeenCalledWith('session', {
    ...body.request,
    approvalToken: 'token-1',
  });
  expect(await f.cli.run(['application', 'discover', 'session'])).toBe(0);
  expect(f.out.join('\n')).toContain('operator-submit');
});
