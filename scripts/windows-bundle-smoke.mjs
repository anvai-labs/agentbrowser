#!/usr/bin/env node
/**
 * Clean-room smoke of the Windows bundle (agentbrowser-windows-x64.zip), run
 * the way a user gets it: extracted into a fresh directory with no checkout
 * and no node_modules anywhere on the path — v1.17.0's server exe passed CI
 * only because CI ran it inside the build checkout.
 *
 *   node scripts/windows-bundle-smoke.mjs --zip <bundle.zip> --expected-version <v>
 *        [--browsers <dir>]   use provisioned browsers (else first-start download)
 *
 * Builtins only. Proves, against the shipped executables:
 *   1. --version / --help on the server launcher, CLI and server rejection of
 *      unknown arguments (exit 2);
 *   2. the launcher starts the bundled server (provisioning Chromium on first
 *      start when no --browsers are given) and /health reports the version;
 *   3. a real Chromium session through agentbrowser-cli.exe;
 *   4. the MCP end-to-end test through agentbrowser-mcp.exe;
 *   5. killing the launcher outright (TerminateProcess) leaves no server or
 *      Chromium process behind (the stdin lifeline);
 *   6. a second --install-browser is a no-op;
 *   7. invoked through a symlink (as winget's Links directory does), the
 *      launcher still finds its bundle. Creating the link needs Developer
 *      Mode or elevation: --require-symlink (CI) makes that mandatory,
 *      otherwise it is reported as skipped.
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const SCRIPTS = fileURLToPath(new URL('./', import.meta.url));
const system32 = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');

function run(command, args, { env, expect = 0, timeout = 120_000 } = {}) {
  const result = spawnSync(command, args, { env, encoding: 'utf8', timeout, windowsHide: true });
  if (result.error) throw result.error;
  assert.equal(
    result.status,
    expect,
    `${command} ${args.join(' ')} exited ${result.status}:\n${(result.stderr || result.stdout).slice(-1500)}`
  );
  return result.stdout;
}

function json(stdout, label) {
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error(`${label} did not print JSON: ${stdout.slice(0, 500)}`);
  }
}

async function freePort() {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolvePort(port));
    });
  });
}

/**
 * Server and browser processes left from this bundle: anything executing from
 * the extracted bundle (launcher, bundled node.exe), plus Chromium processes
 * using its browsers directory. Matched by executable and process name, never
 * by a bare command-line substring, which would also match this harness.
 */
