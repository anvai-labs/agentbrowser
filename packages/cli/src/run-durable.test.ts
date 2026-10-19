// T10 M4: `run --execution-requirement durable` executes inside a controlled session the
// caller owns: no create, no session close, the operation carries --operation-id, and only the
// page is closed. Durable classification needs a controlled session and a durable journal;
// `run` must not silently create an ephemeral one instead.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { buildCli, type CliClient } from './cli.js';

const dir = mkdtempSync(join(tmpdir(), 'run-durable-'));
const planFile = join(dir, 'plan.json');
writeFileSync(planFile, JSON.stringify([{ action: 'click', waitForLabel: 'Go' }]));

function fakeSessions(report = { ok: true, completed: 1, results: [{ step: 0, ok: true }] }) {
  const calls: Array<{ fn: string; args: unknown[] }> = [];
  const sessions = {
    create: vi.fn(async () => {
      calls.push({ fn: 'create', args: [] });
      return { sessionId: 'ses_new' };
    }),
    createPage: vi.fn(async (sessionId: string) => {
      calls.push({ fn: 'createPage', args: [sessionId] });
      return { pageId: 'pg_1', sessionId, status: 'ready' };
    }),
    plan: vi.fn(async (_s: string, _p: string, _steps: unknown, execution?: unknown) => {
      calls.push({ fn: 'plan', args: [execution] });
      return report;
    }),
    close: vi.fn(async () => {
      calls.push({ fn: 'close', args: [] });
      return {};
    }),
    closePage: vi.fn(async (sessionId: string, pageId: string) => {
      calls.push({ fn: 'closePage', args: [sessionId, pageId] });
      return {};
    }),
  };
  return { sessions, calls, plan: sessions.plan };
}

async function run(argv: string[], sessions: Record<string, unknown>) {
  const out: string[] = [];
  const err: string[] = [];
  const cli = buildCli({
    createClient: () => ({ sessions }) as unknown as CliClient,
    out: (line: string) => out.push(line),
    err: (line: string) => err.push(line),
  });
  const code = await cli.run(argv);
  if (code !== 0)
    console.error('NONZERO', JSON.stringify({ code, out: out.join('\n'), err: err.join('\n') }));
  return { code, out: out.join('\n'), err: err.join('\n') };
}

const base = (planFile: string) => [
  'run',
  planFile,
  '--url',
  'https://app.test/',
  '--tenant',
  't1',
];

describe('run --execution-requirement durable (T10 M4)', () => {
  it('runs inside --session: no create, no session close, only the page closes', async () => {
    const { sessions, calls } = fakeSessions();
    const result = await run(
      [
        ...base(planFile),
        '--session',
        'ses_ctl',
        '--execution-requirement',
        'durable',
        '--operation-id',
        'op-1',
      ],
      sessions
    );
    expect(result.code).toBe(0);
    expect(calls.map((call) => call.fn)).toEqual(['createPage', 'plan', 'closePage']);
    expect(calls.find((call) => call.fn === 'createPage')?.args).toEqual(['ses_ctl']);
    expect(result.out).toContain('ok: 1/1 steps completed');
  });

  it('sends the durable execution requirement with the plan call', async () => {
    const { sessions, calls } = fakeSessions();
    await run(
      [
        ...base(planFile),
        '--session',
        'ses_ctl',
        '--execution-requirement',
        'durable',
        '--operation-id',
        'op-1',
      ],
      sessions
    );
    const planCall = calls.find((call) => call.fn === 'plan');
    expect(planCall?.args[0]).toEqual({ executionRequirement: 'durable', operationId: 'op-1' });
  });

  it('durable without --session is refused (never an ephemeral session by surprise)', async () => {
    const { sessions, calls } = fakeSessions();
    const result = await run(
      [...base(planFile), '--execution-requirement', 'durable', '--operation-id', 'op-1'],
      sessions
    );
    expect(result.code).not.toBe(0);
    expect(result.err + result.out).toMatch(/--session/);
    expect(calls).toEqual([]);
  });

  it('durable without --operation-id is refused', async () => {
    const { sessions, calls } = fakeSessions();
    const result = await run(
      [...base(planFile), '--session', 'ses_ctl', '--execution-requirement', 'durable'],
      sessions
    );
    expect(result.code).not.toBe(0);
    expect(result.err + result.out).toMatch(/--operation-id/);
    expect(calls).toEqual([]);
  });

  it('ephemeral runs keep creating and closing their own session', async () => {
    const { sessions, calls } = fakeSessions();
    const result = await run([...base(planFile), '--execution-requirement', 'ephemeral'], sessions);
    expect(result.code).toBe(0);
    expect(calls.map((call) => call.fn)).toEqual(['create', 'createPage', 'plan', 'close']);
  });

  it('a failing durable plan still closes the page and exits 1', async () => {
    const { sessions, calls } = fakeSessions({
      ok: false,
      completed: 0,
      results: [{ step: 0, ok: false }],
      error: { code: 'PLAN_STEP_FAILED', message: 'x' },
    });
    const result = await run(
      [
        ...base(planFile),
        '--session',
        'ses_ctl',
        '--execution-requirement',
        'durable',
        '--operation-id',
        'op-1',
      ],
      sessions
    );
    expect(result.code).toBe(1);
    expect(calls.at(-1)?.fn).toBe('closePage');
  });

  it('a thrown durable plan prints the reconciliation identity (session, page, operation id)', async () => {
    const sessions = {
      createPage: vi.fn(async (sessionId: string) => ({
        pageId: 'pg_9',
        sessionId,
        status: 'ready',
      })),
      plan: vi.fn(async () => {
        throw new Error('CONNECTION_LOST: response never arrived');
      }),
      closePage: vi.fn(async () => ({})),
    };
    const result = await run(
      [
        ...base(planFile),
        '--session',
        'ses_ctl',
        '--execution-requirement',
        'durable',
        '--operation-id',
        'op-reconcile',
      ],
      sessions
    );
    expect(result.code).not.toBe(0);
    const text = result.err + result.out;
    expect(text).toMatch(/ses_ctl/);
    expect(text).toMatch(/pg_9/);
    expect(text).toMatch(/op-reconcile/);
    expect(text).toMatch(/CONNECTION_LOST|reconcil/i);
  });

  it('--session with an explicit ephemeral requirement runs unjournalled in that session', async () => {
    const sessions = {
      createPage: vi.fn(async (sessionId: string) => ({
        pageId: 'pg_2',
        sessionId,
        status: 'ready',
      })),
      plan: vi.fn(async () => ({ ok: true, completed: 1, results: [{ step: 0, ok: true }] })),
      closePage: vi.fn(async () => ({})),
    };
    const result = await run(
      [...base(planFile), '--session', 'ses_ctl', '--execution-requirement', 'ephemeral'],
      sessions
    );
    expect(result.code).toBe(0);
    const planCall = sessions.plan.mock.calls[0];
    expect(planCall?.[3]).toBeUndefined();
  });
});
