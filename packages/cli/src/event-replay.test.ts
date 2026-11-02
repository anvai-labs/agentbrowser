import { AgentBrowserClient } from '@agentbrowser/sdk-typescript';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildCli, type CliClient } from './cli.js';

describe('event replay command selectors', () => {
  const events = vi.fn();
  const out: string[] = [];
  const err: string[] = [];
  const run = (...argv: string[]) =>
    buildCli({
      createClient: () => ({ sessions: { events } }) as unknown as CliClient,
      out: (line) => out.push(line),
      err: (line) => err.push(line),
    }).run(argv);
  beforeEach(() => {
    events.mockReset().mockResolvedValue({
      events: [],
      nextCursor: 12,
      oldestSeq: 10,
      gap: true,
      filter: { version: 1, stream: 'request' },
    });
    out.length = 0;
    err.length = 0;
  });

  afterEach(() => vi.unstubAllGlobals());

  it.each([undefined, { version: 2, stream: 'request' }, { version: 1, stream: 'other' }])(
    'does not display unacknowledged backend data or retry: %j',
    async (filter) => {
      const fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          events: [{ type: 'request.finished', data: { text: 'UNFILTERED_PRIVATE_EVENT' } }],
          nextCursor: 8,
          filter,
        }),
      });
      vi.stubGlobal('fetch', fetch);
      const result = await buildCli({
        createClient: () => new AgentBrowserClient({ baseUrl: 'http://fixture.invalid' }),
        out: (line) => out.push(line),
        err: (line) => err.push(line),
      }).run(['--json', 'events', 'ses_1', '--failed-only']);
      expect(result).toBe(1);
      expect(fetch).toHaveBeenCalledOnce();
      expect(out).toEqual([]);
      expect(err.join('\n')).toContain('Invalid event replay filter acknowledgment');
      expect(err.join('\n')).not.toContain('UNFILTERED_PRIVATE_EVENT');
    }
  );

  it.each([['events'], ['session', 'events']])(
    'shares the full selector handler at %j',
    async (...path) => {
      expect(
        await run(
          ...path,
          'ses_1',
          '--stream',
          'request',
          '--type',
          'request.failed',
          '--url-regex',
          'api/(items|offers)',
          '--method',
          'PUT',
          '--status-class',
          'denied',
          '--failed-only',
          '--since',
          '-1',
          '--limit',
          '2'
        )
      ).toBe(0);
      expect(events).toHaveBeenCalledOnce();
      expect(events).toHaveBeenCalledWith('ses_1', {
        stream: 'request',
        type: 'request.failed',
        urlRegex: 'api/(items|offers)',
        method: 'PUT',
        statusClass: 'denied',
        failedOnly: true,
        since: -1,
        limit: 2,
      });
      expect(out.join('\n')).toContain('gap: true');
      expect(out.join('\n')).toContain('seq 10');
      expect(err).toEqual([]);
    }
  );

  it('supports the requested failed API query without an explicit type', async () => {
    expect(await run('events', 'ses_1', '--failed-only', '--url-regex', 'api')).toBe(0);
    expect(events).toHaveBeenCalledWith('ses_1', { failedOnly: true, urlRegex: 'api' });
  });

  it('preserves explicit false and emits the paging envelope in JSON mode', async () => {
    expect(await run('--json', 'events', 'ses_1', '--no-failed-only')).toBe(0);
    expect(events).toHaveBeenCalledWith('ses_1', { failedOnly: false });
    expect(JSON.parse(out.join(''))).toEqual({
      events: [],
      nextCursor: 12,
      oldestSeq: 10,
      gap: true,
      filter: { version: 1, stream: 'request' },
    });
  });

  it.each([
    ['--stream', 'other', '--method', 'GET'],
    ['--type', 'console.log', '--failed-only'],
    ['--method', 'get'],
    ['--status-class', '3xx'],
    ['--url-regex', 'λ'.repeat(129)],
    ['--since', '3'],
    ['--stream', 'request', '--limit', '1e2'],
    ['--stream', 'request', '--limit', '0'],
    ['--stream', 'request', '--since', '-2'],
    ['--failed-only', 'false'],
    ['--failed-only=false'],
    ['--unexpected', 'PRIVATE_SELECTOR_VALUE'],
  ])('refuses invalid arguments before invoking the client: %j', async (...flags) => {
    expect(await run('events', 'ses_1', ...flags)).toBe(1);
    expect(events).not.toHaveBeenCalled();
  });
});
