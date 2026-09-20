import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildCli } from './cli.js';

const bundle = () => {
  const environment = {
    productVersion: '1.9.0',
    cliVersion: '1.9.0',
    engine: { name: 'chromium', version: '140.0.0' },
    fixture: { id: 'counter', version: '1.0.0' },
  };
  return {
    schemaVersion: 1,
    descriptor: {
      id: 'counter',
      version: '1.0.0',
      testedSeam: 'ui',
      environment,
      assertions: [{ id: 'commit', required: true }],
    },
    invocations: [
      {
        id: 'commit',
        operationId: 'outer-1',
        request: {
          actions: [{ action: 'click', target: { ref: 'e1_0' } }],
          verification: {
            verifier: { id: 'counter', version: '1.0.0' },
            input: { secret: 'PRIVATE-EXPECTED-INPUT' },
          },
        },
      },
    ],
    report: {
      case: { id: 'counter', version: '1.0.0' },
      environment,
      setup: 'completed',
      cleanup: 'complete',
      assertions: [
        {
          id: 'commit',
          status: 'completed',
          operationId: 'outer-1',
          report: {
            plan: { ok: true, completed: 1, results: [{ step: 0, ok: true }] },
            outcome: {
              availability: 'available',
              execution: 'completed',
              cleanup: 'complete',
              testedSeam: 'ui',
              verification: {
                status: 'passed',
                verifier: { id: 'counter', version: '1.0.0' },
                requiredLayer: 'G4',
                achievedLayer: 'G4',
                evidenceRefIds: ['event-1'],
              },
            },
          },
        },
      ],
    },
  };
};

function harness(stdin?: Readable) {
  const out: string[] = [];
  const err: string[] = [];
  const createClient = vi.fn(() => {
    throw new Error('Offline evaluation constructed a client');
  });
  const cli = buildCli({
    ...(stdin ? { stdin } : {}),
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    createClient,
  });
  return { cli, out, err, createClient };
}

afterEach(() => vi.unstubAllGlobals());

describe('offline test evaluation', () => {
  it('advertises the canonical wire contract and is covered by the JSON-input audit', async () => {
    const { cli, out, createClient } = harness();
    expect(await cli.run(['describe', 'test', 'evaluate', '--schema'])).toBe(0);
    const discovery = JSON.parse(out.join('\n'));
    expect(discovery.command.path).toEqual(['test', 'evaluate']);
    expect(discovery.command.schemas.input.$id).toBe(
      'urn:agentbrowser:test-case-evaluation-input:v1'
    );
    expect(discovery.command.schemas.output.$id).toBe(
      'urn:agentbrowser:test-case-evaluation-report:v1'
    );
    expect(cli.jsonContractAudit()).toContainEqual({
      path: ['test', 'evaluate'],
      advertised: true,
      exempt: false,
    });
    expect(createClient).not.toHaveBeenCalled();
  });

  it('evaluates inline input without client, credentials or network and omits private requests', async () => {
    const { cli, out, err, createClient } = harness();
    const env = process.env;
    let credentialReads = 0;
    process.env = new Proxy(env, {
      get(target, key) {
        if (key === 'AGENTBROWSER_API_KEY') {
          credentialReads++;
          throw new Error('Credential read');
        }
        return Reflect.get(target, key);
      },
    });
    const fetch = vi.fn(() => {
      throw new Error('Network call');
    });
    vi.stubGlobal('fetch', fetch);
    try {
      expect(
        await cli.run([
          '--json',
          '--operation-id',
          'unused',
          'test',
          'evaluate',
          JSON.stringify(bundle()),
        ])
      ).toBe(0);
    } finally {
      process.env = env;
    }
    expect(credentialReads).toBe(0);
    expect(createClient).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(err).toEqual([]);
    expect(JSON.parse(out.join('\n'))).toEqual({
      schemaVersion: 1,
      provenance: 'caller_observed',
      verdict: 'passed',
      descriptor: bundle().descriptor,
      report: bundle().report,
    });
    expect(out.join('\n')).not.toContain('PRIVATE-EXPECTED-INPUT');
  });

  it('supports stdin and @file with the existing bounded reader', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'test-evaluation-'));
    try {
      const path = join(directory, 'input.json');
      await writeFile(path, JSON.stringify(bundle()));
      for (const source of ['-', `@${path}`]) {
        const { cli, out, err } = harness(Readable.from([JSON.stringify(bundle())]));
        expect(await cli.run(['--json', 'test', 'evaluate', source])).toBe(0);
        expect(JSON.parse(out.join('\n')).verdict).toBe('passed');
        expect(err).toEqual([]);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('returns a complete failed report with nonzero status and no error output', async () => {
    const input = bundle();
    input.report.cleanup = 'failed';
    const { cli, out, err } = harness();
    expect(await cli.run(['--json', 'test', 'evaluate', JSON.stringify(input)])).toBe(1);
    const result = JSON.parse(out.join('\n'));
    expect(result.verdict).toBe('failed');
    expect(result.report).toEqual(input.report);
    expect(err).toEqual([]);
  });

  it('prints only the case ID and verdict in human mode', async () => {
    const { cli, out, err } = harness();
    expect(await cli.run(['test', 'evaluate', JSON.stringify(bundle())])).toBe(0);
    expect(out).toEqual(['counter: passed']);
    expect(err).toEqual([]);
  });

  it('rejects malformed, mismatched and oversized inputs without output or secret/path disclosure', async () => {
    const mismatch = bundle();
    mismatch.report.case.id = 'PRIVATE-CASE';
    for (const source of [
      '{"PRIVATE-SECRET":',
      '@/PRIVATE-FILE-NOT-PRESENT',
      JSON.stringify(mismatch),
      JSON.stringify({ ...bundle(), private: 'PRIVATE-EXTRA' }),
      JSON.stringify({ ...bundle(), private: `PRIVATE-${'x'.repeat(1024 * 1024)}` }),
    ]) {
      const { cli, out, err } = harness();
      expect(await cli.run(['--json', 'test', 'evaluate', source])).toBe(1);
      expect(out).toEqual([]);
      expect(err.join('\n')).toContain('Invalid test case evaluation');
      expect(err.join('\n')).not.toContain('PRIVATE');
      expect(err.join('\n').length).toBeLessThan(300);
    }
  });
});
