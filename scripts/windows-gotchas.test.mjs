// windows-gotchas.test.mjs — TD-BROWSER Windows compatibility gates.
//
// These tests encode the real-world failure modes observed driving
// agentbrowser from WSL/bash parents and npm-shim installs on Windows
// (2026-10-04, aiserver1 WSL2 bring-up + GitHub windows runners):
//
//   G1  MCP stdio handshake works on win32 (core spawn + protocol).
//   G2  .cmd shims (what npm installs into %APPDATA%\npm) launch correctly
//       when invoked through cmd.exe /c — the exact pattern a WSL parent or
//       a .bat wrapper must use. Bash CANNOT exec .cmd directly (it parses
//       the batch file as shell and dies on quotes).
//   G3  Paths containing spaces ("C:\Program Files\...") survive spawning
//       and cwd propagation.
//   G4  UNC working directories (\\wsl.localhost\... from an interop parent)
//       do not break the server when one is available to test against.
//   G5  PowerShell relay (powershell.exe -Command launching node) works —
//       the documented interop drive pattern.
//   G6  A usable browser exists for engine detection: system Chrome in one
//       of the two Program Files locations, or PLAYWRIGHT_BROWSERS_PATH.
//
// Runs under `node --test`. Skips (not fails) on non-Windows platforms so
// the same test list can run anywhere; windows-ci.yml is where it gates.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const IS_WIN = process.platform === 'win32';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MCP_BIN = join(ROOT, 'packages', 'mcp-server', 'dist', 'bin.js');
const NODE = process.execPath;

// Minimal MCP client: send `initialize`, resolve with the first JSON object
// the server writes that carries a result/serverInfo. MCP stdio is
// newline-delimited JSON-RPC. Fails after `timeoutMs`.
function mcpHandshake(args, { timeoutMs = 20000, cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(NODE, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`handshake timeout; stdout=${out.slice(0, 400)} stderr=${err.slice(0, 400)}`));
    }, timeoutMs);
    child.stdout.on('data', (d) => {
      out += d;
      for (const line of out.split(/\r?\n/)) {
        if (!line.trim().startsWith('{')) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.result?.serverInfo || msg.result?.capabilities) {
            clearTimeout(timer);
            child.kill();
            resolve(msg);
          }
        } catch { /* partial line — keep buffering */ }
      }
    });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.stdin.write(JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: {
        protocolVersion: '2024-11-05', capabilities: {},
        clientInfo: { name: 'win-gotcha-smoke', version: '0.0.0' },
      },
    }) + '\n');
  });
}

test('G1: MCP stdio handshake on win32', { skip: !IS_WIN && 'windows-only' }, async () => {
  assert.ok(existsSync(MCP_BIN), `built MCP entry missing: ${MCP_BIN} — run pnpm -r build first`);
  const msg = await mcpHandshake([MCP_BIN]);
  assert.ok(msg.result?.serverInfo, 'initialize result must carry serverInfo');
});

test('G2: .cmd shim launches via cmd.exe /c (WSL/npm-parent pattern)', { skip: !IS_WIN && 'windows-only' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'ab-shim-'));
  const target = join(dir, 'target.js');
  // What the target script proves: env + argv propagation through the two
  // exec layers (cmd.exe -> node), and that the shim resolves %~dp0 paths.
  writeFileSync(target, `console.log(JSON.stringify({argv: process.argv.slice(1), marker: process.env.AB_GOTCHA}))\n`);
  // Shape mirrors npm's generated shims (npm.cmd): %~dp0-relative node call.
  const shim = join(dir, 'agentbrowser-fake.cmd');
  writeFileSync(shim, `@ECHO off\r\n"${NODE.replace(/"/g, '')}" "%~dp0target.js" %*\r\n`);
  try {
    // /s: strip only the outermost quote pair — cmd.exe's /c parsing is
    // quote-ambiguous without it. windowsVerbatimArguments stops Node from
    // double-escaping the quotes we need cmd.exe to see.
    const r = spawnSync('cmd.exe', ['/d', '/s', '/c', `"${shim}" arg-one`], {
      encoding: 'utf8', timeout: 20000,
      env: { ...process.env, AB_GOTCHA: 'via-cmd' },
      windowsVerbatimArguments: true,
    });
    assert.equal(r.status, 0, `shim exit=${r.status} stderr=${r.stderr}`);
    const payload = JSON.parse(r.stdout.trim().split(/\r?\n/).find((l) => l.startsWith('{')));
    assert.equal(payload.marker, 'via-cmd', 'env must survive the cmd relay');
    assert.equal(payload.argv[0], 'arg-one', 'argv must survive the cmd relay');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('G3: cwd with spaces does not break spawn', { skip: !IS_WIN && 'windows-only' }, async () => {
  const spaced = join(tmpdir(), 'Program Files Like Dir');
  mkdirSync(spaced, { recursive: true });
  const dir = mkdtempSync(join(spaced, 'ab-'));
  writeFileSync(join(dir, 'noop.js'), 'process.exit(0)\n');
  const r = spawnSync(NODE, [join(dir, 'noop.js')], { cwd: dir, encoding: 'utf8', timeout: 15000 });
  assert.equal(r.status, 0, `spaced-cwd spawn failed: ${r.stderr}`);
  rmSync(spaced, { recursive: true, force: true });
});

test('G4: UNC working directory tolerated', { skip: !IS_WIN && 'windows-only' }, async (t) => {
  // Admin shares are the only easily-provisioned UNC path on a runner.
  // Without \\localhost\c$ (non-admin box) there is nothing honest to
  // assert: skip via the test context so the run reports a real skip,
  // not a silent pass. The gotcha under test: an interop parent hands
  // the server a UNC cwd and the server must still answer initialize.
  const UNC_TMP = String.raw`\\localhost\c$\Windows\Temp`;
  if (!existsSync('//localhost/c$/Windows/Temp')) {
    t.skip('no \\\\localhost\\c$ admin share available to stage a UNC cwd');
    return;
  }
  const msg = await mcpHandshake([MCP_BIN], { cwd: UNC_TMP });
  assert.ok(msg.result?.serverInfo, 'server must answer initialize under a UNC cwd');
});

test('G5: PowerShell relay (interop drive pattern)', { skip: !IS_WIN && 'windows-only' }, (t) => {
  const ps = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  if (!existsSync(ps)) {
    t.skip('powershell.exe not present (stripped image)');
    return;
  }
  const r = spawnSync(ps, ['-NoProfile', '-Command',
    `& '${NODE.replace(/'/g, "''")}' -e "console.log('ps-relay-ok')"`],
    { encoding: 'utf8', timeout: 25000 });
  assert.ok(r.stdout.includes('ps-relay-ok'), `ps relay failed: ${r.stderr}`);
});

test('G6: browser present for engine detection (Chrome or Playwright path)', { skip: !IS_WIN && 'windows-only' }, () => {
  const chromeCandidates = [
    join(process.env.ProgramFiles || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ];
  const hasChrome = chromeCandidates.some(existsSync);
  const hasPwBrowsers = !!process.env.PLAYWRIGHT_BROWSERS_PATH;
  // CI installs Chromium into PLAYWRIGHT_BROWSERS_PATH; end-user machines
  // rely on system Chrome. Either is sufficient; neither is a build bug,
  // so this gates with a clear message rather than skipping silently.
  assert.ok(hasChrome || hasPwBrowsers,
    'no system Chrome and no PLAYWRIGHT_BROWSERS_PATH — engine detection would find no browser');
});
