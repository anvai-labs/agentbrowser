#!/usr/bin/env node
/** T8 footprint gates: the shipped single-file binaries must stay within
 * explicit peak-RSS bounds (T8 packet: "Compare isolated imports/install
 * sizes and RSS separately"). Run from the repo root after the compile
 * step produced dist-bin artifacts:
 *
 *   node --test scripts/footprint-gates.test.mjs
 *
 * Peak RSS is sampled at a 10 ms interval while the process runs: on Linux from the
 * kernel's high-water mark (`VmHWM` in /proc/<pid>/status, so no spike is missed), elsewhere
 * via `ps -o rss=` (KB), which can miss sub-10ms spikes, so the limits carry headroom. First tightening pass 2026-10-02 (120 -> 75 MB),
 * once Linux CI numbers existed: across 7 linux-x64 CI samples that day
 * (bun 1.4.0 pinned) the CLI one-shot (`--version`) spanned 37.4-51.9 MB
 * and the idle bridge 47.4-52.0 MB — worst observed 51.9/52.0, so 75 MB
 * is a 1.44x gate. The CLI's ~39% run-to-run spread means the gate is a
 * tripwire for gross regressions (tens of MB), not a precision
 * instrument; darwin-arm64 reads lower (recent samples: CLI one-shot
 * 26.8-43.5 MB, idle bridge 37.7-44.5 MB). Limits are named
 * here and in the T8 packet.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const CLI_BIN = `${root}packages/cli/dist-bin/agentbrowser`;
const MCP_BIN = `${root}packages/mcp-server/dist-bin/agentbrowser-mcp`;

/** Explicit named limits (MB). Tighten only with a recorded reason; loosen
 * only with a measured regression named in the commit.
 */
const LIMITS = { cliOneShot: 75, mcpBridgeIdle: 75 };

/** Linux: the kernel's peak-RSS high-water mark (VmHWM, kB) — a microsecond read that reports
 * the true peak so far, so a short-lived process cannot slip between samples. */
const hwmKb = (pid) => {
  try {
    const match = /^VmHWM:\s+(\d+) kB$/m.exec(readFileSync(`/proc/${pid}/status`, 'utf8'));
    return match ? Number(match[1]) : 0;
  } catch {
    return 0; // process gone
  }
};

const rssKb = (pid) => {
  if (process.platform === 'linux') return hwmKb(pid);
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
  // First sample as soon as the process exists, before the first timer tick.
  child.once('spawn', () => {
    peakKb = Math.max(peakKb, rssKb(child.pid));
  });
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
  // `--version` exits in well under 100 ms; a run in which no sample landed before exit is a
  // sampling miss, not a measurement, so it is retried (at most three runs).
  let peak = 0;
  for (let attempt = 0; attempt < 3 && peak === 0; attempt += 1) {
    const child = spawn(CLI_BIN, ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] });
    peak = await peakRssMb(child, () => new Promise((resolve) => child.on('close', resolve)));
  }
  assert.ok(peak > 0, 'no RSS sample collected in three runs');
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
