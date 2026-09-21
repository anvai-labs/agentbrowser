import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildCli } from './cli.js';
import { MAX_JSON_INPUT_BYTES, createJsonArgumentReader } from './json-input.js';

function harness(stdin?: Readable) {
  const out: string[] = [];
  const err: string[] = [];
  const createClient = vi.fn(() => {
    throw new Error('Offline command constructed a client');
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

const mapping = {
  schemaVersion: 1,
  id: 'employment',
  revision: '1',
  scope: { url: 'https://example.test/apply?id=123' },
  fields: [
    {
      match: { label: 'Company', block: { id: 'current' } },
      strategy: 'native-input',
      input: 'value',
      valueKey: 'company',
    },
  ],
};
const values = { company: 'PRIVATE-COMPANY' };
const expected = {
  scope: mapping.scope,
  fields: [
    {
      match: mapping.fields[0]!.match,
      strategy: 'native-input',
      verify: 'exact',
      value: values.company,
    },
  ],
  policy: { onAmbiguous: 'fail', onVerifyFail: 'fail' },
};

describe('offline form preparation', () => {
  it('advertises both logical arguments and the canonical autofill output schema', async () => {
    const { cli, out, createClient } = harness();
    expect(await cli.run(['describe', 'form', 'prepare', '--schema'])).toBe(0);
    const descriptor = JSON.parse(out.join('\n')).command;
    expect(descriptor.path).toEqual(['form', 'prepare']);
    expect(descriptor.arguments.map((argument: { name: string }) => argument.name)).toEqual([
      'mappingJson',
      'valuesJson',
    ]);
    expect(descriptor.schemas.input).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['mapping', 'values'],
      properties: { mapping: { type: 'object' }, values: { type: 'object' } },
    });
    expect(descriptor.schemas.output.properties.fields).toMatchObject({
      type: 'array',
      maxItems: 50,
    });
    expect(cli.jsonContractAudit()).toContainEqual({
      path: ['form', 'prepare'],
      advertised: true,
      exempt: false,
    });
    expect(createClient).not.toHaveBeenCalled();
  });

  it('documents private payload output and bounded input syntax offline', async () => {
    const { cli, out, createClient } = harness();
    expect(await cli.run(['form', 'prepare', '--help'])).toBe(0);
    const help = out.join('\n');
    expect(help).toContain('private values');
    expect(help).toContain('@file');
    expect(help).toContain('1 MiB');
    expect(createClient).not.toHaveBeenCalled();
  });

  it.each([false, true])('materializes inline input offline with JSON mode %s', async (json) => {
    const { cli, out, err, createClient } = harness();
    const fetch = vi.fn(() => {
      throw new Error('Unexpected network call');
    });
    vi.stubGlobal('fetch', fetch);
    const env = process.env;
    let credentialReads = 0;
    process.env = new Proxy(env, {
      get(target, key) {
        if (key === 'AGENTBROWSER_API_KEY') {
          credentialReads++;
          throw new Error('Unexpected credential read');
        }
        return Reflect.get(target, key);
      },
    });
    try {
      expect(
        await cli.run([
          ...(json ? ['--json'] : []),
          'form',
          'prepare',
          JSON.stringify(mapping),
          JSON.stringify(values),
        ])
      ).toBe(0);
    } finally {
      process.env = env;
    }
    expect(JSON.parse(out.join('\n'))).toEqual(expected);
    expect(err).toEqual([]);
    expect(createClient).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(credentialReads).toBe(0);
  });

  it('reuses bounded @file reading for both arguments', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'form-prepare-'));
    try {
      const mappingFile = join(dir, 'mapping.json');
      const valuesFile = join(dir, 'values.json');
      await writeFile(mappingFile, JSON.stringify(mapping), { mode: 0o600 });
      await writeFile(valuesFile, JSON.stringify(values), { mode: 0o600 });
      const { cli, out, err, createClient } = harness();
      expect(await cli.run(['form', 'prepare', `@${mappingFile}`, `@${valuesFile}`])).toBe(0);
      expect(JSON.parse(out.join('\n'))).toEqual(expected);
      expect(err).toEqual([]);
      expect(createClient).not.toHaveBeenCalled();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it.each(['mapping', 'values'])('accepts one piped %s input', async (input) => {
    const { cli, out, createClient } = harness(
      Readable.from([JSON.stringify(input === 'mapping' ? mapping : values)])
    );
    expect(
      await cli.run([
        'form',
        'prepare',
        input === 'mapping' ? '-' : JSON.stringify(mapping),
        input === 'values' ? '-' : JSON.stringify(values),
      ])
    ).toBe(0);
    expect(JSON.parse(out.join('\n'))).toEqual(expected);
    expect(createClient).not.toHaveBeenCalled();
  });

  it.each([
    '{}',
    '{"company":17}',
    '{"company":"PRIVATE-COMPANY","extra":"PRIVATE-EXTRA"}',
    '{PRIVATE-JSON',
  ])('refuses missing, malformed or extra values without private diagnostics', async (raw) => {
    const { cli, out, err, createClient } = harness();
    expect(await cli.run(['form', 'prepare', JSON.stringify(mapping), raw])).toBe(1);
    expect(out).toEqual([]);
    expect(err.join('\n')).not.toContain('PRIVATE');
    expect(err.join('\n')).not.toBe('');
    expect(createClient).not.toHaveBeenCalled();
  });

  it('enforces the existing byte bound before parsing', async () => {
    const { cli, out, err, createClient } = harness();
    expect(
      await cli.run(['form', 'prepare', JSON.stringify(mapping), ' '.repeat(1024 * 1024 + 1)])
    ).toBe(1);
    expect(err.join('\n')).toContain('exceeds 1048576 bytes');
    expect(out).toEqual([]);
    expect(createClient).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'keeps expanded payloads within the pipe bound (oversized=%s)',
    async (oversized) => {
      const repeatedMapping = {
        ...mapping,
        fields: Array.from({ length: 50 }, () => mapping.fields[0]),
      };
      const emptyPayload = {
        ...expected,
        fields: Array.from({ length: 50 }, () => ({ ...expected.fields[0], value: '' })),
      };
      // Each null code point expands to six JSON bytes in each of 50 fields.
      const available = MAX_JSON_INPUT_BYTES - 1 - Buffer.byteLength(JSON.stringify(emptyPayload));
      const chars = Math.floor(available / (6 * 50)) + (oversized ? 1 : 0);
      const privateValues = { company: '\u0000'.repeat(chars) };
      const { cli, out, err, createClient } = harness();
      expect(
        await cli.run([
          'form',
          'prepare',
          JSON.stringify(repeatedMapping),
          JSON.stringify(privateValues),
        ])
      ).toBe(oversized ? 1 : 0);
      expect(createClient).not.toHaveBeenCalled();
      if (oversized) {
        expect(out).toEqual([]);
        expect(err.join('\n')).not.toBe('');
        return;
      }
      expect(err).toEqual([]);
      expect(out).toHaveLength(1);
      const output = out[0]!;
      expect(output).toBe(JSON.stringify(JSON.parse(output)));
      expect(Buffer.byteLength(`${output}\n`)).toBeLessThanOrEqual(MAX_JSON_INPUT_BYTES);
      expect(Buffer.byteLength(`${output}\n`)).toBeGreaterThan(MAX_JSON_INPUT_BYTES - 300);
      const readJson = createJsonArgumentReader({ stdin: Readable.from([`${output}\n`]) });
      expect(await readJson('-', 'prepared payload')).toEqual({
        ...emptyPayload,
        fields: emptyPayload.fields.map((field) => ({ ...field, value: privateValues.company })),
      });
    }
  );

  it('refuses two stdin arguments before reading the stream', async () => {
    const stdin = new Readable({
      read() {
        throw new Error('Should not read stdin');
      },
    });
    const { cli, out, err, createClient } = harness(stdin);
    expect(await cli.run(['form', 'prepare', '-', '-'])).toBe(1);
    expect(err.join('\n')).toContain('Stdin can be used only once');
    expect(out).toEqual([]);
    expect(stdin.readableFlowing).toBe(null);
    expect(createClient).not.toHaveBeenCalled();
    stdin.destroy();
  });

  it.each(['{PRIVATE-MALFORMED', 'null', '[]', '{}'])(
    'refuses invalid mapping without output, private input echo, or service construction',
    async (mapping) => {
      const { cli, out, err, createClient } = harness();
      expect(await cli.run(['form', 'prepare', mapping, '{"secret":"PRIVATE-VALUE"}'])).toBe(1);
      expect(out).toEqual([]);
      expect(err.join('\n')).not.toContain('PRIVATE');
      expect(err.join('\n')).not.toBe('');
      expect(createClient).not.toHaveBeenCalled();
    }
  );
});
