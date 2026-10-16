/** T5 B-dur-2c: `--execution-requirement` on act, plan and autofill. */
import { expect, it, vi } from 'vitest';
import { buildCli, type CliClient } from './cli.js';

const run = async (argv: string[], sessions: Record<string, unknown>) => {
  const err: string[] = [];
  const cli = buildCli({
    out: () => {},
    err: (value) => err.push(value),
    createClient: () => ({ sessions }) as unknown as CliClient,
  });
  return { code: await cli.run(argv), err };
};

it('act forwards --execution-requirement as the SDK mutation option', async () => {
  const executeAction = vi.fn().mockResolvedValue({ status: 'success', newRevision: 2 });
  const { code } = await run(
    [
      '--operation-id',
      'op-1',
      'act',
      '--execution-requirement',
      'durable',
      'click',
      'ses_1',
      'page_1',
      'e1_0',
    ],
    { executeAction }
  );
  expect(code).toBe(0);
  expect(executeAction).toHaveBeenCalledWith(
    'ses_1',
    'page_1',
    { action: 'click', target: { ref: 'e1_0' } },
    { executionRequirement: 'durable' }
  );
});

it('plan and autofill forward it too', async () => {
  const plan = vi
    .fn()
    .mockResolvedValue({ ok: true, completed: 1, results: [{ step: 0, ok: true }] });
  const autofill = vi.fn().mockResolvedValue({
    ok: true,
    receipts: [{ field: 0, status: 'verified', verified: true }],
  });
  const steps = JSON.stringify([{ action: 'scroll', direction: 'down' }]);
  expect(
    (
      await run(['plan', '--execution-requirement', 'durable', 'ses_1', 'page_1', steps], {
        plan,
      })
    ).code
  ).toBe(0);
  expect(plan).toHaveBeenCalledWith('ses_1', 'page_1', [{ action: 'scroll', direction: 'down' }], {
    executionRequirement: 'durable',
  });
  const request = JSON.stringify({ fields: [{ match: { label: 'Company' }, value: 'Acme' }] });
  await run(['autofill', '--execution-requirement', 'ephemeral', 'ses_1', 'page_1', request], {
    autofill,
  });
  expect(autofill).toHaveBeenCalledWith('ses_1', 'page_1', expect.any(Object), {
    executionRequirement: 'ephemeral',
  });
});

it('refuses another value before any request', async () => {
  const executeAction = vi.fn();
  const plan = vi.fn();
  expect(
    (
      await run(
        ['act', '--execution-requirement', 'eventually', 'click', 'ses_1', 'page_1', 'e1_0'],
        { executeAction }
      )
    ).code
  ).not.toBe(0);
  expect(
    (await run(['plan', '--execution-requirement', 'later', 'ses_1', 'page_1', '[]'], { plan }))
      .code
  ).not.toBe(0);
  expect(executeAction).not.toHaveBeenCalled();
  expect(plan).not.toHaveBeenCalled();
});
