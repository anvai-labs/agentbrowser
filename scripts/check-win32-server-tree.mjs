#!/usr/bin/env node
/**
 * Check a packaged win32-x64 server tree (agentbrowser-server-win32-x64.zip)
 * the way a Windows user would get it: extracted into a fresh directory
 * OUTSIDE the checkout — v1.17.0's Windows server only "worked" in CI because
 * it ran inside the build checkout, where its baked-in paths existed.
 *
 *   node scripts/check-win32-server-tree.mjs --zip <file> --expected-version <v>
 *        [--expected-commit <sha>] [--allow-dirty]
 *
 * Proves: Windows-extractable (no links/junctions), complete dependency
 * closure (the extracted-package audit), `--version`, and a real server start
 * that answers /health and stops cleanly through the stdin lifeline. With
 * --session it also launches Chromium (PLAYWRIGHT_BROWSERS_PATH must hold the
 * revision the packaged Playwright pins): create a session and page, observe
 * the blank page, close — no network access needed.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { resolvePackagedModules } from './package-acceptance.mjs';
import { runExecutable } from './release-smoke.mjs';

/** Every link or junction under `dir` (Node reports junctions as symlinks). */
export async function findLinks(dir, prefix = '') {
  const links = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) links.push(rel);
    else if (entry.isDirectory()) links.push(...(await findLinks(join(dir, entry.name), rel)));
  }
  return links;
}

export function extractCommand(
  zip,
  destination,
  { platform = process.platform, env = process.env } = {}
) {
  if (platform === 'win32') {
    return [
      join(env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe'),
      '-x',
      '-f',
      zip,
      '-C',
      destination,
    ];
  }
  return ['unzip', '-q', zip, '-d', destination];
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

async function exerciseSession(base) {
  const call = async (method, path, body) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });
    const text = await response.text();
    assert.ok(response.ok, `${method} ${path} failed (${response.status}): ${text.slice(0, 500)}`);
    return text ? JSON.parse(text) : undefined;
  };
  const session = await call('POST', '/v1/sessions', { tenantId: 'win32-tree-check' });
  try {
    assert.equal(session.engine?.name, 'playwright-chromium', 'Expected a real Chromium session');
    const page = await call('POST', `/v1/sessions/${session.sessionId}/pages`, {});
    const observed = await call(
      'POST',
      `/v1/sessions/${session.sessionId}/pages/${page.pageId}/observe`,
      {}
    );
    assert.ok(Array.isArray(observed.elements), 'Observation lacked elements');
  } finally {
    await call('DELETE', `/v1/sessions/${session.sessionId}`);
  }
  return 'PASS';
}

async function startAndProbe(server, expectedVersion, { session = false } = {}) {
  const port = await freePort();
  const child = spawn(process.execPath, [join(server, 'dist', 'bin.js')], {
    cwd: server,
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(port),
      AGENTBROWSER_SHUTDOWN_ON_STDIN_EOF: '1',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += chunk;
  });
  child.stderr.on('data', (chunk) => {
    output += chunk;
  });
  const exited = new Promise((resolveExit) => child.once('exit', (code) => resolveExit(code)));
  try {
    const deadline = Date.now() + 60_000;
    let health;
    while (Date.now() < deadline && child.exitCode === null) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/health`, {
          signal: AbortSignal.timeout(2_000),
        });
        if (response.ok) {
          health = await response.json();
          break;
        }
      } catch {
        /* not listening yet */
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    assert.ok(health, `Packaged server never answered /health:\n${output.slice(-2000)}`);
    assert.equal(health.version, expectedVersion, 'Packaged server reported the wrong version');
    const sessionResult = session ? await exerciseSession(`http://127.0.0.1:${port}`) : undefined;
    child.stdin.end();
    const code = await Promise.race([
      exited,
      new Promise((r) => setTimeout(() => r('timeout'), 30_000)),
    ]);
    assert.equal(
      code,
      0,
      `Packaged server did not stop cleanly on stdin EOF (${code}):\n${output.slice(-2000)}`
    );
    return { health, session: sessionResult };
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
}

export async function checkWin32ServerTree({
  zip,
  expectedVersion,
  expectedCommit,
  allowDirty = false,
  session = false,
  run = runExecutable,
}) {
  assert.ok(zip, '--zip is required');
  assert.ok(expectedVersion, '--expected-version is required');
  const work = await mkdtemp(join(tmpdir(), 'agentbrowser-win32-check-'));
  try {
    await run(extractCommand(resolve(zip), work), { timeoutMs: 300_000 });
    const server = join(work, 'server');
    const links = await findLinks(server);
    assert.deepEqual(
      links,
      [],
      `Windows tree contains links/junctions: ${links.slice(0, 5).join(', ')}`
    );
    const modules = await resolvePackagedModules(server, expectedVersion, {
      expectedCommit,
      allowDirty,
    });
    const version = (
      await run([process.execPath, join(server, 'dist', 'bin.js'), '--version'])
    ).stdout.trim();
    assert.equal(version, expectedVersion, 'Packaged --version mismatch');
    const probe = await startAndProbe(server, expectedVersion, { session });
    return {
      server: 'PASS',
      version,
      commit: modules.commit,
      dirty: modules.dirty,
      health: probe.health.status,
      ...(probe.session ? { session: probe.session } : {}),
    };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const { values } = parseArgs({
      options: {
        zip: { type: 'string' },
        'expected-version': { type: 'string' },
        'expected-commit': { type: 'string' },
        'allow-dirty': { type: 'boolean', default: false },
        session: { type: 'boolean', default: false },
      },
    });
    const report = await checkWin32ServerTree({
      zip: values.zip,
      expectedVersion: values['expected-version'],
      expectedCommit: values['expected-commit'],
      allowDirty: values['allow-dirty'],
      session: values.session,
    });
    console.log(JSON.stringify(report));
  } catch (error) {
    console.error(`win32 server tree: FAIL - ${error.message}`);
    process.exitCode = 1;
  }
}
