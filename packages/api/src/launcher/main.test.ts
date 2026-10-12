import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PRODUCT_VERSION } from '../product-version.js';

// Exercises the built launcher (CI builds before tests) against a fake bundle:
// a node symlink, a fake server recording its environment and stdin EOF, and
// a fake Playwright CLI recording install calls.
const LAUNCHER = fileURLToPath(new URL('../../dist/launcher/main.js', import.meta.url));
const posix = process.platform !== 'win32';

let root: string;
let browsers: string;

function layout({ version = PRODUCT_VERSION, installExit = 0 } = {}) {
  mkdirSync(join(root, 'node', 'bin'), { recursive: true });
  symlinkSync(process.execPath, join(root, 'node', 'bin', 'node'));
  mkdirSync(join(root, 'server', 'dist'), { recursive: true });
  writeFileSync(join(root, 'server', 'VERSION.json'), JSON.stringify({ version }));
  writeFileSync(
    join(root, 'server', 'dist', 'bin.js'),
    `const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(join(root, 'server-env.json'))}, JSON.stringify({ cwd: process.cwd(), env: process.env }));
process.stdout.write('fake-server ready\\n');
process.stdin.on('end', () => { fs.writeFileSync(${JSON.stringify(join(root, 'server-eof'))}, ''); process.exit(0); });
process.stdin.resume();
`
  );
  const core = join(root, 'server', 'node_modules', 'playwright-core');
  mkdirSync(core, { recursive: true });
  writeFileSync(
    join(core, 'browsers.json'),
    JSON.stringify({
      browsers: [
        { name: 'chromium', revision: '1234' },
        { name: 'chromium-headless-shell', revision: '1234' },
      ],
    })
  );
  const cli = join(root, 'server', 'node_modules', 'playwright');
  mkdirSync(cli, { recursive: true });
  writeFileSync(
    join(cli, 'cli.js'),
    `const fs = require('node:fs'); const path = require('node:path');
fs.appendFileSync(${JSON.stringify(join(root, 'install-calls'))}, process.argv.slice(2).join(' ') + ' -> ' + process.env.PLAYWRIGHT_BROWSERS_PATH + '\\n');
if (${installExit} !== 0) process.exit(${installExit});
for (const d of ['chromium-1234', 'chromium_headless_shell-1234']) {
  fs.mkdirSync(path.join(process.env.PLAYWRIGHT_BROWSERS_PATH, d), { recursive: true });
  fs.writeFileSync(path.join(process.env.PLAYWRIGHT_BROWSERS_PATH, d, 'INSTALLATION_COMPLETE'), '');
}
`
  );
}

function launcherEnv(extra: Record<string, string> = {}) {
  return { ...process.env, AGENTBROWSER_HOME: root, PLAYWRIGHT_BROWSERS_PATH: browsers, ...extra };
}

