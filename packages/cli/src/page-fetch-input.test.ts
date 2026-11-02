import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, it, vi } from 'vitest';
import type { CliClient } from './cli.js';
import { buildCapturedCli } from './test-support/captured-cli.js';

const directory = mkdtempSync(join(tmpdir(), 'agentbrowser-probe-'));
afterAll(() => rmSync(directory, { recursive: true, force: true }));

function fixture(
  result: unknown = {
    status: 200,
    headers: [],
    body: 'ok',
    bodyBytes: 2,
    truncated: false,
    outcome: 'terminal',
  }
) {
  const executeAction = vi.fn(async () => ({
    status: 'success',
    newRevision: 3,
    result,
  }));
  return {
    ...buildCapturedCli(() => ({ sessions: { executeAction } }) as unknown as CliClient),
    executeAction,
  };
}

it('sends the handoff-shaped PUT probe through /act with headers and body', async () => {
  const f = fixture();
  expect(
    await f.cli.run([
      'page',
      'fetch',
      's',
      'p',
      'PUT',
      'https://vinted.test/api/items/4029603257',
      '--header',
      'X-CSRF-Token=abc',
      '--body',
      '{"price_cents":101}',
    ])
  ).toBe(0);
  expect(f.executeAction).toHaveBeenLastCalledWith('s', 'p', {
    action: 'fetch',
    method: 'PUT',
    url: 'https://vinted.test/api/items/4029603257',
    headers: [{ name: 'X-CSRF-Token', value: 'abc' }],
    body: '{"price_cents":101}',
  });
  expect(f.out.join('\n')).toContain('fetch PUT https://vinted.test/api/items/4029603257: 200');
});

it('reads the body from a file and passes the approval token', async () => {
  const f = fixture();
  const bodyFile = join(directory, 'item.json');
  writeFileSync(bodyFile, '{"price_cents":202}');
  expect(
    await f.cli.run([
      'page',
      'fetch',
      's',
      'p',
      'put',
      'https://vinted.test/api/items/1',
      '--body-file',
      bodyFile,
      '--approval-token',
      'tok-1',
    ])
  ).toBe(0);
  expect(f.executeAction).toHaveBeenLastCalledWith('s', 'p', {
    action: 'fetch',
    method: 'PUT',
    url: 'https://vinted.test/api/items/1',
    body: '{"price_cents":202}',
    approvalToken: 'tok-1',
  });
});

it('discloses a truncated response in the human output', async () => {
  const f = fixture({
    status: 200,
    headers: [],
    body: 'x'.repeat(10),
    bodyBytes: 2097152,
    truncated: true,
    outcome: 'terminal',
  });
  expect(
    await f.cli.run(['page', 'fetch', 's', 'p', 'GET', 'https://vinted.test/api/items/1'])
  ).toBe(0);
  expect(f.out.join('\n')).toContain('response truncated: 2097152 decoded bytes');
});

it.each([
  ['page', 'fetch', 's', 'p', 'TRACE', 'https://vinted.test/x'],
  ['page', 'fetch', 's', 'p', 'GET', 'https://vinted.test/x', '--body', '{}'],
  ['page', 'fetch', 's', 'p', 'PUT', 'https://vinted.test/x', '--header', 'Cookie=a=b'],
  ['page', 'fetch', 's', 'p', 'PUT', 'https://vinted.test/x', '--header', 'no-equals'],
])('refuses invalid probes before the network: %j', async (...argv) => {
  const f = fixture();
  expect(await f.cli.run(argv)).not.toBe(0);
  expect(f.executeAction).not.toHaveBeenCalled();
  expect(f.err.join('\n')).not.toContain('https://vinted.test/x?'); // the URL never echoes with a query
});