function survivors(dir, browsers) {
  const quote = (value) => value.replace(/'/g, "''");
  const script = [
    `Get-CimInstance Win32_Process | Where-Object {`,
    `  ($_.ExecutablePath -and $_.ExecutablePath.StartsWith('${quote(dir)}', 'OrdinalIgnoreCase')) -or`,
    `  (@('chrome.exe', 'chrome-headless-shell.exe') -contains $_.Name -and $_.CommandLine -and $_.CommandLine.Contains('${quote(browsers)}'))`,
    `} | ForEach-Object { "$($_.ProcessId) $($_.Name)" }`,
  ].join(' ');
  const out = run(join(system32, 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoProfile', '-Command', script]);
  return out.split(/\r?\n/).filter(Boolean);
}

async function waitFor(check, label, ms) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

export async function smokeWindowsBundle({ zip, expectedVersion, browsers: provisioned, requireSymlink = false }) {
  assert.equal(process.platform, 'win32', 'the Windows bundle smoke runs on Windows');
  // The real long-form path: hosted runners set TEMP to an 8.3 short name
  // (C:\Users\RUNNER~1\…) while the launcher runs the server from its
  // resolved real path, so a short-form prefix never matched the server's
  // node.exe and the kill check silently skipped it.
  const work = realpathSync.native(await mkdtemp(join(tmpdir(), 'ab-bundle-smoke-')));
  const report = {};
  let launcher;
  try {
    const dir = join(work, 'AgentBrowser');
    run(join(system32, 'cmd.exe'), ['/d', '/c', 'mkdir', dir]);
    run(join(system32, 'tar.exe'), ['-x', '-f', resolve(zip), '-C', dir]);
    const exe = (name) => join(dir, `agentbrowser-${name}.exe`);
    const browsers = provisioned ? resolve(provisioned) : join(work, 'browsers');
    const env = { ...process.env, PLAYWRIGHT_BROWSERS_PATH: browsers };
    delete env.AGENTBROWSER_HOME;

    // 1. Fast paths and argument handling: no engine, no network.
    assert.equal(run(exe('server'), ['--version'], { env }).trim(), expectedVersion);
    assert.match(run(exe('server'), ['--help'], { env }), /--install-browser/);
    run(exe('server'), ['--port', '1'], { env, expect: 2 });
    assert.match(run(exe('cli'), ['--version'], { env }), new RegExp(expectedVersion.replace(/\./g, '\\.')));
    report.fastPaths = 'PASS';

    // 2. Start through the launcher; first start provisions Chromium.
    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    let log = '';
    launcher = spawn(exe('server'), [], {
      env: { ...env, HOST: '127.0.0.1', PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    launcher.stdout.on('data', (chunk) => { log += chunk; });
    launcher.stderr.on('data', (chunk) => { log += chunk; });
    const health = await waitFor(async () => {
      if (launcher.exitCode !== null) throw new Error(`launcher exited ${launcher.exitCode}:\n${log.slice(-2000)}`);
      try {
        const response = await fetch(`${base}/health`, { signal: AbortSignal.timeout(2_000) });
        return response.ok ? response.json() : undefined;
      } catch {
        return undefined;
      }
    }, 'the bundled server to become healthy', 15 * 60_000);
    assert.equal(health.version, expectedVersion);
    report.firstStart = provisioned ? 'PASS (provisioned browsers)' : `PASS (downloaded: ${/First start/.test(log)})`;

    // 3. A real Chromium session through the shipped CLI.
    const cli = (...args) => json(run(exe('cli'), ['--base-url', base, '--json', ...args], { env }), args[0]);
    const session = cli('session', 'create', '--tenant', 'bundle-smoke');
    assert.ok(session.sessionId, 'CLI session create returned no sessionId');
    const page = cli('page', 'create', session.sessionId);
    assert.ok(page.pageId, 'CLI page create returned no pageId');
    const observed = cli('observe', session.sessionId, page.pageId);
    assert.ok(Array.isArray(observed.elements), 'CLI observe returned no elements array');
    run(exe('cli'), ['--base-url', base, '--json', 'session', 'close', session.sessionId], { env });
    report.cliSession = 'PASS';

    // 4. MCP end-to-end through the shipped MCP executable.
    run(process.execPath, ['--test', join(SCRIPTS, 'windows-mcp-e2e.test.mjs')], {
      env: {
        ...env, AGENTBROWSER_BASE_URL: base, AGENTBROWSER_E2E_MCP_COMMAND: exe('mcp'),
        AGENTBROWSER_E2E_EXPECTED_VERSION: expectedVersion, AGENTBROWSER_TEST_HEADLESS: '1',
      },
      timeout: 300_000,
    });
    report.mcp = 'PASS';

    // 5. Kill the launcher outright while a browser is running.
    const live = cli('session', 'create', '--tenant', 'bundle-smoke');
    cli('page', 'create', live.sessionId);
    const before = survivors(dir, browsers);
    // Name what must be there, not just how many: the bundled server's
    // node.exe and at least one Chromium process.
    assert.ok(before.some((p) => / node\.exe$/i.test(p)), `server node.exe not seen before the kill: ${before.join(', ')}`);
    assert.ok(before.some((p) => /chrome(-headless-shell)?\.exe$/i.test(p)), `Chromium not seen before the kill: ${before.join(', ')}`);
    run(join(system32, 'taskkill.exe'), ['/F', '/PID', String(launcher.pid)]);
    const after = await waitFor(() => (survivors(dir, browsers).length === 0 ? [] : undefined), 'server and Chromium to exit after the launcher was killed', 30_000)
      .catch((error) => { throw new Error(`${error.message}: ${survivors(dir, browsers).join(', ')}`); });
    report.killCleanup = `PASS (${before.length} processes before, ${after.length} after)`;

    // 6. Provisioning again is a no-op.
    run(exe('server'), ['--install-browser'], { env, timeout: 300_000 });
    report.reinstall = 'PASS';

    // 7. Through a symlink elsewhere: --install-browser resolves the install
    // root (realpath of the executable) and checks the server version.
    const link = join(work, 'Links', 'agentbrowser-server.exe');
    run(join(system32, 'cmd.exe'), ['/d', '/c', 'mkdir', join(work, 'Links')]);
    try {
      await symlink(exe('server'), link, 'file');
    } catch (error) {
      if (requireSymlink || error.code !== 'EPERM') throw error;
    }
    if (existsSync(link)) {
      run(link, ['--install-browser'], { env, timeout: 300_000 });
      report.symlink = 'PASS';
    } else {
      report.symlink = 'SKIPPED (no symlink privilege)';
    }
    return { bundleSmoke: 'PASS', version: expectedVersion, ...report };
  } finally {
    if (launcher && launcher.exitCode === null) launcher.kill();
    await rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 1000 });
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const { values } = parseArgs({ options: {
      zip: { type: 'string' }, 'expected-version': { type: 'string' }, browsers: { type: 'string' },
      'require-symlink': { type: 'boolean', default: false },
    } });
    assert.ok(values.zip && values['expected-version'], '--zip and --expected-version are required');
    console.log(JSON.stringify(await smokeWindowsBundle({
      zip: values.zip, expectedVersion: values['expected-version'], browsers: values.browsers,
      requireSymlink: values['require-symlink'],
    })));
  } catch (error) {
    console.error(`windows bundle smoke: FAIL - ${error.message}`);
    process.exitCode = 1;
  }
}
