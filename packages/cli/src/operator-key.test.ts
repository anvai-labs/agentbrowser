import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildCli, type CliClient } from './cli.js';

/** TD-BROWSER-16 phase 1: operator keys reach the CLI from the file or a
 * prompt — an environment variable is never consulted. */

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cli-operator-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const run = async (
  argv: string[],
  overrides: { env?: Record<string, string | undefined> } = {}
) => {
  const out: string[] = [];
  const err: string[] = [];
  const fetchCalls: Array<{ url: string; authorization?: string }> = [];
  const originalArgv = process.argv;
  const previous: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(overrides.env ?? {})) previous[key] = process.env[key];
  for (const [key, value] of Object.entries(overrides.env ?? {})) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  process.argv = ['node', 'agentbrowser', ...argv];
  globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    fetchCalls.push({
      url: String(url),
      authorization: (init?.headers as Record<string, string>)?.authorization,
    });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as unknown as typeof fetch;
  try {
    const cli = buildCli({
      createClient: () => ({}) as unknown as CliClient,
      out: (line) => out.push(line),
      err: (line) => err.push(line),
    });
    await cli.run(argv);
    return { out, err, fetchCalls };
  } finally {
    process.argv = originalArgv;
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};

describe('operator keys in the CLI', () => {
  it('an operator key in the environment is ignored', async () => {
    const { fetchCalls } = await run(
      ['--operator-key-file', join(dir, 'none'), 'approvals', 'view', 'ses_1', 'tok_1'],
      {
        env: {
          AGENTBROWSER_OPERATOR_KEYS_FILE: '/env/leak',
          AGENTBROWSER_OPERATOR_KEY: 'leaked-key-aaaaaaaaa',
        },
      }
    ).catch(() => ({ fetchCalls: [] as Array<{ authorization?: string }> }));
    for (const call of fetchCalls) expect(call.authorization).not.toContain('leaked');
  });

  it('the key file supplies the bearer for approval commands', async () => {
    const path = join(dir, 'keys');
    await writeFile(path, '# operators\nop-key-one-aaaaaaaa:acme\n');
    const { fetchCalls } = await run([
      '--operator-key-file',
      path,
      'approvals',
      'view',
      'ses_1',
      'tok_1',
    ]);
    expect(fetchCalls[0]?.authorization).toBe('Bearer op-key-one-aaaaaaaa');
  });

  it('a bad key file warns and the command refuses to run unauthenticated', async () => {
    const path = join(dir, 'bad');
    await writeFile(path, 'no-colon-here\n');
    const { fetchCalls, err } = await run([
      '--operator-key-file',
      path,
      'approvals',
      'view',
      'ses_1',
      'tok_1',
    ]).catch((error) => ({
      fetchCalls: [] as Array<{ authorization?: string }>,
      err: [String(error)],
    }));
    expect(fetchCalls.length === 0 || fetchCalls[0]?.authorization === undefined).toBe(true);
    expect(err.join('\n')).toMatch(/cannot read an operator key/);
  });
});

describe('operator commands (TD-BROWSER-16 phase 7)', () => {
  it('operator login-browser open POSTs the operator route with the key-file bearer', async () => {
    const path = join(dir, 'keys');
    await writeFile(path, 'op-key-one-aaaaaaaa:acme\n');
    const { fetchCalls } = await run([
      '--operator-key-file',
      path,
      'operator',
      'login-browser',
      'open',
    ]);
    expect(fetchCalls[0]?.url).toContain('/v1/operator/login/open');
    expect(fetchCalls[0]?.authorization).toBe('Bearer op-key-one-aaaaaaaa');
  });

  it('operator approve posts the decision and a parsed lease', async () => {
    const path = join(dir, 'keys');
    await writeFile(path, 'op-key-one-aaaaaaaa:acme\n');
    const bodies: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (init?.body !== undefined) bodies.push(String(init.body));
      return new Response(JSON.stringify({ kind: 'cookie.handoff', status: 'approved' }), {
        status: 200,
      });
    }) as unknown as typeof fetch;
    try {
      const cli = buildCli({
        createClient: () => ({}) as unknown as CliClient,
        out: () => undefined,
        err: () => undefined,
      });
      process.argv = [
        'node',
        'agentbrowser',
        '--operator-key-file',
        path,
        'operator',
        'approve',
        'ses_1',
        'tok_1',
        '--lease',
        'hosts=example.com,api.example.com',
        'minutes=30',
        'actions=100',
      ];
      await cli.run(process.argv.slice(2));
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(bodies[0]).toBe(
      JSON.stringify({
        decision: 'approve',
        lease: {
          hosts: ['example.com', 'api.example.com'],
          expiresInMs: 1_800_000,
          maxActions: 100,
        },
      })
    );
  });

  it('operator approve refuses an incomplete lease spec', async () => {
    const path = join(dir, 'keys');
    await writeFile(path, 'op-key-one-aaaaaaaa:acme\n');
    const { err } = await run(
      [
        '--operator-key-file',
        path,
        'operator',
        'approve',
        'ses_1',
        'tok_1',
        '--lease',
        'hosts=example.com',
      ],
      {}
    ).catch((error) => ({ err: [String(error)] }));
    expect(err.join('\n')).toMatch(/--lease needs/);
  });
});

describe('session cookie-handoff relay (TD-BROWSER-16 phase 7)', () => {
  it('prints the approval request (token + counts) when the server requires a decision', async () => {
    const lines: string[] = [];
    const cookieHandoff = vi.fn().mockRejectedValue({
      code: 'APPROVAL_REQUIRED',
      message: 'needs an operator decision',
      retryable: false,
      details: {
        tokenId: 'tok_9',
        kind: 'cookie.handoff',
        domains: ['example.com'],
        counts: { cookies: 2, 'example.com': 2 },
      },
    });
    process.argv = [
      'node',
      'agentbrowser',
      'session',
      'cookie-handoff',
      'ses_1',
      '--domain',
      'example.com',
    ];
    const cli = buildCli({
      createClient: () => ({ sessions: { cookieHandoff } }) as unknown as CliClient,
      out: (line) => lines.push(line),
      err: () => undefined,
    });
    await cli.run(process.argv.slice(2));
    const text = lines.join('\n');
    expect(text).toContain('tok_9');
    expect(text).toContain('operator approve ses_1 tok_9');
    expect(text).not.toContain('value');
  });
});
