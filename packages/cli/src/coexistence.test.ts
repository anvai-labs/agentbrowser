import { expect, it, vi } from 'vitest';
import { type CliClient, buildCli } from './cli.js';
it('exposes controlled creation and operator review/delegation', async () => {
  const sessions = {
    create: vi.fn().mockResolvedValue({ sessionId: 's' }),
    takeover: vi.fn().mockResolvedValue({ state: 'HUMAN_ACTIVE' }),
    prepareResume: vi.fn().mockResolvedValue({ epoch: 1 }),
    delegate: vi.fn().mockResolvedValue({ token: 'grant' }),
  };
  const out = vi.fn();
  const err = vi.fn();
  const cli = buildCli({ createClient: () => ({ sessions }) as unknown as CliClient, out, err });
  expect(await cli.run(['--json', 'session', 'create', '--tenant', 'owner', '--delegated'])).toBe(
    0
  );
  expect(sessions.create).toHaveBeenCalledWith(
    expect.objectContaining({ controlMode: 'delegated' })
  );
  expect(await cli.run(['--json', 'session', 'takeover', 's'])).toBe(0);
  expect(await cli.run(['--json', 'session', 'prepare-resume', 's'])).toBe(0);
  expect(await cli.run(['--json', 'session', 'delegate', 's', '--epoch', '1'])).toBe(0);
  expect(sessions.delegate).toHaveBeenCalledWith('s', 1);
});
