#!/usr/bin/env node
/** Measure catalog bytes/tokens and fresh-process MCP RSS without turning them into CI limits. */
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { collectCatalogs } from './mcp-catalog-docs.mjs';

const CHILD = String.raw`
const mode = process.argv[1];
const binding = process.argv[2];
const baseline = process.memoryUsage();
const { buildMcpServer } = await import('./packages/mcp-server/dist/index.js');
const cold = process.memoryUsage();
const server = buildMcpServer({
  createClient: () => new Proxy({}, { get() { throw new Error('measurement attempted service access'); } }),
  mode,
  ...(binding === 'delegated' ? { sessionId: 'footprint-binding' } : {}),
});
const exchange = async (method, params = {}) => {
  const wire = await server.handle(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }));
  const response = JSON.parse(wire);
  if (response.error) throw new Error('MCP measurement failed');
  return response.result;
};
await exchange('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'footprint', version: '1' } });
let result;
for (let index = 0; index < 10; index++) result = await exchange('tools/list');
await new Promise(resolve => setImmediate(resolve));
const warm = process.memoryUsage();
console.log(JSON.stringify({
  baselineRssBytes: baseline.rss,
  coldRssBytes: cold.rss,
  warmRssBytes: warm.rss,
  warmHeapUsedBytes: warm.heapUsed,
  serializedBytes: Buffer.byteLength(JSON.stringify(result)),
  toolCount: result.tools.length,
}));
`;

const TOKEN_COUNTER = String.raw`
import json, sys, tiktoken
rows = json.load(sys.stdin)
encodings = {name: tiktoken.get_encoding(name) for name in ('cl100k_base', 'o200k_base')}
print(json.dumps({row['mode']: {name: len(encoding.encode(row['catalog'])) for name, encoding in encodings.items()} for row in rows}))
`;

export function median(values) {
  if (!Array.isArray(values) || values.length === 0) throw new Error('median needs samples');
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 1 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
}

export function summarizeSamples(samples) {
  const keys = ['baselineRssBytes', 'coldRssBytes', 'warmRssBytes', 'warmHeapUsedBytes'];
  return {
    ...Object.fromEntries(keys.map((key) => [key, median(samples.map((sample) => sample[key]))])),
    coldRssDeltaBytes: median(
      samples.map((sample) => sample.coldRssBytes - sample.baselineRssBytes)
    ),
    warmRssDeltaBytes: median(samples.map((sample) => sample.warmRssBytes - sample.coldRssBytes)),
  };
}

export function parseFootprintArgs(argv) {
  const options = { samples: 3 };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--samples') {
      const value = Number(argv[++index]);
      if (!Number.isSafeInteger(value) || value < 1 || value > 9)
        throw new Error('samples must be an integer from 1 through 9');
      options.samples = value;
    } else if (argument === '--tokenizer-python') {
      const value = argv[++index];
      if (!value) throw new Error('tokenizer Python interpreter is required');
      options.tokenizerPython = value;
    } else {
      throw new Error('usage: mode-footprint.mjs [--samples <1..9>] [--tokenizer-python <path>]');
    }
  }
  return options;
}

function measureProcess(mode, binding) {
  const output = execFileSync(
    process.execPath,
    ['--input-type=module', '-e', CHILD, mode, binding],
    {
      cwd: new URL('../', import.meta.url),
      encoding: 'utf8',
      timeout: 30_000,
    }
  );
  return JSON.parse(output);
}

function countTokens(python, catalogs) {
  const rows = catalogs.map(({ mode, tools }) => ({
    mode,
    catalog: JSON.stringify({ tools }),
  }));
  return JSON.parse(
    execFileSync(python, ['-c', TOKEN_COUNTER], {
      input: JSON.stringify(rows),
      encoding: 'utf8',
      timeout: 60_000,
    })
  );
}

export async function measureModeFootprint(options = { samples: 3 }) {
  const catalogs = await collectCatalogs();
  const tokens = options.tokenizerPython
    ? countTokens(options.tokenizerPython, catalogs)
    : undefined;
  const rows = [];
  for (const catalog of catalogs) {
    const [binding, mode] = catalog.mode.split('/');
    const samples = Array.from({ length: options.samples }, () => measureProcess(mode, binding));
    const expectedBytes = Buffer.byteLength(JSON.stringify({ tools: catalog.tools }));
    if (samples.some((sample) => sample.serializedBytes !== expectedBytes))
      throw new Error(`catalog bytes changed during ${catalog.mode} measurement`);
    const memory = summarizeSamples(samples);
    rows.push({
      mode,
      binding,
      toolCount: samples[0].toolCount,
      serializedBytes: expectedBytes,
      ...(tokens ? { tokenizerTokens: tokens[catalog.mode] } : {}),
      ...memory,
    });
  }
  return {
    measuredAt: new Date().toISOString(),
    environment: {
      platform: process.platform,
      arch: process.arch,
      osRelease: os.release(),
      node: process.version,
      samples: options.samples,
      tokenizers: options.tokenizerPython ? ['cl100k_base', 'o200k_base'] : [],
    },
    rows,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    console.log(
      JSON.stringify(await measureModeFootprint(parseFootprintArgs(process.argv.slice(2))), null, 2)
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