async function waitFor(predicate: () => boolean, label: string, ms = 15_000) {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function exitOf(child: ChildProcess) {
  return new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ab-launcher-'));
  browsers = join(root, 'browsers');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe.runIf(posix)('launcher process', () => {
  it('answers --version and --help without any installation', () => {
    const version = spawnSync(process.execPath, [LAUNCHER, '--version'], {
      encoding: 'utf8',
      env: { ...process.env, AGENTBROWSER_HOME: root },
    });
    expect(version.status).toBe(0);
    expect(version.stdout.trim()).toBe(PRODUCT_VERSION);
    const help = spawnSync(process.execPath, [LAUNCHER, '--help'], { encoding: 'utf8' });
    expect(help.status).toBe(0);
    expect(help.stdout).toContain('--install-browser');
    expect(help.stdout).toContain('AGENTBROWSER_SKIP_BROWSER_INSTALL');
  });

  it('refuses unknown arguments with exit 2', () => {
    const result = spawnSync(process.execPath, [LAUNCHER, '--port', '1'], { encoding: 'utf8' });
    expect(result.status).toBe(2);
  });

  it('fails with the searched locations when the bundle is incomplete', () => {
    const result = spawnSync(process.execPath, [LAUNCHER], {
      encoding: 'utf8',
      env: launcherEnv(),
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(root);
    expect(result.stderr).toMatch(/incomplete installation/);
  });

  it('refuses a server tree from another version', () => {
    layout({ version: '0.0.1' });
    const result = spawnSync(process.execPath, [LAUNCHER], {
      encoding: 'utf8',
      env: launcherEnv(),
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/does not match server 0\.0\.1/);
    expect(existsSync(join(root, 'server-env.json'))).toBe(false);
  });

  it('downloads Chromium on first start, then runs the server with the lifeline, and stops it on a signal', async () => {
    layout();
    const child = spawn(process.execPath, [LAUNCHER], {
      env: launcherEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr?.on('data', (chunk) => {
      stderr += chunk;
    });
    const exited = exitOf(child);
    try {
      await waitFor(() => existsSync(join(root, 'server-env.json')), 'server start');
      expect(readFileSync(join(root, 'install-calls'), 'utf8')).toBe(
        `install chromium -> ${browsers}\n`
      );
      expect(stderr).toMatch(/First start: downloading Chromium/);
      const { cwd, env } = JSON.parse(readFileSync(join(root, 'server-env.json'), 'utf8'));
      expect(cwd).toBe(join(root, 'server'));
      expect(env.PLAYWRIGHT_BROWSERS_PATH).toBe(browsers);
      expect(env.AGENTBROWSER_SHUTDOWN_ON_STDIN_EOF).toBe('1');
      child.kill('SIGTERM');
      expect(await exited).toBe(0);
      expect(existsSync(join(root, 'server-eof'))).toBe(true);
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL');
    }
  }, 30_000);

  it('skips the download when Chromium is installed or the operator opts out', async () => {
    layout();
    for (const dir of ['chromium-1234', 'chromium_headless_shell-1234']) {
      mkdirSync(join(browsers, dir), { recursive: true });
      writeFileSync(join(browsers, dir, 'INSTALLATION_COMPLETE'), '');
    }
    for (const extra of [
      {},
      { AGENTBROWSER_SKIP_BROWSER_INSTALL: '1', PLAYWRIGHT_BROWSERS_PATH: join(root, 'empty') },
    ]) {
      rmSync(join(root, 'server-env.json'), { force: true });
      const child = spawn(process.execPath, [LAUNCHER], {
        env: launcherEnv(extra),
        stdio: 'ignore',
      });
      const exited = exitOf(child);
      try {
        await waitFor(() => existsSync(join(root, 'server-env.json')), 'server start');
        child.kill('SIGTERM');
        expect(await exited).toBe(0);
      } finally {
        if (child.exitCode === null) child.kill('SIGKILL');
      }
    }
    expect(existsSync(join(root, 'install-calls'))).toBe(false);
  }, 30_000);

  it('fails closed, without starting the server, when the download fails', () => {
    layout({ installExit: 3 });
    const result = spawnSync(process.execPath, [LAUNCHER], {
      encoding: 'utf8',
      env: launcherEnv(),
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/Chromium download failed \(exit 3\)[\s\S]*--install-browser/);
    expect(existsSync(join(root, 'server-env.json'))).toBe(false);
  });

  it('--install-browser provisions and exits with the installer status', () => {
    layout();
    const result = spawnSync(process.execPath, [LAUNCHER, '--install-browser'], {
      encoding: 'utf8',
      env: launcherEnv(),
    });
    expect(result.status).toBe(0);
    expect(existsSync(join(browsers, 'chromium-1234', 'INSTALLATION_COMPLETE'))).toBe(true);
    expect(existsSync(join(root, 'server-env.json'))).toBe(false);
  });

  it('a killed launcher still stops the server: the OS closes the lifeline', async () => {
    layout();
    const child = spawn(process.execPath, [LAUNCHER], {
      env: launcherEnv({ AGENTBROWSER_SKIP_BROWSER_INSTALL: '1' }),
      stdio: 'ignore',
    });
    const exited = exitOf(child);
    await waitFor(() => existsSync(join(root, 'server-env.json')), 'server start');
    child.kill('SIGKILL');
    await exited;
    await waitFor(() => existsSync(join(root, 'server-eof')), 'server to see stdin EOF');
  }, 30_000);
});
