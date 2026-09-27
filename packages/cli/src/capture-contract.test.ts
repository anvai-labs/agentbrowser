import {
  DELIVERED_WAIT_TYPES,
  ObservationRequestSchema,
  ScreenshotRequestSchema,
} from '@agentbrowser/sdk-typescript';
import { describe, expect, it, vi } from 'vitest';
import { type CliClient, buildCli } from './cli.js';

describe.each(['observe', 'screenshot'] as const)('%s capture CLI', (operation) => {
  function setup() {
    const invoke = vi.fn().mockResolvedValue({ elements: [], revision: 1 });
    const out: string[] = [];
    const err: string[] = [];
    const cli = buildCli({
      createClient: () => ({ sessions: { [operation]: invoke } }) as unknown as CliClient,
      out: (line) => out.push(line),
      err: (line) => err.push(line),
    });
    return { cli, invoke, out, err };
  }
  it.each(DELIVERED_WAIT_TYPES)('forwards %s with its required fields', async (until) => {
    const { cli, invoke } = setup();
    const flags = ['--wait-until', until, '--wait-timeout', '250'];
    const wait: Record<string, unknown> = { until, timeoutMs: 250 };
    if (until === 'minElements') {
      flags.push('--wait-count', '2');
      wait.count = 2;
    }
    if (until === 'urlPattern') {
      flags.push('--wait-pattern', '**/ready');
      wait.pattern = '**/ready';
    }
    if (until === 'selectorVisible') {
      flags.push('--wait-selector', '#ready');
      wait.selector = '#ready';
    }
    expect(await cli.run(['--json', operation, 'ses_1', 'pg_1', ...flags])).toBe(0);
    expect(invoke).toHaveBeenCalledWith('ses_1', 'pg_1', { wait });
  });
  it.each([
    ['--wait-count', '2'],
    ['--wait-until', 'bogus'],
    ['--wait-until', 'minElements'],
    ['--wait-until', 'minElements', '--wait-count', '3junk'],
    ['--wait-until', 'minElements', '--wait-count', '1.5'],
    ['--wait-until', 'load', '--wait-timeout', '300001'],
    ['--wait-until', 'selectorVisible'],
    ['--wait-until', 'urlPattern'],
  ])('rejects invalid flags %j', async (...flags) => {
    const { cli, invoke } = setup();
    expect(await cli.run([operation, 'ses_1', 'pg_1', ...flags])).toBe(1);
    expect(invoke).not.toHaveBeenCalled();
  });
  it('discovers the canonical request schema and every wait switch offline', async () => {
    const { cli, out, invoke } = setup();
    expect(await cli.run(['describe', operation, '--schema'])).toBe(0);
    const command = JSON.parse(out.join('\n')).command;
    expect(command.schemas.input).toEqual(
      JSON.parse(
        JSON.stringify(operation === 'observe' ? ObservationRequestSchema : ScreenshotRequestSchema)
      )
    );
    expect(
      command.options.filter((option: { flags: string }) => option.flags.startsWith('--wait-'))
    ).toHaveLength(5);
    expect(invoke).not.toHaveBeenCalled();
  });
  if (operation === 'observe')
    it('renders the degraded signal in human output', async () => {
      const { cli, invoke, out } = setup();
      invoke.mockResolvedValue({
        elements: [],
        degraded: true,
        degradedReason: 'empty-snapshot-nonempty-dom',
      });
      expect(await cli.run(['observe', 'ses_1', 'pg_1'])).toBe(0);
      expect(out.join('\n')).toContain('empty-snapshot-nonempty-dom');
    });
});
