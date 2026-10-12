import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PRODUCT_VERSION } from '../product-version.js';
import {
  browsersPath,
  type LauncherFs,
  missingBrowsers,
  parseLauncherArgs,
  resolveInstallRoot,
  serverEnvironment,
  verifyServerVersion,
} from './core.js';

/** In-memory fs: a set of existing paths and a map of file contents. */
function fakeFs(files: Record<string, string>, links: Record<string, string> = {}): LauncherFs {
  const norm = (p: string) => p.replace(/\\/g, '/');
  const all = Object.fromEntries(Object.entries(files).map(([k, v]) => [norm(k), v]));
  const dirs = new Set<string>();
  for (const file of Object.keys(all)) {
    const parts = file.split('/');
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
  }
  return {
    exists: (p) => norm(p) in all || dirs.has(norm(p)),
    readText: (p) => {
      const content = all[norm(p)];
      if (content === undefined) throw new Error(`ENOENT: ${p}`);
      return content;
    },
    realpath: (p) => links[norm(p)] ?? norm(p),
  };
}

const LAYOUT = (root: string) => ({
  [`${root}/server/dist/bin.js`]: '',
  [`${root}/node/node.exe`]: '',
  [`${root}/server/VERSION.json`]: JSON.stringify({
    version: PRODUCT_VERSION,
    commit: 'a'.repeat(40),
  }),
});

describe('launcher arguments', () => {
  it('answers help/version, accepts --install-browser, and rejects anything else with exit 2', () => {
    expect(parseLauncherArgs([])).toEqual({ kind: 'run' });
    expect(parseLauncherArgs(['--help']).kind).toBe('help');
    expect(parseLauncherArgs(['-h']).kind).toBe('help');
    expect(parseLauncherArgs(['--version']).kind).toBe('version');
    expect(parseLauncherArgs(['--install-browser'])).toEqual({ kind: 'install-browser' });
    const bad = parseLauncherArgs(['--port', '1']);
    expect(bad.kind).toBe('error');
    if (bad.kind === 'error') expect(bad.message).toMatch(/--port.*environment variables/s);
  });
});

describe('install root resolution (never __dirname: Bun bakes it at compile time)', () => {
  it('uses the directory of the real executable, following a winget Links symlink', () => {
    const fs = fakeFs(LAYOUT('C:/pkg'), {
      'C:/Links/agentbrowser-server.exe': 'C:/pkg/agentbrowser-server.exe',
    });
    expect(
      resolveInstallRoot({
        env: {},
        execPath: 'C:/Links/agentbrowser-server.exe',
        platform: 'win32',
        fs,
      })
    ).toBe('C:/pkg');
  });

  it('prefers AGENTBROWSER_HOME when it holds a complete layout', () => {
    const fs = fakeFs({ ...LAYOUT('C:/pkg'), ...LAYOUT('D:/custom') });
    expect(
      resolveInstallRoot({
        env: { AGENTBROWSER_HOME: 'D:/custom' },
        execPath: 'C:/pkg/agentbrowser-server.exe',
        platform: 'win32',
        fs,
      })
    ).toBe('D:/custom');
  });

  it('falls back to the unresolved executable directory when realpath gives an incomplete one', () => {
    const fs = fakeFs(LAYOUT('C:/pkg'), { 'C:/pkg/agentbrowser-server.exe': 'C:/elsewhere/x.exe' });
    expect(
      resolveInstallRoot({
        env: {},
        execPath: 'C:/pkg/agentbrowser-server.exe',
        platform: 'win32',
        fs,
      })
    ).toBe('C:/pkg');
  });

  it('fails with every candidate it tried when no layout is complete', () => {
    const fs = fakeFs({ 'C:/pkg/server/dist/bin.js': '' }); // node.exe missing
    expect(() =>
      resolveInstallRoot({
        env: { AGENTBROWSER_HOME: 'D:/nope' },
        execPath: 'C:/pkg/agentbrowser-server.exe',
        platform: 'win32',
        fs,
      })
    ).toThrow(/D:\/nope[\s\S]*C:\/pkg[\s\S]*node/);
  });
});

describe('server version stamp', () => {
  it('accepts a matching stamp and refuses a mismatched or unreadable one', () => {
    expect(() =>
      verifyServerVersion('C:/pkg', PRODUCT_VERSION, fakeFs(LAYOUT('C:/pkg')))
    ).not.toThrow();
    const stale = fakeFs({ 'C:/pkg/server/VERSION.json': JSON.stringify({ version: '0.0.1' }) });
    expect(() => verifyServerVersion('C:/pkg', PRODUCT_VERSION, stale)).toThrow(
      /0\.0\.1.*reinstall/s
    );
    expect(() => verifyServerVersion('C:/pkg', PRODUCT_VERSION, fakeFs({}))).toThrow(
      /VERSION\.json/
    );
  });
});

