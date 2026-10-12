import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PRODUCT_VERSION } from './product-version.js';

// Exercises the built entrypoint (CI builds before tests, as for the other
// dist-spawning suites) the way launchers, Docker and brew services run it.
const BIN = fileURLToPath(new URL('../dist/bin.js', import.meta.url));

let hookDir: string;
let noPlaywrightHook: string;

beforeAll(() => {
  hookDir = mkdtempSync(join(tmpdir(), 'ab-bin-entry-'));
  noPlaywrightHook = join(hookDir, 'no-playwright.mjs');
  // Any attempt to resolve a Playwright module fails the process loudly: the
  // --help/--version fast path must answer before the engine graph loads.
  writeFileSync(
    noPlaywrightHook,
    `import { registerHooks } from 'node:module';
registerHooks({
  resolve(specifier, context, next) {
    if (/(^|[\\\\/@])playwright|engine-playwright/.test(specifier)) {
      throw new Error('fast path loaded ' + specifier);
    }
    return next(specifier, context);
  },
});
`
  );
});

afterAll(() => {
  rmSync(hookDir, { recursive: true, force: true });
});

function runFastPath(args: string[]) {
  return spawnSync(
    process.execPath,
    ['--import', pathToFileURL(noPlaywrightHook).href, BIN, ...args],
    { encoding: 'utf8', timeout: 20_000 }
  );
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      probe.close(() =>
        typeof address === 'object' && address
          ? resolve(address.port)
          : reject(new Error('no port'))
      );
    });
  });
}

describe('server entrypoint arguments', () => {
  it('prints help without loading Playwright or listening', () => {
    const result = runFastPath(['--help']);
    expect(result.stderr).not.toContain('fast path loaded');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('agentbrowser-server');
    expect(result.stdout).toContain('AGENTBROWSER_API_KEYS');
  });

  it('prints the product version without loading Playwright', () => {
    const result = runFastPath(['--version']);
    expect(result.stderr).not.toContain('fast path loaded');
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(PRODUCT_VERSION);
  });

  it('exits 2 on an unknown argument instead of starting a server', () => {
    const result = runFastPath(['--port', '9000']);
    expect(result.stderr).not.toContain('fast path loaded');
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("unknown argument '--port'");
  });
});

describe('server shutdown on stdin EOF (launcher lifeline)', () => {
  it('stops cleanly with exit 0 when opted in and stdin closes', async () => {
    const port = await freePort();
    const child = spawn(process.execPath, [BIN], {
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
    const exited = new Promise<number | null>((resolve) => child.once('exit', resolve));

    const deadline = Date.now() + 20_000;
    while (!output.includes('Server listening') && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(output).toContain('Server listening');

    child.stdin.end();
    const code = await Promise.race([
      exited,
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 15_000)),
    ]);
    if (code === 'timeout') child.kill('SIGKILL');
    expect(code).toBe(0);
  }, 45_000);
});
