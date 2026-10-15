#!/usr/bin/env node
/** T8 footprint gates: the shipped single-file binaries must stay within
 * explicit peak-RSS bounds (T8 packet: "Compare isolated imports/install
 * sizes and RSS separately"). Run from the repo root after the compile
 * step produced dist-bin artifacts:
 *
 *   node --test scripts/footprint-gates.test.mjs
 *
 * The CLI one-shot peak is measured EXACTLY: the kernel's `ru_maxrss` for the reaped child
 * (wait4 rusage, via a python3 helper; KB on Linux, bytes on macOS), so a process that exits
 * within one sampling interval can neither escape the gate nor pass on an understated number.
 * Floor: on Linux, exec folds the parent's high-water mark into the child's ru_maxrss, so readings
 * never go below the helper's own ~10-12 MB (a max, not a sum; irrelevant at the 75 MB gate).
 * The MCP bridge's idle peak is polled every 10 ms while it idles after the handshake (current
 * RSS: `VmRSS` from /proc on Linux, `ps -o rss=` elsewhere); polling can miss sub-10ms spikes,
 * so the limits carry headroom. First tightening pass 2026-10-02 (120 -> 75 MB),
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

/** Linux: current RSS from /proc (a microsecond read, unlike forking `ps`). */
const procRssKb = (pid) => {
  try {
    const match = /^VmRSS:\s+(\d+) kB$/m.exec(readFileSync(`/proc/${pid}/status`, 'utf8'));
    return match ? Number(match[1]) : 0;
  } catch {
    return 0; // process gone
  }
};

const rssKb = (pid) => {
  if (process.platform === 'linux') return procRssKb(pid);
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

/** Exact peak RSS (MB) of a one-shot command: ru_maxrss of the reaped child (wait4 rusage). */
function exactPeakMb(command, args) {
  const out = execFileSync(
    'python3',
    [
      '-I',
      '-c',
      [
        'import resource, subprocess, sys',
        'code = subprocess.run(sys.argv[1:], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode',
        'print(code, resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss)',
      ].join('\n'),
      command,
      ...args,
    ],
    // A hung --version must fail the gate, not stall the job.
    { encoding: 'utf8', timeout: 30_000 }
  );
  const [code, maxrss] = out.trim().split(' ').map(Number);
  // ru_maxrss is KB on Linux and bytes on macOS.
  const kb = process.platform === 'darwin' ? maxrss / 1024 : maxrss;
  return { code, peak: Math.round((kb / 1024) * 10) / 10 };
}

test('CLI one-shot peak RSS stays within the gate', () => {
  const { code, peak } = exactPeakMb(CLI_BIN, ['--version']);
  assert.equal(code, 0, 'CLI --version must exit 0');
  assert.ok(peak > 0, 'no peak RSS reported');
  console.log(`footprint: CLI one-shot peak RSS ${peak} MB (gate ${LIMITS.cliOneShot})`);
  assert.ok(
    peak <= LIMITS.cliOneShot,
    `CLI one-shot peak RSS ${peak} MB exceeds the ${LIMITS.cliOneShot} MB gate`
  );
});

test('MCP bridge idle peak RSS stays within the gate after handshake', async () => {
  const child = spawn(MCP_BIN, [], { stdio: ['pipe', 'pipe', 'pipe'] });
  // One shared line reader: per-request listeners each appended every chunk to the shared
  // buffer, so a response spanning two pipe chunks (tools/list > 64 KiB) never parsed.
  let sequence = 0;
  let buffered = '';
  const pending = new Map();
  child.stdout.on('data', (chunk) => {
    buffered += chunk.toString();
    let newline;
    while ((newline = buffered.indexOf('\n')) !== -1) {
      const lineText = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      let message;
      try {
        message = JSON.parse(lineText);
      } catch {
        continue; // not a JSON-RPC line
      }
      const waiter = pending.get(message.id);
      if (waiter) {
        pending.delete(message.id);
        waiter(message);
      }
    }
  });
  const request = (method, params) =>
    new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error('MCP handshake timeout'));
      }, 15_000);
      pending.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
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
