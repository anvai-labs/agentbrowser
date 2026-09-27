import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const scripts = [
  'cdp-attach-smoke.mjs',
  'navigation-consumer-smoke.mjs',
  'research-consumer-smoke.mjs',
];
const root = fileURLToPath(new URL('../', import.meta.url));

for (const script of scripts) {
  test(`${script} refuses an incomplete packaged-candidate selection before launching`, () => {
    const result = spawnSync(
      process.execPath,
      [fileURLToPath(new URL(script, import.meta.url)), '--server-root', '/unused'],
      { encoding: 'utf8', timeout: 10_000 }
    );

    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /Packaged candidate mode requires --server-root, --expected-version, --expected-commit, --cli and --mcp/
    );
    assert.doesNotMatch(result.stderr, /Chrome debugging endpoint not ready/);
  });

  test(`${script} resolves a complete packaged selection before any browser launch`, () => {
    const result = spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL(script, import.meta.url)),
        '--server-root',
        root,
        '--expected-version',
        '0.0.0-test',
        '--expected-commit',
        'a'.repeat(40),
        '--cli',
        '/unused/cli',
        '--mcp',
        '/unused/mcp',
      ],
      { encoding: 'utf8', timeout: 10_000 }
    );

    assert.equal(result.status, 1);
    assert.match(result.stderr, /Expected extracted API server package/);
    assert.doesNotMatch(result.stderr, /Chrome debugging endpoint not ready/);
  });
}
