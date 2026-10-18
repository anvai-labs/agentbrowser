// T10 M4: `run` executes a saved plan file end to end (create, navigate, plan, close).
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { buildCli, type CliClient } from './cli.js';

const dir = mkdtempSync(join(tmpdir(), 'plan-run-'));
const write = (name: string, text: string) => {
  const path = join(dir, name);
  writeFileSync(path, text);
  return path;
};
const steps = [
  { action: 'fill', waitForLabel: 'Email', value: 'a@example.test' },
  { action: 'click', waitForLabel: 'Submit' },
];
const planFile = write('plan.json', JSON.stringify(steps));

function fakeSessions(planReport: Record<string, unknown>, opts: { pageError?: Error } = {}) {
  const calls: string[] = [];
  const sessions = {
    create: vi.fn(async (request: unknown) => {
      calls.push(`create ${JSON.stringify(request)}`);
      return { sessionId: 'ses_1', status: 'ready' };
    }),
    createPage: vi.fn(async (_s: string, request: unknown) => {
      calls.push(`page ${JSON.stringify(request)}`);
      if (opts.pageError) throw opts.pageError;
      return { pageId: 'pg_1', sessionId: 'ses_1', status: 'ready' };
    }),
    plan: vi.fn(async () => {
      calls.push('plan');
      return planReport;
    }),
    close: vi.fn(async () => {
      calls.push('close');
      return { sessionId: 'ses_1', status: 'closed' };
    }),
  };
  return { sessions, calls };
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
  return { code, out: out.join('\n'), err: err.join('\n') };
}

const okReport = {
  ok: true,
  completed: 2,
  mode: 'stable',
  results: [
    { step: 0, ok: true },
    { step: 1, ok: true },
  ],
};
const failedReport = {
  ok: false,
  completed: 1,
  mode: 'stable',
  results: [
    { step: 0, ok: true },
    { step: 1, ok: false, error: 'TARGET_NOT_FOUND: no element labelled "Submit secret-xyz"' },
  ],
  error: { code: 'TARGET_NOT_FOUND', message: 'no element labelled "Submit secret-xyz"' },
};

