#!/usr/bin/env node
/** Verify actual built surfaces, not just source manifests. No browser is launched. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildServer } from '../packages/api/dist/server.js';
import { FakeEngine } from '../packages/testkit/dist/index.js';

const root = new URL('../', import.meta.url);
const { version } = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'));
const server = await buildServer({ engine: new FakeEngine(), apiKeys: new Map() });
try {
  const response = await server.inject({ url: '/health' });
  assert.equal(response.json().version, version, 'Built API product version');
} finally { await server.close(); }

const cli = execFileSync(process.execPath, [fileURLToPath(new URL('packages/cli/dist/bin.js', root)), '--version'], { encoding: 'utf8', timeout: 10_000 });
assert.equal(cli.trim(), version, 'Built CLI product version');
execFileSync(process.execPath, [fileURLToPath(new URL('packages/mcp-server/scripts/smoke.mjs', root)), process.execPath, fileURLToPath(new URL('packages/mcp-server/dist/bin.js', root))], {
  stdio: 'inherit', timeout: 30_000,
  env: { ...process.env, AGENTBROWSER_MCP_VERSION: undefined },
});
console.log(`Built API, CLI and MCP report product version ${version}.`);
