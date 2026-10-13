#!/usr/bin/env node
/**
 * `agentbrowser-server.exe` in the Windows bundle (see core.ts for layout and
 * the reasons it stays builtins-only). It resolves the install root, checks
 * the server tree's version, provisions Chromium on first start, then runs
 * the server on the bundled Node and supervises it:
 *
 * - the server's stdin is a lifeline pipe: closing it stops the server
 *   cleanly, and if this launcher is killed outright (Windows
 *   TerminateProcess) the OS closes it, so Chromium is never orphaned;
 * - the first stop signal closes the lifeline, a second kills the server;
 * - with AGENTBROWSER_SHUTDOWN_ON_STDIN_EOF=1, EOF on the launcher's own
 *   stdin stops it the same way (a supervisor's lifeline on Windows);
 * - the server's exit code becomes the launcher's.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { PRODUCT_VERSION } from '../product-version.js';
import {
  browsersPath,
  LAUNCHER_HELP,
  type LauncherFs,
  missingBrowsers,
  nodeExecutable,
  parseLauncherArgs,
  playwrightCli,
  resolveInstallRoot,
  serverEntry,
  serverEnvironment,
  verifyServerVersion,
} from './core.js';

const fs: LauncherFs = {
  exists: existsSync,
  readText: (path) => readFileSync(path, 'utf8'),
  realpath: (path) => realpathSync(path),
};

function fail(message: string, code = 1): never {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

/** `playwright install chromium` on the bundled Node; returns its exit code. */
function installChromium(node: string, server: string, env: NodeJS.ProcessEnv): number {
  const result = spawnSync(node, [playwrightCli(server), 'install', 'chromium'], {
    cwd: server,
    env,
    // Progress to stderr: stdout belongs to the server's log stream.
    stdio: ['ignore', process.stderr, process.stderr],
    windowsHide: true,
  });
  if (result.error) {
    process.stderr.write(
      `agentbrowser-server: could not run the browser installer: ${result.error.message}\n`
    );
    return 1;
  }
  return result.status ?? 1;
}

const args = parseLauncherArgs(process.argv.slice(2));
if (args.kind === 'help') {
  process.stdout.write(LAUNCHER_HELP);
  process.exit(0);
}
if (args.kind === 'version') {
  process.stdout.write(`${PRODUCT_VERSION}\n`);
  process.exit(0);
}
if (args.kind === 'error') fail(args.message, 2);

let root: string;
try {
  root = resolveInstallRoot({
    env: process.env,
    execPath: process.execPath,
    platform: process.platform,
    fs,
  });
  verifyServerVersion(root, PRODUCT_VERSION, fs);
} catch (error) {
  fail((error as Error).message);
}

const node = nodeExecutable(root, process.platform);
const server = join(root, 'server');
const browsers = browsersPath(process.env, process.platform, homedir(), server);
const env = serverEnvironment(process.env, browsers);

if (args.kind === 'install-browser') process.exit(installChromium(node, server, env));

if (process.env.AGENTBROWSER_SKIP_BROWSER_INSTALL !== '1') {
  const missing = missingBrowsers(server, browsers, fs);
  if (missing.length > 0) {
    process.stderr.write(
      `[agentbrowser] First start: downloading Chromium into ${browsers} (one time, roughly 300 MB)...\n`
    );
    const code = installChromium(node, server, env);
    if (code !== 0) {
      fail(
        `agentbrowser-server: the Chromium download failed (exit ${code}). Check network or proxy access (HTTPS_PROXY), then run agentbrowser-server --install-browser; or point PLAYWRIGHT_BROWSERS_PATH at an existing install and set AGENTBROWSER_SKIP_BROWSER_INSTALL=1.`
      );
    }
  }
}

const child = spawn(node, [serverEntry(root)], {
  cwd: server,
  env,
  stdio: ['pipe', 'inherit', 'inherit'],
  windowsHide: true,
});
// The lifeline is never written to; a server that already exited must not
// crash the launcher with EPIPE when the pipe is closed.
child.stdin?.on('error', () => undefined);
child.on('error', (error) =>
  fail(`agentbrowser-server: could not start ${node}: ${error.message}`)
);
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));

let signals = 0;
const stop = () => {
  signals += 1;
  if (signals === 1) child.stdin?.end();
  else child.kill();
};
const stopSignals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];
// Ctrl-Break / console close on Windows.
if (process.platform === 'win32') stopSignals.push('SIGBREAK');
for (const signal of stopSignals) process.on(signal, stop);

// A supervisor may hold *our* stdin as its lifeline too (Windows has no
// deliverable SIGTERM): with the same opt-in the server honours, EOF on the
// launcher's stdin stops the server gracefully, like a first signal. Opt-in
// only — a service manager starts us with an empty stdin.
if (process.env.AGENTBROWSER_SHUTDOWN_ON_STDIN_EOF === '1') {
  const onEof = () => {
    if (signals === 0) stop();
  };
  process.stdin.on('end', onEof);
  process.stdin.on('close', onEof);
  process.stdin.on('error', () => undefined);
  process.stdin.resume();
}