describe('run <planFile> (T10 M4)', () => {
  it('creates a session, opens the start URL, runs the plan and closes the session', async () => {
    const { sessions, calls } = fakeSessions(okReport);
    const result = await run(
      ['run', planFile, '--url', 'https://app.test/login', '--tenant', 't1'],
      sessions
    );
    expect(result.code).toBe(0);
    expect(calls).toEqual([
      'create {"tenantId":"t1"}',
      'page {"url":"https://app.test/login"}',
      'plan',
      'close',
    ]);
    expect(sessions.plan).toHaveBeenCalledWith('ses_1', 'pg_1', steps);
    expect(result.out).toContain('ok: 2/2 steps completed');
  });

  it('exits 1 on a failed plan and still closes the session', async () => {
    const { sessions, calls } = fakeSessions(failedReport);
    const result = await run(
      ['run', planFile, '--url', 'https://app.test/', '--tenant', 't1'],
      sessions
    );
    expect(result.code).toBe(1);
    expect(calls.at(-1)).toBe('close');
  });

  it('closes the session when the start page cannot be opened', async () => {
    const { sessions, calls } = fakeSessions(okReport, { pageError: new Error('blocked') });
    const result = await run(
      ['run', planFile, '--url', 'https://app.test/', '--tenant', 't1'],
      sessions
    );
    expect(result.code).not.toBe(0);
    expect(calls).not.toContain('plan');
    expect(calls.at(-1)).toBe('close');
  });

  it('--keep-session leaves the session open and reports its ids', async () => {
    const { sessions, calls } = fakeSessions(okReport);
    const result = await run(
      ['--json', 'run', planFile, '--url', 'https://app.test/', '--tenant', 't1', '--keep-session'],
      sessions
    );
    expect(calls).not.toContain('close');
    expect(JSON.parse(result.out)).toMatchObject({
      ok: true,
      sessionId: 'ses_1',
      pageId: 'pg_1',
      completed: 2,
      steps: 2,
    });
  });

  it('--scope-file scopes the session', async () => {
    const { sessions, calls } = fakeSessions(okReport);
    const scope = write('scope.json', JSON.stringify({ allowedHosts: ['app.test'] }));
    await run(
      ['run', planFile, '--url', 'https://app.test/', '--tenant', 't1', '--scope-file', scope],
      sessions
    );
    expect(calls[0]).toBe(
      'create {"tenantId":"t1","policy":{"scope":{"allowedHosts":["app.test"]}}}'
    );
  });

  it('--junit writes one testcase per step with verdicts and error codes only (0600, exclusive)', async () => {
    const { sessions } = fakeSessions(failedReport);
    const junit = join(dir, 'report.xml');
    await run(
      ['run', planFile, '--url', 'https://app.test/', '--tenant', 't1', '--junit', junit],
      sessions
    );
    const xml = readFileSync(junit, 'utf8');
    expect(statSync(junit).mode & 0o777).toBe(0o600);
    expect(xml).toContain('<testsuite name="plan.json" tests="2" failures="1" errors="0">');
    expect(xml).toContain('<testcase classname="plan.json" name="step 1: fill"/>');
    expect(xml).toContain('<testcase classname="plan.json" name="step 2: click">');
    expect(xml).toContain('<failure message="TARGET_NOT_FOUND"/>');
    // Page-derived text in error messages never reaches the JUnit artifact.
    expect(xml).not.toContain('secret-xyz');
    const again = await run(
      ['run', planFile, '--url', 'https://app.test/', '--tenant', 't1', '--junit', junit],
      sessions
    );
    expect(again.code).not.toBe(0);
  });

  it('refuses an invalid plan file before creating a session', async () => {
    const { sessions, calls } = fakeSessions(okReport);
    const bad = write('bad.json', JSON.stringify([{ action: 'teleport' }]));
    const result = await run(
      ['run', bad, '--url', 'https://app.test/', '--tenant', 't1'],
      sessions
    );
    expect(result.code).not.toBe(0);
    expect(calls).toEqual([]);
  });

  it('JUnit falls back to the plan error code when the step error has no code prefix', async () => {
    const { sessions } = fakeSessions({
      ok: false,
      completed: 0,
      results: [
        {
          step: 0,
          ok: false,
          error: "waitForLabel: no element matching 'Email' appeared within 500ms",
        },
      ],
      error: { code: 'PLAN_WAIT_TIMEOUT', message: 'page text here' },
    });
    const junit = join(dir, 'wait.xml');
    await run(
      ['run', planFile, '--url', 'https://app.test/', '--tenant', 't1', '--junit', junit],
      sessions
    );
    const xml = readFileSync(junit, 'utf8');
    expect(xml).toContain('<failure message="PLAN_WAIT_TIMEOUT"/>');
    expect(xml).toContain(
      '<testcase classname="plan.json" name="step 2: click">\n      <skipped/>'
    );
    expect(xml).not.toContain('Email');
  });

  it('JUnit escapes XML and replaces control characters in the plan file name', async () => {
    const { sessions } = fakeSessions(okReport);
    const odd = write('a&b<"c">\u0001.json', JSON.stringify(steps));
    const junit = join(dir, 'odd.xml');
    await run(
      ['run', odd, '--url', 'https://app.test/', '--tenant', 't1', '--junit', junit],
      sessions
    );
    const xml = readFileSync(junit, 'utf8');
    expect(xml).toContain('name="a&amp;b&lt;&quot;c&quot;&gt;\uFFFD.json"');
  });

  it('refuses an existing --junit path before creating a session (#590 review F1)', async () => {
    const { sessions, calls } = fakeSessions(okReport);
    const existing = write('exists.xml', 'old');
    const result = await run(
      ['run', planFile, '--url', 'https://app.test/', '--tenant', 't1', '--junit', existing],
      sessions
    );
    expect(result.code).not.toBe(0);
    expect(calls).toEqual([]);
    expect(readFileSync(existing, 'utf8')).toBe('old');
  });

  it('refuses an empty plan and a non-http(s) --url before creating a session (F2, F4)', async () => {
    const { sessions, calls } = fakeSessions(okReport);
    const empty = write('empty.json', '[]');
    expect(
      (await run(['run', empty, '--url', 'https://app.test/', '--tenant', 't1'], sessions)).code
    ).not.toBe(0);
    for (const url of ['not a url', 'file:///etc/passwd', 'javascript:alert(1)'])
      expect(
        (await run(['run', planFile, '--url', url, '--tenant', 't1'], sessions)).code,
        url
      ).not.toBe(0);
    expect(calls).toEqual([]);
  });

  it('JUnit writes only known error codes, never another all-caps token (F3)', async () => {
    const { sessions } = fakeSessions({
      ok: false,
      completed: 0,
      results: [{ step: 0, ok: false, error: 'SECRETPAGEWORD' }],
      error: { code: 'ALSOSECRET', message: 'x' },
    });
    const junit = join(dir, 'unknown.xml');
    await run(
      ['run', planFile, '--url', 'https://app.test/', '--tenant', 't1', '--junit', junit],
      sessions
    );
    const xml = readFileSync(junit, 'utf8');
    expect(xml).toContain('<failure message="FAILED"/>');
    expect(xml).not.toMatch(/SECRET/);
  });
});
