#!/usr/bin/env node
/**
 * Smoke a compiled agentbrowser-server executable: boot it on an ephemeral
 * port and require a healthy answer from GET /health, then stop it.
 *
 * This is the gate that catches runtime-only breaks bun --compile can
 * introduce — most importantly node:sqlite (journal/control layer) under
 * bun's runtime: bundling succeeds statically, only a real boot exercises
 * the module. Spawned without a shell; works on every CI runner.
 *
 * Usage: node scripts/smoke.mjs <path-to-executable>
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:net';

const exe = process.argv[2];
if (!exe) {
  console.error('usage: node scripts/smoke.mjs <path-to-executable>');
  process.exit(2);
}

/** Reserve a free TCP port by binding :0, then release it for the server. */
const freePort = () =>
  new Promise((resolvePort, rejectPort) => {
    const srv = createServer();
    srv.on('error', rejectPort);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolvePort(port));
    });
  });

const port = await freePort();
const child = spawn(exe, [], {
  env: { ...process.env, PORT: String(port), HOST: '127.0.0.1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let stderrTail = '';
child.stderr.on('data', (d) => {
  stderrTail = (stderrTail + d).slice(-2000);
});

const deadline = Date.now() + 45000;
let lastError = '';
try {
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`server exited early with code ${child.exitCode}: ${stderrTail}`);
    }
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(2000),
      });
      if (res.ok) {
        const body = await res.json();
        if (body.status !== 'healthy') {
          throw new Error(`/health returned status=${body.status}`);
        }
        console.log(`smoke OK: /health healthy on 127.0.0.1:${port}`);
        process.exit(0);
      }
      lastError = `HTTP ${res.status}`;
    } catch (e) {
      if (e instanceof TypeError || e.name === 'TimeoutError' || e.name === 'AbortError') {
        lastError = 'not listening yet'; // connection refused during boot
      } else {
        throw e;
      }
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`/health never answered within 45s (last: ${lastError}); stderr: ${stderrTail}`);
} finally {
  child.kill();
}
