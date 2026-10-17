// T10 M2: `session scope` and `session scope-check` (FakeClient; no server).
import { describe, expect, it, vi } from 'vitest';
import { buildCli, type CliClient } from './cli.js';

async function run(argv: string[], sessions: Record<string, unknown>) {
  const out: string[] = [];
  const err: string[] = [];
  const cli = buildCli({
    createClient: () => ({ sessions }) as unknown as CliClient,
    out: (line: string) => out.push(line),
    err: (line: string) => err.push(line),
  });
  const code = await cli.run(argv);
  return { code, out, err };
}

describe('scope commands (T10 M2)', () => {
  it('session scope prints the status as JSON', async () => {
    const status = {
      allowedHosts: ['in.example'],
      pathRules: [],
      identityBindings: [],
      expired: false,
      budget: { limit: 5, spent: 2, remaining: 3 },
      denials: { SCOPE_HOST_DENIED: 1 },
    };
    const scopeStatus = vi.fn().mockResolvedValue(status);
    const { code, out } = await run(['--json', 'session', 'scope', 'ses_1'], { scopeStatus });
    expect(code).toBe(0);
    expect(scopeStatus).toHaveBeenCalledWith('ses_1');
    expect(JSON.parse(out.join('\n'))).toEqual(status);
  });

  it('session scope-check passes url and method and prints the verdict', async () => {
    const checkScope = vi.fn().mockResolvedValue({ allowed: false, scope: 'SCOPE_METHOD_DENIED' });
    const { code, out } = await run(
      ['session', 'scope-check', 'ses_1', 'https://in.example/a', '--method', 'DELETE'],
      { checkScope }
    );
    expect(code).toBe(0);
    expect(checkScope).toHaveBeenCalledWith('ses_1', {
      url: 'https://in.example/a',
      method: 'DELETE',
    });
    expect(out.join('\n')).toContain('denied by the scope: SCOPE_METHOD_DENIED');
  });

  it('session scope human output lists every rule, never a marker value', async () => {
    const scopeStatus = vi.fn().mockResolvedValue({
      allowedHosts: ['in.example'],
      pathRules: [{ prefix: '/api' }],
      allowedMethods: ['GET'],
      identityBindings: [{ header: 'x-id', allowedHosts: ['in.example'] }],
      expiresAt: 0,
      expired: true,
      budget: { limit: 5, spent: 5, remaining: 0 },
      denials: { SCOPE_BUDGET_EXHAUSTED: 2 },
    });
    const { code, out } = await run(['session', 'scope', 'ses_1'], { scopeStatus });
    const text = out.join('\n');
    expect(code).toBe(0);
    for (const line of [
      'hosts:   in.example',
      'path:    /api',
      'methods: GET',
      'identity: x-id bound to in.example',
      'budget:  5/5 spent (0 left)',
      '(expired)',
      'denied:  SCOPE_BUDGET_EXHAUSTED x2',
    ])
      expect(text).toContain(line);
  });

  it('session scope-check prints an allowed verdict', async () => {
    const checkScope = vi.fn().mockResolvedValue({ allowed: true });
    const { code, out } = await run(['session', 'scope-check', 'ses_1', 'https://in.example/'], {
      checkScope,
    });
    expect(code).toBe(0);
    expect(checkScope).toHaveBeenCalledWith('ses_1', { url: 'https://in.example/' });
    expect(out.join('\n')).toContain('allowed by the scope');
  });
});
