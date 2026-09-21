import { expect, it, vi } from 'vitest';
import { type CliClient, buildCli } from './cli.js';
const view = {
  tokenId: 'tok_1',
  status: 'pending',
  createdAt: 1,
  expiresAt: 100,
  action: { type: 'click', value: 'PRIVATE-ACTION' },
};
function fixture() {
  const out: string[] = [];
  const err: string[] = [];
  const sessions = {
    approval: vi.fn().mockResolvedValue(view),
    decideApproval: vi.fn().mockResolvedValue({ ...view, status: 'approved', approvedAt: 2 }),
    create: vi.fn().mockResolvedValue({ sessionId: 'ses_1', status: 'ready' }),
  };
  const createClient = vi.fn(() => ({ sessions }) as unknown as CliClient);
  return {
    cli: buildCli({ out: (v) => out.push(v), err: (v) => err.push(v), createClient }),
    out,
    err,
    sessions,
    createClient,
  };
}
it('advertises approval command schemas without constructing a client', async () => {
  const { cli, out, createClient } = fixture();
  expect(await cli.run(['describe', 'session', 'approval-decide', '--schema'])).toBe(0);
  expect(JSON.parse(out.join('\n')).command.schemas).toMatchObject({
    input: { properties: { decision: {} } },
    output: { properties: { action: { type: 'object' } } },
  });
  expect(createClient).not.toHaveBeenCalled();
});
it('reads approval status while keeping private action data out of text output', async () => {
  const { cli, out, sessions } = fixture();
  expect(await cli.run(['session', 'approval', 'ses_1', 'tok_1'])).toBe(0);
  expect(sessions.approval).toHaveBeenCalledWith('ses_1', 'tok_1');
  expect(out.join('\n')).toContain('pending');
  expect(out.join('\n')).not.toContain('PRIVATE');
});
it('emits full operator data only when JSON is requested', async () => {
  const { cli, out } = fixture();
  expect(await cli.run(['--json', 'session', 'approval', 'ses_1', 'tok_1'])).toBe(0);
  expect(JSON.parse(out.join('\n'))).toEqual(view);
});
it('passes an explicit decision using the existing global operation identity', async () => {
  const { cli, sessions, createClient } = fixture();
  expect(
    await cli.run([
      '--operation-id',
      'review-once',
      'session',
      'approval-decide',
      'ses_1',
      'tok_1',
      '--decision',
      'approve',
    ])
  ).toBe(0);
  expect(sessions.decideApproval).toHaveBeenCalledWith('ses_1', 'tok_1', 'approve');
  expect(createClient).toHaveBeenCalledWith(
    expect.objectContaining({ headers: { 'x-agentbrowser-operation-id': 'review-once' } })
  );
});
it('rejects an unsupported decision locally', async () => {
  const { cli, sessions, err } = fixture();
  expect(
    await cli.run(['session', 'approval-decide', 'ses_1', 'tok_1', '--decision', 'PRIVATE-BAD'])
  ).toBe(1);
  expect(sessions.decideApproval).not.toHaveBeenCalled();
  expect(err.join('\n')).not.toContain('PRIVATE');
});
it('requires delegated control when creating a reviewed session', async () => {
  const { cli, sessions } = fixture();
  expect(await cli.run(['session', 'create', '--tenant', 'owner', '--reviewed-approval'])).toBe(1);
  expect(sessions.create).not.toHaveBeenCalled();
  expect(
    await cli.run(['session', 'create', '--tenant', 'owner', '--delegated', '--reviewed-approval'])
  ).toBe(0);
  expect(sessions.create).toHaveBeenCalledWith({
    tenantId: 'owner',
    controlMode: 'delegated',
    policy: { approval: { review: 'operator' } },
  });
});

it('forwards the shared act approval token without changing ordinary action fields', async () => {
  const executeAction = vi.fn().mockResolvedValue({ status: 'success', newRevision: 2 });
  const cli = buildCli({
    out: () => {},
    err: () => {},
    createClient: () => ({ sessions: { executeAction } }) as unknown as CliClient,
  });
  expect(
    await cli.run(['act', '--approval-token', 'tok_reviewed', 'click', 'ses_1', 'page_1', 'e1_0'])
  ).toBe(0);
  expect(executeAction).toHaveBeenCalledWith('ses_1', 'page_1', {
    action: 'click',
    target: { ref: 'e1_0' },
    approvalToken: 'tok_reviewed',
  });
});

it.each([undefined, 'operator'] as const)(
  'gives mode-specific bounded approval diagnostics for %s review',
  async (review) => {
    const error = Object.assign(new Error('Action requires an explicit operator decision.'), {
      code: 'APPROVAL_REQUIRED',
      details: { tokenId: 'tok_reviewed', action: 'PRIVATE-ACTION', ...(review ? { review } : {}) },
    });
    const err: string[] = [];
    const cli = buildCli({
      out: () => {},
      err: (value) => err.push(value),
      createClient: () =>
        ({ sessions: { executeAction: vi.fn().mockRejectedValue(error) } }) as unknown as CliClient,
    });
    expect(await cli.run(['act', 'click', 'ses_1', 'page_1', 'e1_0'])).toBe(1);
    expect(err.join('\n')).toContain('Approval token: tok_reviewed');
    if (review === 'operator') {
      expect(err.join('\n')).toContain('session approval-decide');
    } else {
      expect(err.join('\n')).not.toContain('session approval');
      expect(err.join('\n')).toContain('act --approval-token');
    }
    expect(err.join('\n')).not.toContain('PRIVATE');
  }
);
