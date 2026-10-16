/**
 * T5 J3d review F3: the CLI must not hide a partial lookup or a refused history namespace.
 */
import { describe, expect, it, vi } from 'vitest';
import { buildCli } from './cli.js';

function harness(client: Record<string, unknown>) {
  const out: string[] = [];
  const err: string[] = [];
  const cli = buildCli({
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    createClient: vi.fn(() => client) as never,
  });
  return { cli, out, err };
}

describe('agentbrowser journal (J3b/J3d)', () => {
  it('operations names each record’s namespace and flags unread namespaces', async () => {
    const { cli, out } = harness({
      journalOperations: vi.fn(async () => ({
        schemaVersion: 1,
        operationId: 'op-1',
        absent: false,
        truncated: false,
        unreadNamespaces: ['ns-early'],
        records: [
          {
            namespace: 'ns-a',
            classification: 'in_doubt',
            actionable: true,
            application: { adapter: 'a', resource: 'r', bindingGeneration: 'g' },
            session: { sessionIncarnation: 'i'.repeat(22), epoch: 1 },
          },
        ],
      })),
    });
    expect(await cli.run(['journal', 'operations', 'op-1'])).toBe(0);
    const text = out.join('\n');
    expect(text).toContain('ns-a: in_doubt (actionable)');
    expect(text).toMatch(/UNREAD namespaces: ns-early — the history is partly unread, not absent/);
    expect(text).not.toMatch(/absent in every searched namespace/);
  });

  it('status lists history namespaces with their state and reason', async () => {
    const { cli, out } = harness({
      journalStatus: vi.fn(async () => ({
        schemaVersion: 1,
        configured: true,
        namespace: 'ns-b',
        health: 'open',
        runtime: { platform: 'linux', node: '24.21.0', qualified: true },
        recoveryQualified: true,
        history: [
          {
            namespace: 'ns-a',
            state: 'refused',
            reason: 'definitely_not_opened: configuration',
            acceptUntil: '2026-01-01T00:00:00.000Z',
            retainUntil: '2026-01-31T00:00:00.000Z',
          },
        ],
      })),
    });
    expect(await cli.run(['journal', 'status'])).toBe(0);
    expect(out.join('\n')).toContain(
      'history ns-a: refused (definitely_not_opened: configuration), retains until 2026-01-31T00:00:00.000Z'
    );
  });
});
