#!/usr/bin/env node
/** T8 footprint gates: the shipped single-file binaries must stay within
 * explicit peak-RSS bounds (T8 packet: "Compare isolated imports/install
 * sizes and RSS separately"). Run from the repo root after the compile
 * step produced dist-bin artifacts:
 *
 *   node --test scripts/footprint-gates.test.mjs
 *
 * Peak RSS is polled via `ps -o rss=` (KB, both macOS and Linux) at a 10 ms
 * interval while the process runs; polling can miss sub-10ms spikes, so the
 * limits carry headroom over the 2026-09-29 baselines (CLI one-shot 47 MB,
 * MCP bridge idle 44 MB). Limits are named here and in the T8 packet.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const CLI_BIN = `${root}packages/cli/dist-bin/agentbrowser`;
const MCP_BIN = `${root}packages/mcp-server/dist-bin/agentbrowser-mcp`;

/** Explicit named limits (MB). Tighten only with a recorded reason; loosen
 * only with a measured regression named in the commit.
 */
const LIMITS = { cliOneShot: 120, mcpBridgeIdle: 120 };

const rssKb = (pid) => {
  try {
    const out = execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' });
    const kb = Number(out.trim());
    return Number.isFinite(kb) ? kb : 0;
  } catch {
    return 0; // process gone
  }
};

/** Poll peak RSS while `run` drives the process; returns max MB observed. */
async function peakRssMb(child, run) {
  let peakKb = 0;
  let stopped = false;
  const poll = (async () => {
    while (!stopped) {
      peakKb = Math.max(peakKb, rssKb(child.pid));
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  })();
  try {
    await run();
  } finally {
    stopped = true;
    await poll.catch(() => {});
  }
  return Math.round((peakKb / 1024) * 10) / 10;
}

test('shipped artifacts exist after compile', () => {
  assert.ok(existsSync(CLI_BIN), 'CLI dist-bin missing: run packages/cli/scripts/compile.mjs');
  assert.ok(
    existsSync(MCP_BIN),
    'MCP dist-bin missing: run packages/mcp-server/scripts/compile.mjs'
  );
});

test('CLI one-shot peak RSS stays within the gate', async () => {
  const child = spawn(CLI_BIN, ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] });
  const peak = await peakRssMb(child, () => new Promise((resolve) => child.on('close', resolve)));
  assert.ok(peak > 0, 'no RSS sample collected');
  console.log(`footprint: CLI one-shot peak RSS ${peak} MB (gate ${LIMITS.cliOneShot})`);
  assert.ok(
    peak <= LIMITS.cliOneShot,
    `CLI one-shot peak RSS ${peak} MB exceeds the ${LIMITS.cliOneShot} MB gate`
  );
});

test('MCP bridge idle peak RSS stays within the gate after handshake', async () => {
  const child = spawn(MCP_BIN, [], { stdio: ['pipe', 'pipe', 'pipe'] });
  let sequence = 0;
  const request = (method, params) =>
    new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => reject(new Error('MCP handshake timeout')), 15_000);
      const onLine = (chunk) => {
        buffered += chunk.toString();
        let newline;
        while ((newline = buffered.indexOf('\n')) !== -1) {
          const lineText = buffered.slice(0, newline);
          buffered = buffered.slice(newline + 1);
          try {
            const message = JSON.parse(lineText);
            if (message.id === id) {
              clearTimeout(timer);
              resolve(message);
              return;
            }
          } catch {
            /* notifications */
          }
        }
      };
      child.stdout.on('data', onLine);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  let buffered = '';
  try {
    await request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'footprint-gate', version: '1.0.0' },
    });
    await request('notifications/initialized', {});
    await request('tools/list', {});
    // Hold the bridge live while the sampler catches the settled RSS.
    const peak = await peakRssMb(child, () => new Promise((resolve) => setTimeout(resolve, 700)));
    assert.ok(peak > 0, 'no RSS sample collected');
    console.log(`footprint: MCP bridge idle peak RSS ${peak} MB (gate ${LIMITS.mcpBridgeIdle})`);
    assert.ok(
      peak <= LIMITS.mcpBridgeIdle,
      `MCP bridge idle peak RSS ${peak} MB exceeds the ${LIMITS.mcpBridgeIdle} MB gate`
    );
  } finally {
    child.kill();
  }
});
