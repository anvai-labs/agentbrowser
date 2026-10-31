import { expect, it, vi } from 'vitest';
import { buildCli, type CliClient } from './cli.js';

it('streams denial diagnostics to stderr and preserves the existing span-export default', async () => {
  const err: string[] = [];
  const out: string[] = [];
  const trace = vi.fn(async () => ({ artifactId: 'artifact', type: 'trace', sizeBytes: 1 }));
  const traceDenials = vi.fn(async function* () {
    yield {
      type: 'scope.denied' as const,
      timestamp: 'now',
      sessionId: 's',
      data: {
        scope: 'SCOPE_METHOD_DENIED' as const,
        method: 'PUT',
        url: 'https://vinted.test/api',
        hostname: 'vinted.test',
      },
    };
  });
  const cli = buildCli({
    createClient: () => ({ sessions: { trace, traceDenials } }) as unknown as CliClient,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  });
  expect(await cli.run(['session', 'trace', 's', '--denials'])).toBe(0);
  expect(err.join('\n')).toContain('SCOPE_METHOD_DENIED PUT https://vinted.test/api');
  expect(trace).not.toHaveBeenCalled();
  expect(await cli.run(['session', 'trace', 's'])).toBe(0);
  expect(trace).toHaveBeenCalledOnce();
});
