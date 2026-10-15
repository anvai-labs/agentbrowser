/**
 * Windows server launcher: decisions only (no process side effects), so each
 * one is unit-testable with an injected filesystem.
 *
 * The launcher is the `agentbrowser-server.exe` in the Windows bundle:
 *
 *   <root>/agentbrowser-server.exe   this launcher (Bun-compiled; no server code inside)
 *   <root>/node/node.exe             pinned official Node runtime
 *   <root>/server/                   the packaged server tree (hoisted, no links)
 *
 * It must stay free of everything but node: builtins. v1.17.0 shipped the
 * whole server as a Bun single-file exe; Bun froze Playwright's __dirname
 * lookups to the CI checkout, so the exe failed on every other machine. The
 * launcher therefore never derives a location from __dirname or import.meta,
 * only from the running executable (core.test.ts enforces both rules).
 */
import { dirname, join, posix, resolve, win32 } from 'node:path';
import { parseServerArgs, SERVER_HELP } from '../server-args.js';

export type LauncherArgs =
  | { kind: 'run' }
  | { kind: 'help' }
  | { kind: 'version' }
  | { kind: 'install-browser' }
  | { kind: 'policy-export' }
  | { kind: 'error'; message: string };

export const LAUNCHER_HELP = SERVER_HELP.replace(
  '  agentbrowser-server --version  print the version\n',
  `  agentbrowser-server --version  print the version
  agentbrowser-server --install-browser
                                 download Chromium now (otherwise done on first start)
`
).replace(
  '\nAll settings:',
  `
Windows bundle (this launcher):
  AGENTBROWSER_HOME                     install root holding node\\ and server\\ (default: next to this exe)
  AGENTBROWSER_SKIP_BROWSER_INSTALL     1 = never download Chromium on start
  PLAYWRIGHT_BROWSERS_PATH              default %LOCALAPPDATA%\\agentbrowser\\browsers

All settings:`
);

export function parseLauncherArgs(argv: readonly string[]): LauncherArgs {
  if (argv.length === 1 && argv[0] === '--install-browser') return { kind: 'install-browser' };
  return parseServerArgs(argv);
}

/** Filesystem reads the launcher needs; injected so decisions are testable. */
export interface LauncherFs {
  exists(path: string): boolean;
  readText(path: string): string;
  realpath(path: string): string;
}

export function nodeExecutable(root: string, platform: NodeJS.Platform): string {
  return platform === 'win32' ? join(root, 'node', 'node.exe') : join(root, 'node', 'bin', 'node');
}

export function serverEntry(root: string): string {
  return join(root, 'server', 'dist', 'bin.js');
}

/**
 * The install root: AGENTBROWSER_HOME when set (and then only it), else the
 * directory of the real executable (winget runs portable commands through a
 * symlink in its Links directory), else the directory of the path as
 * invoked. A root counts only when it holds both the server entry and the
 * Node runtime.
 */
export function resolveInstallRoot(input: {
  env: NodeJS.ProcessEnv;
  execPath: string;
  platform: NodeJS.Platform;
  fs: LauncherFs;
}): string {
  const { env, execPath, platform, fs } = input;
  // Absolute in the target's own path semantics: the server and installer run
  // with cwd = server\, where a relative root would no longer resolve.
  const paths = platform === 'win32' ? win32 : posix;
  const absolute = (path: string) => (paths.isAbsolute(path) ? path : paths.resolve(path));
  const complete = (root: string) =>
    fs.exists(serverEntry(root)) && fs.exists(nodeExecutable(root, platform));
  const layout = `${join('server', 'dist', 'bin.js')} and the bundled node runtime (${join('node', platform === 'win32' ? 'node.exe' : 'bin/node')})`;
  if (env.AGENTBROWSER_HOME) {
    // An explicit root is the only candidate: silently running the bundle
    // next to the exe instead would hide a typo or a half-extracted upgrade.
    const root = absolute(env.AGENTBROWSER_HOME);
    if (complete(root)) return root;
    throw new Error(
      `agentbrowser-server: AGENTBROWSER_HOME=${root} is not a complete AgentBrowser bundle (needs ${layout}). Fix or unset AGENTBROWSER_HOME.`
    );
  }
  const candidates: string[] = [];
  try {
    candidates.push(dirname(fs.realpath(execPath)));
  } catch {
    // An unresolvable link falls through to the path as invoked.
  }
  candidates.push(dirname(execPath));
  for (const candidate of candidates) {
    const root = absolute(candidate);
    if (complete(root)) return root;
  }
  const tried = [...new Set(candidates)].map((root) => `  ${root}`).join('\n');
  throw new Error(
    `agentbrowser-server: incomplete installation. Searched:\n${tried}\nfor ${layout}. Reinstall AgentBrowser, or set AGENTBROWSER_HOME to the extracted bundle.`
  );
}

