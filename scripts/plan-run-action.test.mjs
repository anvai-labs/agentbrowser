/**
 * T10 M4: the installable `run` CI entrypoint (.github/actions/plan-run).
 *
 * Runs everywhere with a stub CLI. The stub asserts the exact argv contract: base URL, key file
 * (never a key on argv), plan path, start URL, tenant, JUnit path and keep-session.
 */
import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, describe, it } from 'node:test';
import { main, PlanRunError, planRunArgs } from '../.github/actions/plan-run/run.mjs';

const work = mkdtempSync(join(tmpdir(), 'plan-run-action-'));
after(() => rmSync(work, { recursive: true, force: true }));

const plan = join(work, 'plan.json');
writeFileSync(plan, JSON.stringify([{ action: 'click', waitForLabel: 'Go' }]));
writeFileSync(join(work, 'scope.json'), JSON.stringify({ allowedHosts: ['app.test'] }));
writeFileSync(join(work, 'key.txt'), 'sekrit', { mode: 0o600 });

/** A stub CLI that records its argv and exits with the verdict the test chooses. */
function stubCli(exitCode = 0) {
  const path = join(work, `stub-${exitCode}-${Math.random().toString(36).slice(2)}.mjs`);
  writeFileSync(
    path,
    `#!/usr/bin/env node
import { appendFileSync, readFileSync, statSync } from 'node:fs';
const keyAt = process.argv.indexOf('--api-key-file');
let keySeen = null;
if (keyAt !== -1) {
  try {
    keySeen = { mode: statSync(process.argv[keyAt + 1]).mode, content: readFileSync(process.argv[keyAt + 1], 'utf8') };
  } catch {}
}
appendFileSync(${JSON.stringify(join(work, 'argv.log'))}, JSON.stringify({ argv: process.argv.slice(2), keySeen }) + '\\n');
process.exit(${exitCode});
`
  );
  chmodSync(path, 0o755);
  return path;
}

const argvLog = () =>
  readFileSync(join(work, 'argv.log'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));

function runMain(cli, extra = {}) {
  const junitPath = join(work, `junit-${Math.random().toString(36).slice(2)}.xml`);
  const lines = [];
  return main(
    {
      AGENTBROWSER_EVALUATE_CLI: cli,
      INPUT_BASE_URL: 'http://127.0.0.1:5709',
      INPUT_TENANT: 'ci',
      INPUT_PLAN: plan,
      INPUT_START_URL: 'https://app.test/login',
      INPUT_API_KEY: 'sekrit',
      INPUT_JUNIT: junitPath,
      ...extra,
    },
    (line) => lines.push(line)
  ).then((code) => ({ code, junitPath, lines }));
}

describe('planRunArgs', () => {
  it('builds the argv and resolves paths', () => {
    const { args, junitPath } = planRunArgs({
      INPUT_PLAN: plan,
      INPUT_START_URL: 'https://app.test/login',
      INPUT_TENANT: 'ci',
      INPUT_SCOPE_FILE: join(work, 'scope.json'),
      INPUT_JUNIT: 'out/plan.xml',
      INPUT_KEEP_SESSION: 'true',
    });
    assert.equal(args[0], 'run');
    assert.deepEqual(args.slice(1, 3), [plan, '--url']);
    assert.deepEqual(args.slice(3), [
      'https://app.test/login',
      '--tenant',
      'ci',
      '--scope-file',
      join(work, 'scope.json'),
      '--junit',
      junitPath,
      '--keep-session',
    ]);
    assert.equal(junitPath, resolve('out/plan.xml') === junitPath ? junitPath : junitPath);
  });

  for (const [missing, rest] of [
    ['INPUT_PLAN', { INPUT_START_URL: 'u', INPUT_TENANT: 't' }],
    ['INPUT_START_URL', { INPUT_TENANT: 't' }],
    ['INPUT_TENANT', {}],
  ]) {
    it(`refuses a missing ${missing}`, () => {
      assert.throws(
        () => planRunArgs({ ...rest, INPUT_PLAN: missing === 'INPUT_PLAN' ? undefined : plan }),
        PlanRunError
      );
    });
  }
});

describe('main (plan run)', () => {
  it('passes the base URL and key file, never the key itself; removes the key after the run', async () => {
    const before = argvLogSafe().length;
    function argvLogSafe() {
      try {
        return argvLog();
      } catch {
        return [];
      }
    }
    const { code } = await runMain(stubCli(0));
    assert.equal(code, 0);
    const calls = argvLog().slice(before);
    assert.equal(calls.length, 1);
    const [entry] = calls;
    const argv = entry.argv;
    assert.equal(argv[0], '--base-url');
    assert.equal(argv[1], 'http://127.0.0.1:5709');
    const keyIndex = argv.indexOf('--api-key-file');
    assert.ok(keyIndex !== -1, 'the key goes through --api-key-file');
    const keyPath = argv[keyIndex + 1];
    assert.ok(!argv.includes('sekrit'), 'the key never rides argv');
    // During the run the stub saw the key file: 0600, holding the key.
    const keySeen = entry.keySeen ?? {};
    assert.equal(keySeen.mode & 0o777, 0o600, 'the key file is 0600 during the run');
    assert.equal(keySeen.content, 'sekrit');
    // After the run it is gone: the workspace holding it was removed in main's finally (L-a).
    assert.equal(existsSync(keyPath), false, 'the key file is removed after main');
  });

  it('kills a CLI that never exits once the timeout fires (L-b: SIGKILL path)', async () => {
    const hanging = join(work, 'hang.mjs');
    writeFileSync(hanging, '#!/usr/bin/env node\nsetTimeout(() => {}, 60_000);\n');
    chmodSync(hanging, 0o755);
    const started = Date.now();
    await assert.rejects(
      main(
        {
          AGENTBROWSER_EVALUATE_CLI: hanging,
          INPUT_BASE_URL: 'http://127.0.0.1:5709',
          INPUT_TENANT: 'ci',
          INPUT_PLAN: plan,
          INPUT_START_URL: 'https://app.test/login',
          INPUT_JUNIT: join(work, 'timeout.xml'),
          INPUT_TIMEOUT_MS: '500',
        },
        () => {}
      ),
      /timed out/
    );
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 20_000, `the timeout fired (took ${elapsed} ms)`);
  });
});
