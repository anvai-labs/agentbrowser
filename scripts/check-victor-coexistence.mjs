#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const victor = process.env.AGENTBROWSER_VICTOR_ROOT;
const python = process.env.AGENTBROWSER_VICTOR_PYTHON;
if (!victor || !python || !existsSync(resolve(victor, 'victor/integrations/mcp/client.py')) || !existsSync(python)) {
  throw new Error('Set AGENTBROWSER_VICTOR_ROOT to the Victor checkout and AGENTBROWSER_VICTOR_PYTHON to its Python executable. This acceptance command never silently skips Victor.');
}
for (const args of [
  ['-r', 'build'],
  ['--filter', '@agentbrowser/api', 'exec', 'vitest', 'run', 'src/coexistence-real-chromium.test.ts'],
]) {
  const result = spawnSync('pnpm', args, { cwd: root, env: process.env, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