/** The server tree must be the build this launcher was built with. */
export function verifyServerVersion(root: string, expected: string, fs: LauncherFs): void {
  const stampPath = join(root, 'server', 'VERSION.json');
  let version: unknown;
  try {
    version = (JSON.parse(fs.readText(stampPath)) as { version?: unknown }).version;
  } catch {
    throw new Error(`agentbrowser-server: cannot read ${stampPath}; reinstall AgentBrowser.`);
  }
  if (version !== expected) {
    throw new Error(
      `agentbrowser-server: launcher ${expected} does not match server ${String(version)} in ${root}; reinstall AgentBrowser (a partial upgrade mixes versions).`
    );
  }
}

/** An operator's PLAYWRIGHT_BROWSERS_PATH wins; otherwise a per-user directory. */
export function browsersPath(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  home: string,
  serverRoot: string
): string {
  const configured = env.PLAYWRIGHT_BROWSERS_PATH;
  if (configured) {
    // Mirror Playwright: '0' means inside the playwright-core package, and a
    // relative value resolves against the server process's cwd (server\).
    if (configured === '0')
      return join(serverRoot, 'node_modules', 'playwright-core', '.local-browsers');
    return resolve(serverRoot, configured);
  }
  if (platform === 'win32') {
    return join(env.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'agentbrowser', 'browsers');
  }
  return join(home, '.cache', 'agentbrowser', 'browsers');
}

/** The builds `playwright install chromium` provides and the engine launches. */
const REQUIRED_BROWSERS = ['chromium', 'chromium-headless-shell'] as const;

/**
 * Which required Chromium builds are absent from `browsersDir`, judged the way
 * Playwright judges them: `<name with - as _>-<revision>/INSTALLATION_COMPLETE`
 * for the revisions pinned in the bundled playwright-core's browsers.json.
 * Anything unreadable reports as missing: the install it triggers is
 * idempotent, a wrongly skipped one fails every session.
 */
export function missingBrowsers(serverRoot: string, browsersDir: string, fs: LauncherFs): string[] {
  let manifest: { browsers?: { name: string; revision: string }[] };
  try {
    manifest = JSON.parse(
      fs.readText(join(serverRoot, 'node_modules', 'playwright-core', 'browsers.json'))
    );
  } catch {
    return ['browsers.json unreadable'];
  }
  const missing: string[] = [];
  for (const name of REQUIRED_BROWSERS) {
    const entry = manifest.browsers?.find((browser) => browser.name === name);
    if (!entry) {
      missing.push(name);
      continue;
    }
    const directory = `${name.replace(/-/g, '_')}-${entry.revision}`;
    if (!fs.exists(join(browsersDir, directory, 'INSTALLATION_COMPLETE'))) missing.push(directory);
  }
  return missing;
}

/** The bundled Playwright CLI used for `install chromium`. */
export function playwrightCli(serverRoot: string): string {
  return join(serverRoot, 'node_modules', 'playwright', 'cli.js');
}

/**
 * The server's environment: everything the operator set, plus the browsers
 * path the launcher installed into and the stdin lifeline, so the server (and
 * its Chromium) stops when the launcher goes away for any reason.
 */
export function serverEnvironment(env: NodeJS.ProcessEnv, browsers: string): NodeJS.ProcessEnv {
  return { ...env, PLAYWRIGHT_BROWSERS_PATH: browsers, AGENTBROWSER_SHUTDOWN_ON_STDIN_EOF: '1' };
}