describe('browsers path', () => {
  it('keeps an operator PLAYWRIGHT_BROWSERS_PATH, else uses a per-user directory', () => {
    expect(browsersPath({ PLAYWRIGHT_BROWSERS_PATH: 'E:/b' }, 'win32', 'C:/Users/u')).toBe('E:/b');
    expect(browsersPath({ LOCALAPPDATA: 'C:/Users/u/AppData/Local' }, 'win32', 'C:/Users/u')).toBe(
      join('C:/Users/u/AppData/Local', 'agentbrowser', 'browsers')
    );
    expect(browsersPath({}, 'win32', 'C:/Users/u')).toBe(
      join('C:/Users/u', 'AppData', 'Local', 'agentbrowser', 'browsers')
    );
    expect(browsersPath({}, 'linux', '/home/u')).toBe(
      join('/home/u', '.cache', 'agentbrowser', 'browsers')
    );
  });

  it('treats an empty PLAYWRIGHT_BROWSERS_PATH as unset', () => {
    expect(browsersPath({ PLAYWRIGHT_BROWSERS_PATH: '' }, 'linux', '/home/u')).toBe(
      join('/home/u', '.cache', 'agentbrowser', 'browsers')
    );
  });
});

describe('missing browsers (first-start bootstrap decision)', () => {
  const server = 'C:/pkg/server';
  const manifest = JSON.stringify({
    browsers: [
      { name: 'chromium', revision: '1234', installByDefault: true },
      { name: 'chromium-headless-shell', revision: '1234', installByDefault: true },
      { name: 'firefox', revision: '1538', installByDefault: true },
    ],
  });
  const withManifest = (extra: Record<string, string>) =>
    fakeFs({ [`${server}/node_modules/playwright-core/browsers.json`]: manifest, ...extra });

  it('reports nothing missing when both Chromium builds are complete', () => {
    const fs = withManifest({
      'B:/br/chromium-1234/INSTALLATION_COMPLETE': '',
      'B:/br/chromium_headless_shell-1234/INSTALLATION_COMPLETE': '',
    });
    expect(missingBrowsers(server, 'B:/br', fs)).toEqual([]);
  });

  it('reports a build whose directory exists without the completion marker (interrupted download)', () => {
    const fs = withManifest({
      'B:/br/chromium-1234/chrome-win64/chrome.exe': '',
      'B:/br/chromium_headless_shell-1234/INSTALLATION_COMPLETE': '',
    });
    expect(missingBrowsers(server, 'B:/br', fs)).toEqual(['chromium-1234']);
  });

  it('reports an older revision as missing (upgrade needs the new build)', () => {
    const fs = withManifest({
      'B:/br/chromium-1200/INSTALLATION_COMPLETE': '',
      'B:/br/chromium_headless_shell-1200/INSTALLATION_COMPLETE': '',
    });
    expect(missingBrowsers(server, 'B:/br', fs)).toEqual([
      'chromium-1234',
      'chromium_headless_shell-1234',
    ]);
  });

  it('fails toward installing when the manifest is unreadable or lacks chromium', () => {
    expect(missingBrowsers(server, 'B:/br', fakeFs({}))).toEqual(['browsers.json unreadable']);
    const noChromium = fakeFs({
      [`${server}/node_modules/playwright-core/browsers.json`]: '{"browsers":[]}',
    });
    expect(missingBrowsers(server, 'B:/br', noChromium)).toEqual([
      'chromium',
      'chromium-headless-shell',
    ]);
  });
});

describe('server environment', () => {
  it('pins the browsers path and enables the stdin lifeline without dropping operator settings', () => {
    const env = serverEnvironment({ PORT: '6000', AGENTBROWSER_API_KEYS: 'k:t' }, 'B:/br');
    expect(env).toMatchObject({
      PORT: '6000',
      AGENTBROWSER_API_KEYS: 'k:t',
      PLAYWRIGHT_BROWSERS_PATH: 'B:/br',
      AGENTBROWSER_SHUTDOWN_ON_STDIN_EOF: '1',
    });
  });
});

describe('launcher stays engine-free and location-independent', () => {
  // The launcher is Bun-compiled to a single exe. Anything beyond node:
  // builtins (or a module that reads __dirname / import.meta) would bake the
  // build machine's paths into it — the exact v1.17.0 Windows failure.
  const dir = join(process.cwd(), 'src', 'launcher');
  const sources = readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
  const allowedRelative = new Set(['./core.js', '../product-version.js', '../server-args.js']);

  it('imports only node: builtins and an allowlist of dependency-free modules', () => {
    expect(sources.sort()).toEqual(['core.ts', 'main.ts']);
    for (const file of sources) {
      // Code only: the doc comments explain these rules by name.
      const text = readFileSync(join(dir, file), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      for (const [, specifier] of text.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)) {
        expect(
          specifier.startsWith('node:') || allowedRelative.has(specifier),
          `${file}: ${specifier}`
        ).toBe(true);
      }
      expect(text, `${file} must not use __dirname`).not.toMatch(/__dirname|__filename/);
      expect(text, `${file} must not use import.meta`).not.toMatch(/import\.meta/);
    }
  });

  it('the allowlisted modules are themselves dependency-free', () => {
    for (const file of ['product-version.ts', 'server-args.ts']) {
      const text = readFileSync(join(process.cwd(), 'src', file), 'utf8');
      for (const [, specifier] of text.matchAll(/from\s*['"]([^'"]+)['"]/g)) {
        expect(['./product-version.js'], `${file}: ${specifier}`).toContain(specifier);
      }
    }
  });
});
