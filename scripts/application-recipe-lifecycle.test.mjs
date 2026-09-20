import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runNodeRecipe } from './application-recipe-acceptance.mjs';

async function waitForFile(path) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    try {
      await stat(path);
      return;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Fake CLI did not start');
}

function isGone(pid) {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return error.code === 'ESRCH';
  }
}

test('guard rejection drains the Node recipe and its TERM-resistant CLI before cleanup', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agentbrowser-recipe-drain-'));
  const cliPath = join(directory, 'fake-cli.mjs');
  const configPath = join(directory, 'config.json');
  const reportPath = join(directory, 'report.json');
  const pidPath = join(directory, 'cli-pid.json');
  const controller = new AbortController();
  try {
    await writeFile(
      cliPath,
      `import {writeFileSync} from 'node:fs';
writeFileSync(process.argv[2], JSON.stringify({pid:process.pid,parent:process.ppid}));
process.on('SIGTERM',()=>{});
setInterval(()=>{},1000);\n`,
      { mode: 0o600 }
    );
    await writeFile(
      configPath,
      `${JSON.stringify({
        caseName: 'pass',
        serviceBaseUrl: 'http://127.0.0.1:1',
        cli: [process.execPath, cliPath, pidPath],
        application: {
          adapter: 'fixture-counter',
          resource: 'recipe-pass',
          url: 'http://127.0.0.1:2',
          fixture: { id: 'fixture-counter', version: '1' },
          verifier: { id: 'fixture.ui-commit', version: '1' },
        },
        expectedVersion: '1.9.0',
        reportPath,
      })}\n`,
      { mode: 0o600 }
    );
    const guardFailure = new Error('INJECTED_GUARD_FAILURE');
    const proc = {
      signal: controller.signal,
      async guard() {
        await waitForFile(pidPath);
        controller.abort(guardFailure);
        // Let Node handle the abort signal before the independent guard rejection.
        await new Promise((resolve) => setTimeout(resolve, 50));
        throw guardFailure;
      },
    };
    const started = Date.now();
    await assert.rejects(
      runNodeRecipe({
        configPath,
        env: {
          PATH: process.env.PATH,
          TMPDIR: directory,
          AGENTBROWSER_RECIPE_OPERATOR_KEY: 'operator-key',
        },
        expectedExitCode: 0,
        proc,
      }),
      guardFailure
    );
    assert.ok(Date.now() - started < 5000, 'Recipe drain exceeded the outer cleanup budget');
    const pids = JSON.parse(await readFile(pidPath, 'utf8'));
    assert.equal(isGone(pids.pid), true, 'CLI remained alive when caller cleanup resumed');
    assert.equal(
      isGone(pids.parent),
      true,
      'Node recipe remained alive when caller cleanup resumed'
    );
    await assert.rejects(stat(reportPath), { code: 'ENOENT' });
    await assert.rejects(stat(`${reportPath}.manifest.json`), { code: 'ENOENT' });
  } finally {
    controller.abort();
    try {
      const pids = JSON.parse(await readFile(pidPath, 'utf8'));
      for (const pid of [pids.pid, pids.parent]) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {}
      }
    } catch {}
    await rm(directory, { recursive: true, force: true });
  }
});
