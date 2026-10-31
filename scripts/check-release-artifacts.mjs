#!/usr/bin/env node
/** Verify actual built surfaces, not just source manifests. No browser is launched. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildServer } from '../packages/api/dist/server.js';
import { FakeEngine } from '../packages/testkit/dist/index.js';
import { checkCatalogDocument } from './mcp-catalog-docs.mjs';
import { checkCli, checkCliTestEvaluation, checkMcpContracts } from './release-smoke.mjs';
import { checkSpecContext } from './spec-context.mjs';

const root = new URL('../', import.meta.url);
const { version } = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'));
const server = await buildServer({ engine: new FakeEngine(), apiKeys: new Map() });
try {
  const response = await server.inject({ url: '/health' });
  assert.equal(response.json().version, version, 'Built API product version');
} finally { await server.close(); }

const cliCommand = [
  process.execPath,
  fileURLToPath(new URL('packages/cli/dist/bin.js', root)),
];
const cliContracts = await checkCli(cliCommand, {
  expectedVersion: version,
  timeoutMs: 10_000,
});
await checkCliTestEvaluation(cliCommand, { expectedVersion: version, timeoutMs: 10_000 });
assert.equal(cliContracts.version, version, 'Built CLI product version');
const discovery = JSON.parse(execFileSync(cliCommand[0], [...cliCommand.slice(1), 'describe', 'act', 'press'], { encoding: 'utf8', timeout: 10_000 }));
assert.equal(discovery.schemaVersion, 1, 'Built CLI discovery contract version');
assert.equal(discovery.productVersion, version, 'Built CLI discovery product version');
assert.equal(discovery.scope, 'cli-command-definitions', 'Discovery must not claim live capability qualification');
assert.deepEqual(discovery.command.path, ['act', 'press'], 'Built CLI nested command discovery');
assert.ok(discovery.command.options.some((option) => option.flags === '--count <n>'), 'Built CLI exposes delivered counted keypress option');
const autofillDiscovery = JSON.parse(execFileSync(process.execPath, [fileURLToPath(new URL('packages/cli/dist/bin.js', root)), 'describe', 'autofill', '--schema'], { encoding: 'utf8', timeout: 10_000 }));
assert.equal(autofillDiscovery.command.schemas.input.properties.fields.items.properties.match.properties.block.properties.label.maxLength, 512, 'Built CLI preserves nested canonical match schema');
assert.ok(autofillDiscovery.command.schemas.output.properties.receipts.items.properties.status.anyOf.some((entry) => entry.const === 'uncertain'), 'Built CLI exposes uncertain receipt status');
execFileSync(process.execPath, [fileURLToPath(new URL('packages/mcp-server/scripts/smoke.mjs', root)), process.execPath, fileURLToPath(new URL('packages/mcp-server/dist/bin.js', root))], {
  stdio: 'inherit', timeout: 30_000,
  env: { ...process.env, AGENTBROWSER_MCP_VERSION: undefined },
});
await checkCatalogDocument();
execFileSync(process.execPath, ['--test', fileURLToPath(new URL('scripts/mcp-catalog-docs.test.mjs', root))], { stdio: 'inherit', timeout: 10_000 });
execFileSync(process.execPath, ['--test', fileURLToPath(new URL('scripts/spec-context.test.mjs', root))], { stdio: 'inherit', timeout: 10_000 });
console.log(JSON.stringify({ specContext: 'PASS', ...(await checkSpecContext()) }));
const contracts = await checkMcpContracts([process.execPath, fileURLToPath(new URL('packages/mcp-server/dist/bin.js', root))], { expectedVersion: version });
console.log(JSON.stringify({ mcpContracts: 'PASS', ...contracts }));
console.log(`Built API, CLI and MCP report product version ${version}.`);
