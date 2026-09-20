import assert from 'node:assert/strict';
import test from 'node:test';

const moduleUrl = new URL('../examples/node-test/application-outcome.mjs', import.meta.url);
const command = (code) => [process.execPath, '-e', code, '--'];

test('copied recipe loads with only its documented companion from an unrelated cwd', async () => {
  const { withStandaloneRecipe } = await import('./application-recipe-acceptance.mjs');
  const { mkdtemp, readFile, readdir, rm, stat, access } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join, dirname } = await import('node:path');
  const { pathToFileURL } = await import('node:url');
  const { runExecutable } = await import('./release-smoke.mjs');
  const directory = await mkdtemp(join(tmpdir(), 'recipe-copy-test-'));
  let staged;
  try {
    const result = await withStandaloneRecipe(directory, async ({ script, cwd }) => {
      staged = dirname(script);
      assert.notEqual(cwd, staged);
      assert.deepEqual((await readdir(staged)).sort(), ['application-outcome.mjs', 'report-artifacts.mjs']);
      for (const name of await readdir(staged)) {
        assert.deepEqual(await readFile(join(staged, name)), await readFile(new URL(`../examples/node-test/${name}`, import.meta.url)));
        assert.equal((await stat(join(staged, name))).mode & 0o777, 0o600);
      }
      const probe = `const m = await import(${JSON.stringify(pathToFileURL(script).href)}); console.log(m.applicationRecipeTestName('pass'));`;
      const loaded = await runExecutable([process.execPath, '--input-type=module', '-e', probe], { cwd });
      assert.equal(loaded.stdout.trim(), 'application outcome: pass');
      // Prove the companion is loaded from the copied location, not the workspace.
      await rm(join(staged, 'report-artifacts.mjs'));
      await assert.rejects(runExecutable([process.execPath, '--input-type=module', '-e', probe], { cwd }));
      return 'qualified';
    });
    assert.equal(result, 'qualified');
    await assert.rejects(access(staged), { code: 'ENOENT' });
    assert.deepEqual(await readdir(directory), []);
    const sentinel = new Error('exercise failure');
    await assert.rejects(withStandaloneRecipe(directory, async () => { throw sentinel; }), (error) => error === sentinel);
    assert.deepEqual(await readdir(directory), []);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('application recipe isolates CLI credentials and Node injection from operator context', async () => {
  const { callInstalledCli } = await import(moduleUrl);
  const result = await callInstalledCli(
    command('process.stdout.write(JSON.stringify(process.env))'),
    [],
    {
      env: {
        PATH: process.env.PATH,
        AGENTBROWSER_RECIPE_OPERATOR_KEY: 'PRIVATE_OPERATOR',
        AGENTBROWSER_API_KEY: 'PRIVATE_OPERATOR',
        NODE_OPTIONS: '--require=PRIVATE_OPERATOR',
        HTTP_PROXY: 'PRIVATE_OPERATOR',
        HOME: 'PRIVATE_OPERATOR',
      },
      token: 'qa-only',
    }
  );
  const env = JSON.parse(result.stdout);
  assert.equal(env.AGENTBROWSER_API_KEY, 'qa-only');
  assert.ok(!result.stdout.includes('PRIVATE_OPERATOR'));
  assert.equal(env.PATH, process.env.PATH);
});

test('application recipe retains canonical exit-one output and refuses invalid process outcomes', async () => {
  const { callInstalledCli } = await import(moduleUrl);
  const result = await callInstalledCli(
    command('process.stdout.write(JSON.stringify({verdict:"failed"}));process.exitCode=1'),
    [],
    { env: process.env }
  );
  assert.equal(result.code, 1);
  assert.deepEqual(JSON.parse(result.stdout), { verdict: 'failed' });
  for (const code of [
    'process.exitCode=1',
    'process.stdout.write("PRIVATE_OUTPUT");process.exitCode=1',
    'process.stderr.write("PRIVATE_OUTPUT");process.exitCode=1',
    'process.stdout.write("PRIVATE_OUTPUT");process.exitCode=2',
    'process.kill(process.pid,"SIGTERM")',
  ]) {
    let failure;
    try {
      await callInstalledCli(command(code), [], { env: process.env });
    } catch (error) {
      failure = error;
    }
    assert.ok(failure, 'Invalid CLI process outcome must fail');
    assert.ok(!failure.stack.includes('PRIVATE_OUTPUT'));
    assert.equal(failure.cause, undefined);
  }
});

test('application recipe bounds process time, stdout and private stdin', async () => {
  const { callInstalledCli } = await import(moduleUrl);
  for (const [code, options] of [
    ['setInterval(()=>{},1000)', { timeoutMs: 100 }],
    ['process.stdout.write("x".repeat(4096))', { maxOutputBytes: 1024 }],
    ['process.exit(0)', { input: 'PRIVATE_INPUT'.repeat(7000) }],
  ]) {
    await assert.rejects(
      async () => callInstalledCli(command(code), [], { env: process.env, ...options }),
      (error) => !error.stack.includes('PRIVATE_INPUT') && error.cause === undefined
    );
  }
});

test('application recipe rejects absent or malformed configuration without private diagnostics', async () => {
  const { runCounterCase } = await import(moduleUrl);
  for (const input of [undefined, {}, { serviceBaseUrl: 'PRIVATE_CONFIG' }]) {
    await assert.rejects(
      async () => runCounterCase(input),
      (error) => !error.stack.includes('PRIVATE_CONFIG') && error.cause === undefined
    );
  }
});

test('handled termination drains a CLI grandchild that ignores SIGTERM and publishes no report', async () => {
  const { mkdtemp, writeFile, readFile, rm, access } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const { spawn } = await import('node:child_process');
  const directory = await mkdtemp(join(tmpdir(), 'application-recipe-abort-'));
  const pidPath = join(directory, 'cli.pid');
  const reportPath = join(directory, 'report.json');
  const configPath = join(directory, 'config.json');
  let child;
  let cliPid;
  try {
    const fake = join(directory, 'cli.mjs');
    await writeFile(
      fake,
      `import {writeFileSync} from 'node:fs';\nprocess.on('SIGTERM',()=>{});\nwriteFileSync(${JSON.stringify(pidPath)},String(process.pid));\nsetInterval(()=>{},1000);\n`
    );
    await writeFile(
      configPath,
      JSON.stringify({
        caseName: 'pass',
        serviceBaseUrl: 'http://127.0.0.1:1',
        cli: [process.execPath, fake],
        expectedVersion: '1.9.0',
        reportPath,
        application: {
          adapter: 'fixture-counter',
          resource: 'recipe-pass',
          url: 'http://127.0.0.1:1',
          fixture: { id: 'fixture-counter', version: '1' },
          verifier: { id: 'fixture.ui-commit', version: '1' },
        },
      }),
      { mode: 0o600 }
    );
    child = spawn(process.execPath, [fileURLToPath(moduleUrl), configPath], {
      env: { PATH: process.env.PATH, AGENTBROWSER_RECIPE_OPERATOR_KEY: 'PRIVATE_OPERATOR' },
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    const closed = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    const deadline = Date.now() + 5000;
    while (!cliPid && Date.now() < deadline) {
      try {
        cliPid = Number(await readFile(pidPath, 'utf8'));
      } catch {}
      if (!cliPid) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(cliPid, 'CLI must start before aborting its owner');
    child.kill('SIGTERM');
    let timeout;
    const outcome = await Promise.race([
      closed,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error('Recipe did not drain CLI')), 2000);
      }),
    ]).finally(() => clearTimeout(timeout));
    assert.deepEqual(outcome, { code: 1, signal: null });
    assert.throws(
      () => process.kill(cliPid, 0),
      (error) => error.code === 'ESRCH'
    );
    cliPid = undefined;
    await assert.rejects(access(reportPath), (error) => error.code === 'ENOENT');
  } finally {
    child?.kill('SIGKILL');
    if (cliPid) {
      try {
        process.kill(cliPid, 'SIGKILL');
      } catch {}
    }
    await rm(directory, { recursive: true, force: true });
  }
});

test('abort during spawn preparation is observed after listener registration', async () => {
  const { callInstalledCli } = await import(moduleUrl);
  const controller = new AbortController();
  const env = {
    get PATH() {
      controller.abort();
      return process.env.PATH;
    },
  };
  const start = Date.now();
  await assert.rejects(
    callInstalledCli(command('setInterval(()=>{},1000)'), [], {
      env,
      signal: controller.signal,
      timeoutMs: 2000,
    })
  );
  assert.ok(Date.now() - start < 1000, 'Abort must not wait for the unrelated CLI deadline');
});

test('empty CLI input closes a reader that already exited, while undelivered input fails', async () => {
  const { callInstalledCli } = await import(moduleUrl);
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { existsSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const directory = await mkdtemp(join(tmpdir(), 'application-recipe-stdin-'));
  try {
    for (const [index, input] of [undefined, '', '{}'].entries()) {
      const marker = join(directory, String(index));
      const signal = new AbortController().signal;
      const subscribe = signal.addEventListener.bind(signal);
      signal.addEventListener = (...args) => {
        const deadline = Date.now() + 2000;
        while (!existsSync(marker) && Date.now() < deadline)
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
        assert.ok(existsSync(marker));
        subscribe(...args);
      };
      const pending = callInstalledCli(
        command(
          `const fs=require('node:fs');fs.closeSync(0);fs.writeFileSync(${JSON.stringify(marker)},'closed');setTimeout(()=>process.stdout.write('done'),100);`
        ),
        [],
        { env: process.env, input, signal }
      );
      if (input === '{}') await assert.rejects(pending);
      else assert.deepEqual(await pending, { stdout: 'done', stderr: '', code: 0 });
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('service origin is preserved and acquired sessions close before engine drift rejection', async () => {
  const { runCounterCase } = await import(moduleUrl);
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const directory = await mkdtemp(join(tmpdir(), 'application-recipe-drift-'));
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.AGENTBROWSER_RECIPE_OPERATOR_KEY;
  let deleted = false;
  const requested = [];
  try {
    const fake = join(directory, 'cli.cjs');
    await writeFile(
      fake,
      `const args=process.argv.slice(2);if(args.includes('--version')){console.log('1.9.0');}else{const kind=args.includes('outcome')?'outcome-run':'test-case-evaluation';console.log(JSON.stringify({productVersion:'1.9.0',command:{schemas:{input:{$id:'urn:agentbrowser:'+kind+'-'+(kind==='outcome-run'?'request':'input')+':v1'},output:{$id:'urn:agentbrowser:'+kind+'-report:v1'}}}}));}`
    );
    globalThis.fetch = async (url, options) => {
      const target = new URL(url);
      if (target.pathname !== '/state') assert.equal(target.origin, 'https://service.example');
      const path = target.pathname.replace(/^\/\/attacker\.example/u, '');
      requested.push(path);
      if (path === '/health') return Response.json({ version: '1.9.0' });
      if (path === '/health/ready')
        return Response.json({ engine: 'playwright-chromium', version: '1.0.0' });
      if (path === '/state') return Response.json({ version: 0, total: 0 });
      if (path === '/v1/sessions')
        return Response.json(
          { sessionId: 'acquired', engine: { name: 'wrong', version: '1' } },
          { status: 201 }
        );
      if (path === '/v1/sessions/acquired' && options.method === 'DELETE') {
        deleted = true;
        return Response.json({});
      }
      if (path.startsWith('/v1/sessions/acquired') && deleted)
        return Response.json({}, { status: 404 });
      throw new Error('Unexpected recipe request');
    };
    process.env.AGENTBROWSER_RECIPE_OPERATOR_KEY = 'PRIVATE_OPERATOR';
    await assert.rejects(
      runCounterCase({
        caseName: 'pass',
        serviceBaseUrl: 'https://service.example//attacker.example',
        cli: [process.execPath, fake],
        expectedVersion: '1.9.0',
        reportPath: join(directory, 'report.json'),
        application: {
          adapter: 'fixture-counter',
          resource: 'recipe-pass',
          url: 'http://fixture.example',
          fixture: { id: 'fixture-counter', version: '1' },
          verifier: { id: 'fixture.ui-commit', version: '1' },
        },
      })
    );
    assert.equal(
      deleted,
      true,
      `Acquired session must not leak when its engine is unexpected: ${requested.join(',')}`
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.AGENTBROWSER_RECIPE_OPERATOR_KEY;
    else process.env.AGENTBROWSER_RECIPE_OPERATOR_KEY = originalKey;
    await rm(directory, { recursive: true, force: true });
  }
});

test('recipe qualification binds exact failure identities to independently observed application state', async () => {
  const { validateApplicationRecipeResult } = await import('./application-recipe-acceptance.mjs');
  const { counterDescriptor } = await import(moduleUrl);
  for (const name of ['pass', 'broken', 'cleanup-failure']) {
    const descriptor = counterDescriptor('1.9.0');
    const sample = {
      name,
      expectedVersion: '1.9.0',
      exitCode: name === 'pass' ? 0 : 1,
      evaluation: {
        schemaVersion: 1,
        provenance: 'caller_observed',
        verdict: name === 'pass' ? 'passed' : 'failed',
        descriptor,
        report: {
          case: { id: descriptor.id, version: descriptor.version },
          environment: descriptor.environment,
          setup: 'completed',
          cleanup: name === 'cleanup-failure' ? 'failed' : 'complete',
          assertions: [
            {
              id: 'save',
              status: 'completed',
              report: {
                plan: { ok: true, completed: 1 },
                outcome: {
                  testedSeam: 'ui',
                  availability: 'available',
                  execution: 'completed',
                  cleanup: 'not_needed',
                  verification: {
                    status: name === 'broken' ? 'unknown' : 'passed',
                    verifier: { id: 'fixture.ui-commit', version: '1' },
                    evidenceRefIds: name === 'broken' ? [] : ['fixture-ui-event-one'],
                  },
                },
              },
            },
          ],
        },
      },
      oracle: {
        closed: false,
        reserved: true,
        genericReceipt:
          name === 'broken'
            ? null
            : { operationId: 'business-one', expectedVersion: 0, amount: 2, version: 1, total: 2 },
        snapshot: name === 'broken' ? { version: 0, total: 0 } : { version: 1, total: 2 },
        claims: 1,
        actions: 1,
        shortcuts: 0,
        reads: 1,
        claimSessionId: 'session-one',
        receipt:
          name === 'broken'
            ? null
            : {
                channel: 'reserved_ui',
                eventId: 'one',
                operationId: 'business-one',
                expectedVersion: 0,
                amount: 2,
                version: 1,
                total: 2,
                scope: { sessionId: 'session-one' },
              },
      },
    };
    assert.equal(validateApplicationRecipeResult(sample).verdict, sample.evaluation.verdict);
    for (const corrupt of [
      (value) => {
        value.exitCode = 2;
      },
      (value) => {
        value.evaluation.verdict = 'invalid';
      },
      (value) => {
        value.evaluation.report.cleanup = name === 'cleanup-failure' ? 'complete' : 'failed';
      },
      (value) => {
        value.evaluation.report.assertions[0].status = 'skipped';
      },
      (value) => {
        value.evaluation.report.assertions[0].report.outcome.testedSeam = 'application';
      },
      (value) => {
        value.oracle.snapshot.total = 99;
      },
      (value) => {
        value.oracle.actions = 2;
      },
      (value) => {
        value.oracle.shortcuts = 1;
      },
      (value) => {
        value.oracle.receipt = null;
        value.evaluation.report.assertions[0].report.outcome.verification.evidenceRefIds = [
          'wrong',
        ];
      },
    ]) {
      const changed = structuredClone(sample);
      corrupt(changed);
      assert.throws(
        () => validateApplicationRecipeResult(changed),
        'A plausible failed exit/report must not hide incorrect independent evidence'
      );
    }
  }
});

test('private report artifacts bind exact bytes and retain an independent oracle mismatch', async () => {
  const { publishRecipeArtifacts, readRecipeArtifacts } = await import('../examples/node-test/report-artifacts.mjs');
  const { mkdtemp, readFile, rm, stat, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { createHash } = await import('node:crypto');
  const directory = await mkdtemp(join(tmpdir(), 'recipe-artifacts-'));
  const path = join(directory, 'report #?%é.json');
  try {
    const evaluation = { verdict: 'passed', privateValue: 'PRIVATE_REPORT' };
    const manifest = await publishRecipeArtifacts(path, { evaluation, oracleMatches: false });
    const bytes = await readFile(path);
    assert.deepEqual(manifest, {
      schemaVersion: 1,
      provenance: 'caller_observed',
      evaluation: {
        href: encodeURIComponent('report #?%é.json'), mediaType: 'application/json',
        sizeBytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
      },
      oracleMatches: false,
    });
    assert.ok(!JSON.stringify(manifest).includes('PRIVATE_REPORT'));
    assert.ok(!JSON.stringify(manifest).includes(directory));
    assert.deepEqual(await readRecipeArtifacts(path), { evaluation, manifest });
    if (process.platform !== 'win32') {
      assert.equal((await stat(path)).mode & 0o077, 0);
      assert.equal((await stat(`${path}.manifest.json`)).mode & 0o077, 0);
    }
    await writeFile(path, `${JSON.stringify({ ...evaluation, verdict: 'failed' })}\n`);
    await assert.rejects(readRecipeArtifacts(path), { message: 'Private recipe artifacts are invalid.' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('private report publication preserves collisions and rolls back only owned files', async () => {
  const { publishRecipeArtifacts } = await import('../examples/node-test/report-artifacts.mjs');
  const { mkdtemp, readFile, rm, writeFile, access } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const directory = await mkdtemp(join(tmpdir(), 'recipe-artifacts-collision-'));
  const path = join(directory, 'report.json');
  const result = { evaluation: { verdict: 'failed' }, oracleMatches: true };
  try {
    await writeFile(path, 'PRIVATE_EXISTING', { mode: 0o600 });
    await assert.rejects(publishRecipeArtifacts(path, result));
    assert.equal(await readFile(path, 'utf8'), 'PRIVATE_EXISTING');
    await rm(path);
    await writeFile(`${path}.manifest.json`, 'PRIVATE_EXISTING', { mode: 0o600 });
    await assert.rejects(publishRecipeArtifacts(path, result));
    await assert.rejects(access(path), { code: 'ENOENT' });
    assert.equal(await readFile(`${path}.manifest.json`, 'utf8'), 'PRIVATE_EXISTING');
    await rm(`${path}.manifest.json`);
    await assert.rejects(publishRecipeArtifacts(path, result, { signal: AbortSignal.abort() }));
    await assert.rejects(access(path), { code: 'ENOENT' });
    await assert.rejects(access(`${path}.manifest.json`), { code: 'ENOENT' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('private report readers reject unsafe files and inconsistent manifest metadata', async () => {
  const { publishRecipeArtifacts, readRecipeArtifacts, readPrivateRecipeBytes } = await import('../examples/node-test/report-artifacts.mjs');
  const { mkdtemp, readFile, rm, writeFile, chmod, symlink } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const directory = await mkdtemp(join(tmpdir(), 'recipe-artifacts-invalid-'));
  const path = join(directory, 'report.json');
  try {
    const manifest = await publishRecipeArtifacts(path, { evaluation: { verdict: 'failed' }, oracleMatches: true });
    for (const mutation of [
      (m) => { m.evaluation.href = '../PRIVATE_ESCAPE'; },
      (m) => { m.evaluation.href = 'https://example.invalid/PRIVATE'; },
      (m) => { m.evaluation.sizeBytes++; },
      (m) => { m.evaluation.sha256 = '0'.repeat(64); },
      (m) => { m.evaluation.mediaType = 'text/html'; },
      (m) => { m.extra = 'PRIVATE_EXTRA'; },
      (m) => { m.oracleMatches = 'true'; },
    ]) {
      const modified = structuredClone(manifest); mutation(modified);
      await writeFile(`${path}.manifest.json`, JSON.stringify(modified));
      await assert.rejects(readRecipeArtifacts(path), { message: 'Private recipe artifacts are invalid.' });
    }
    await writeFile(`${path}.manifest.json`, JSON.stringify(manifest));
    await writeFile(path, 'x'.repeat(65537));
    await assert.rejects(readPrivateRecipeBytes(path));
    await writeFile(path, '{}');
    if (process.platform !== 'win32') {
      await chmod(path, 0o644);
      await assert.rejects(readPrivateRecipeBytes(path));
      await chmod(path, 0o600);
    }
    const link = join(directory, 'link.json');
    await symlink(path, link);
    await assert.rejects(readPrivateRecipeBytes(link));
    assert.equal(await readFile(path, 'utf8'), '{}');
    await assert.rejects(readPrivateRecipeBytes(directory));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('abort after report creation removes the partial pair and never publishes a manifest', async () => {
  const { publishRecipeArtifacts } = await import('../examples/node-test/report-artifacts.mjs');
  const { mkdtemp, rm, access } = await import('node:fs/promises');
  const { existsSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const directory = await mkdtemp(join(tmpdir(), 'recipe-artifacts-abort-'));
  const path = join(directory, 'report.json');
  const controller = new AbortController();
  let observedCreatedReport = false;
  Object.defineProperty(controller.signal, 'throwIfAborted', { value() {
    if (existsSync(path)) { observedCreatedReport = true; controller.abort(); }
    AbortSignal.prototype.throwIfAborted.call(this);
  } });
  try {
    await assert.rejects(publishRecipeArtifacts(path, {
      evaluation: { verdict: 'failed' }, oracleMatches: true,
    }, { signal: controller.signal }), { message: 'Private recipe artifacts are invalid.' });
    assert.equal(observedCreatedReport, true);
    await assert.rejects(access(path), { code: 'ENOENT' });
    await assert.rejects(access(`${path}.manifest.json`), { code: 'ENOENT' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('artifact cleanup attempts every owned path and sanitizes unlink failures', async () => {
  const { cleanupRecipeFiles } = await import('../examples/node-test/report-artifacts.mjs');
  const attempts = [];
  await assert.rejects(cleanupRecipeFiles(['PRIVATE_MANIFEST', 'PRIVATE_REPORT'], {
    async remove(path) {
      attempts.push(path);
      if (path === 'PRIVATE_MANIFEST') throw new Error(`EPERM: ${path}`);
    },
  }), (error) => error.message === 'Private recipe artifacts are invalid.' &&
    !error.stack.includes('PRIVATE_') && error.cause === undefined);
  assert.deepEqual(attempts, ['PRIVATE_MANIFEST', 'PRIVATE_REPORT']);
});

test('artifact publisher refuses non-object serialization before creating any output', async () => {
  const { publishRecipeArtifacts } = await import('../examples/node-test/report-artifacts.mjs');
  const { mkdtemp, rm, readdir } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const directory = await mkdtemp(join(tmpdir(), 'recipe-artifacts-serialize-'));
  try {
    for (const value of [undefined, 'PRIVATE_STRING', null, 3, [], { big: 'x'.repeat(65536) }]) {
      await assert.rejects(publishRecipeArtifacts(join(directory, 'report.json'), {
        evaluation: { toJSON: () => value }, oracleMatches: true,
      }), { message: 'Private recipe artifacts are invalid.' });
      assert.deepEqual(await readdir(directory), []);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('recipe qualification closes its fixture even when artifact removal fails', async () => {
  const { qualifyApplicationRecipe } = await import('./application-recipe-acceptance.mjs');
  const { mkdtemp, mkdir, rm, access } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const directory = await mkdtemp(join(tmpdir(), 'PRIVATE-artifact-cleanup-'));
  const calls = [];
  const proc = {
    signal: new AbortController().signal,
    guard: (promise) => promise,
    async rpc(method) {
      calls.push(method);
      if (method === 'fixture') return { url: 'http://127.0.0.1:1' };
      if (method === 'closeFixture') return {};
      if (method === 'fixtureState') return { closed: true };
      throw new Error('Unexpected fixture call');
    },
  };
  try {
    // rm(force:true) cannot unlink a directory; this simulates an artifact finalizer failure.
    await mkdir(join(directory, 'application-recipe-pass.report.json.manifest.json'));
    await assert.rejects(qualifyApplicationRecipe({
      proc, cli: [process.execPath, '-e', 'process.exit(2)'], directory,
      env: process.env, key: 'PRIVATE_OPERATOR', baseUrl: 'http://127.0.0.1:1',
      fixture: { id: 'fixture-counter', version: '1' }, expectedVersion: '1.9.0',
    }), (error) => error.message === 'Private recipe artifacts are invalid.' &&
      !error.stack.includes(directory));
    assert.deepEqual(calls, ['fixture', 'closeFixture', 'fixtureState']);
    await assert.rejects(access(join(directory, 'application-recipe-pass.json')), { code: 'ENOENT' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('native report qualification never echoes unexpected private stderr', async () => {
  const { validateApplicationRecipeNativeReport } = await import('./application-recipe-acceptance.mjs');
  let failure;
  try {
    validateApplicationRecipeNativeReport({
      name: 'pass', stdout: '', stderr: 'PRIVATE_STDERR /private/operator/path',
      digest: 'a'.repeat(64),
    });
  } catch (error) { failure = error; }
  assert.equal(failure?.message, 'Application recipe native report is invalid');
  assert.equal(failure.cause, undefined);
  assert.ok(!failure.stack.includes('PRIVATE_STDERR'));
  assert.ok(!failure.stack.includes('/private/operator/path'));
});
