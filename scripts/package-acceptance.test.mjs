import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { apiRequest, auditDependencyClosure, resolvePackagedModules, validateArtifact, withManagedChild } from './package-acceptance.mjs';

test('agent CLI spawn receives only its delegated key and explicit runtime environment', async () => {
  const { runAgentCli } = await import('./cli-outcome-acceptance.mjs');
  assert.equal(typeof runAgentCli, 'function');
  const sentinel = 'PRIVATE_OPERATOR_SENTINEL';
  const observed = JSON.parse(
    (
      await runAgentCli(
        [process.execPath, '-e', 'process.stdout.write(JSON.stringify(process.env))'],
        {
          env: {
            PATH: process.env.PATH,
            LANG: 'C',
            TMPDIR: tmpdir(),
            AGENTBROWSER_API_KEY: sentinel,
            AGENTBROWSER_API_KEYS: `${sentinel}:operator`,
            OPERATOR_SECRET: sentinel,
            AWS_SECRET_ACCESS_KEY: sentinel,
            HTTP_PROXY: sentinel,
            https_proxy: sentinel,
            ALL_PROXY: sentinel,
            NODE_OPTIONS: '--require=PRIVATE_OPERATOR_SENTINEL',
            NODE_PATH: sentinel,
            AGENTBROWSER_BASE_URL: sentinel,
            HOME: sentinel,
          },
          token: 'delegated-fixture-token',
        }
      )
    ).stdout
  );
  assert.equal(observed.AGENTBROWSER_API_KEY, 'delegated-fixture-token');
  assert.equal(observed.PATH, process.env.PATH);
  assert.equal(observed.LANG, 'C');
  assert.equal(observed.TMPDIR, tmpdir());
  assert.ok(!JSON.stringify(observed).includes(sentinel));
  // macOS CoreFoundation adds this in the runtime after spawn, not from the parent.
  assert.deepEqual(
    Object.keys(observed)
      .filter((name) => name !== '__CF_USER_TEXT_ENCODING')
      .sort(),
    ['AGENTBROWSER_API_KEY', 'LANG', 'PATH', 'TMPDIR']
  );
});

const evaluationBundle = (name, verdict) => {
  const descriptor = {
    id: `case.${name}`,
    version: '1',
    testedSeam: 'ui',
    environment: {
      productVersion: '1.9.0',
      cliVersion: '1.9.0',
      engine: { name: 'fixture', version: '1' },
      fixture: { id: 'fixture', version: '1' },
    },
    assertions: [{ id: 'save', required: true }],
  };
  const report = {
    case: { id: descriptor.id, version: descriptor.version },
    environment: descriptor.environment,
    setup: verdict === 'passed' ? 'completed' : 'failed',
    assertions: [{ id: 'save', status: 'skipped', reasonCode: 'PRECONDITION_UNAVAILABLE' }],
    cleanup: 'complete',
  };
  return {
    name,
    expectedVerdict: verdict,
    bundle: { schemaVersion: 1, descriptor, invocations: [], report },
    metadata: { oracle: { actions: 0, claims: 0, reads: 0, shortcuts: 0 } },
  };
};

const evaluationDiscovery = (version = '1.9.0') => ({
  productVersion: version,
  command: {
    path: ['test', 'evaluate'],
    schemas: {
      input: { $id: 'urn:agentbrowser:test-case-evaluation-input:v1' },
      output: { $id: 'urn:agentbrowser:test-case-evaluation-report:v1' },
    },
  },
});

test('buffered evaluation publishes no partial result when evaluator N fails', async () => {
  const { evaluateBufferedTestCaseBundles } = await import('./cli-outcome-acceptance.mjs');
  const bundles = [evaluationBundle('one', 'passed'), evaluationBundle('two', 'failed')];
  let evaluations = 0;
  let published;
  const runner = async (command, options) => {
    assert.equal(Object.hasOwn(options, 'token'), false, 'Offline evaluation must receive no token');
    if (command.includes('describe')) {
      return { stdout: JSON.stringify(evaluationDiscovery()), stderr: '', code: 0 };
    }
    evaluations++;
    if (evaluations === 2) throw new Error('PRIVATE-EVALUATOR-FAILURE');
    const input = JSON.parse(options.stdin);
    return {
      stdout: JSON.stringify({
        schemaVersion: 1,
        provenance: 'caller_observed',
        verdict: 'passed',
        descriptor: input.descriptor,
        report: input.report,
      }),
      stderr: '',
      code: 0,
    };
  };
  let failure;
  await assert.rejects(
    evaluateBufferedTestCaseBundles(
      { bundles, cli: ['agentbrowser'], directory: '.', env: {}, expectedVersion: '1.9.0' },
      { runner }
    ).then((result) => {
      published = result;
    }),
    (error) => {
      failure = error;
      return true;
    }
  );
  assert.equal(evaluations, 2);
  assert.equal(published, undefined);
  assert.match(failure.message, /two: CLI test evaluator failed/);
  assert.doesNotMatch(failure.stack, /PRIVATE/);
});

test('noncanonical evaluator output cannot leak caller reports through diagnostics', async () => {
  const { evaluateBufferedTestCaseBundles } = await import('./cli-outcome-acceptance.mjs');
  const bundles = [evaluationBundle('private-case', 'passed')];
  bundles[0].bundle.invocations.push({
    id: 'save',
    operationId: 'private-op',
    request: { private: 'PRIVATE-CALLER-INPUT' },
  });
  let failure;
  await assert.rejects(
    evaluateBufferedTestCaseBundles(
      { bundles, cli: ['agentbrowser'], directory: '.', env: {}, expectedVersion: '1.9.0' },
      {
        runner: async (command) =>
          command.includes('describe')
            ? { stdout: JSON.stringify(evaluationDiscovery()), stderr: '', code: 0 }
            : {
                stdout: JSON.stringify({ private: 'PRIVATE-EVALUATOR-OUTPUT' }),
                stderr: '',
                code: 0,
              },
      }
    ),
    (error) => {
      failure = error;
      return true;
    }
  );
  assert.match(failure.message, /noncanonical report/);
  assert.doesNotMatch(failure.stack, /PRIVATE/);
});

test('buffered evaluation records bounded byte costs without publishing private requests', async () => {
  const { evaluateBufferedTestCaseBundles } = await import('./cli-outcome-acceptance.mjs');
  const bundles = [evaluationBundle('one', 'passed'), evaluationBundle('two', 'failed')];
  bundles[0].bundle.invocations.push({
    id: 'save',
    operationId: 'private-op',
    request: { private: 'PRIVATE-EVALUATOR-INPUT' },
  });
  const exitCodes = [];
  const runner = async (command, options) => {
    assert.equal(Object.hasOwn(options, 'token'), false, 'Offline evaluation must receive no token');
    if (command.includes('describe')) {
      return { stdout: JSON.stringify(evaluationDiscovery()), stderr: '', code: 0 };
    }
    exitCodes.push(options.expectedExitCode);
    const input = JSON.parse(options.stdin);
    const verdict = options.expectedExitCode === 0 ? 'passed' : 'failed';
    return {
      stdout: JSON.stringify({
        schemaVersion: 1,
        provenance: 'caller_observed',
        verdict,
        descriptor: input.descriptor,
        report: input.report,
      }),
      stderr: '',
      code: options.expectedExitCode,
    };
  };
  let settled = false;
  const settlement = Promise.resolve().then(() => {
    settled = true;
  });
  const guardedRunner = async (...args) => {
    assert.equal(settled, true, 'Evaluator ran before outer settlement');
    return runner(...args);
  };
  const result = await evaluateBufferedTestCaseBundles(
    {
      settlement,
      bundles,
      cli: ['agentbrowser'],
      directory: '.',
      env: {},
      expectedVersion: '1.9.0',
    },
    { runner: guardedRunner }
  );
  assert.deepEqual(exitCodes, [0, 1]);
  assert.deepEqual(result.cases.map((entry) => entry.passing), [true, false]);
  assert.equal(result.cliEvaluationCalls, 2);
  assert.equal(result.cliEvaluationDiscoveryCalls, 1);
  assert.equal(result.discoveryBytes, Buffer.byteLength(JSON.stringify(evaluationDiscovery())));
  assert.equal(result.maxReportBytes, Math.max(...bundles.map((entry) => Buffer.byteLength(JSON.stringify(entry.bundle.report)))));
  assert.ok(Number.isInteger(result.elapsedMs) && result.elapsedMs >= 0);
  assert.equal(
    result.maxBundleBytes,
    Math.max(...bundles.map((entry) => Buffer.byteLength(JSON.stringify(entry.bundle))))
  );
  assert.ok(result.maxBundleOverheadBytes > 0);
  assert.ok(!JSON.stringify(result).includes('PRIVATE-EVALUATOR-INPUT'));
});

test('outer finalizer failure after workflow settlement causes zero evaluator calls', async () => {
  const { evaluateBufferedTestCaseBundles } = await import('./cli-outcome-acceptance.mjs');
  let workflowSettled = false;
  let evaluatorCalls = 0;
  const settlement = Promise.resolve().then(() => {
    workflowSettled = true;
    throw new Error('INJECTED_OUTER_FINALIZER_FAILURE');
  });
  await assert.rejects(
    evaluateBufferedTestCaseBundles(
      {
        settlement,
        bundles: [],
        expectedCount: 0,
        cli: ['agentbrowser'],
        directory: '.',
        env: {},
        expectedVersion: '1.9.0',
      },
      {
        runner: async () => {
          evaluatorCalls++;
          throw new Error('Evaluator must not run');
        },
      }
    ),
    /INJECTED_OUTER_FINALIZER_FAILURE/
  );
  assert.equal(workflowSettled, true);
  assert.equal(evaluatorCalls, 0);
});

test('artifact validation rejects empty, truncated and mismatched captures', () => {
  const capture = (bytes) => ({ metadata: { sizeBytes: bytes.length }, contentBase64: bytes.toString('base64') });
  assert.throws(() => validateArtifact(capture(Buffer.alloc(0)), 'png'), /empty/);
  assert.throws(() => validateArtifact(capture(Buffer.from('not a png')), 'png'), /PNG/);
  assert.throws(() => validateArtifact(capture(Buffer.from('%PDF-1.7')), 'pdf'), /PDF/);
  assert.throws(() => validateArtifact({ metadata: { sizeBytes: 99 }, contentBase64: 'eA==' }, 'bytes'), /size/);
  assert.equal(validateArtifact(capture(Buffer.from('payload')), 'bytes').toString(), 'payload');
});

test('package resolution rejects a checkout masquerading as an extracted package', async () => {
  await assert.rejects(resolvePackagedModules(process.cwd(), '1.8.5'), /package|server|extracted/i);
});

test('package resolution checks expected version before dependency loading', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agentbrowser-package-negative-'));
  try {
    await mkdir(join(directory, 'dist'));
    await writeFile(join(directory, 'package.json'), JSON.stringify({ name: '@agentbrowser/api', version: '0.0.0' }));
    await assert.rejects(resolvePackagedModules(directory, '1.8.5'), /version/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('package resolution rejects an escaped core dependency and dirty/mismatched provenance', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agentbrowser-package-boundary-'));
  const root = join(directory, 'server');
  try {
    await mkdir(join(root, 'node_modules/@agentbrowser'), { recursive: true });
    await mkdir(join(directory, 'outside-core'));
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: '@agentbrowser/api', version: '1.8.5' }));
    const stamp = { version: '1.8.5', commit: 'a'.repeat(40), dirty: true };
    await writeFile(join(root, 'VERSION.json'), JSON.stringify(stamp));
    await assert.rejects(resolvePackagedModules(root, '1.8.5'), /Dirty package/);
    await assert.rejects(resolvePackagedModules(root, '1.8.5', { expectedCommit: 'b'.repeat(40), allowDirty: true }), /commit mismatch/);
    await symlink(join(directory, 'outside-core'), join(root, 'node_modules/@agentbrowser/core'), 'dir');
    await assert.rejects(resolvePackagedModules(root, '1.8.5', { allowDirty: true }), /escapes extracted/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('dependency closure rejects ancestor transitive fallback and allows contained types-only dependencies', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agentbrowser-package-closure-'));
  const root = join(directory, 'server');
  const put = async (path, manifest) => {
    await mkdir(path, { recursive: true });
    await writeFile(join(path, 'package.json'), JSON.stringify(manifest));
    if (manifest.main) await writeFile(join(path, manifest.main), 'module.exports = {};');
  };
  try {
    await put(root, { name: 'server', dependencies: { parent: '1' } });
    await put(join(root, 'node_modules/parent'), { name: 'parent', main: 'index.cjs', dependencies: { nested: '1' }, optionalDependencies: { absent: '1' }, peerDependencies: { optionalPeer: '*' }, peerDependenciesMeta: { optionalPeer: { optional: true } } });
    await put(join(directory, 'node_modules/nested'), { name: 'nested', main: 'index.cjs' });
    await assert.rejects(auditDependencyClosure(root), /escapes extracted/);
    await put(join(root, 'node_modules/nested'), { name: 'nested', types: 'index.d.ts' });
    await writeFile(join(root, 'node_modules/nested/index.d.ts'), 'export interface Example {}');
    assert.equal((await auditDependencyClosure(root)).packages, 3);
    await put(join(directory, 'node_modules/absent'), { name: 'absent', main: 'index.cjs' });
    await assert.rejects(auditDependencyClosure(root), /escapes extracted/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('HTTP helper rejects error responses and malformed JSON', async () => {
  await assert.rejects(apiRequest('https://fixture.invalid', '/path', {
    fetch: async () => new Response(JSON.stringify({ error: { code: 'INTERNAL' } }), { status: 500 }),
  }), /500/);
  await assert.rejects(apiRequest('https://fixture.invalid', '/path', {
    fetch: async () => new Response('not json'),
  }), /JSON/);
});

test('HTTP helper rejects oversized bodies', async () => {
  await assert.rejects(apiRequest('https://fixture.invalid', '/path', {
    maxBytes: 8, fetch: async () => new Response('123456789'),
  }), /limit/);
});

test('HTTP helper forwards an explicit operation ID without replaying a refused write', async () => {
  let calls = 0;
  await assert.rejects(apiRequest('https://fixture.invalid', '/pages', {
    method: 'POST', body: {}, operationId: 'create-packaged-page',
    fetch: async (_url, init) => {
      calls++;
      assert.equal(init.headers['x-agentbrowser-operation-id'], 'create-packaged-page');
      return new Response(JSON.stringify({ error: { code: 'OPERATION_RECORDED' } }), { status: 409 });
    },
  }), /OPERATION_RECORDED/);
  assert.equal(calls, 1);
});

test('HTTP deadline cancels stalled body consumption', async () => {
  let cancelled = false;
  const stream = new ReadableStream({ cancel() { cancelled = true; } });
  await assert.rejects(apiRequest('https://fixture.invalid', '/path', {
    timeoutMs: 30, fetch: async () => new Response(stream),
  }), /deadline/);
  assert.equal(cancelled, true);
});

test('managed child validates graceful shutdown and rejects late output/nonzero shutdown', async () => {
  for (const mode of ['clean', 'flood', 'nonzero']) {
    const command = [process.execPath, '-e', `process.on('SIGTERM',()=>{${mode === 'flood' ? 'process.stdout.write("x".repeat(4096));' : ''}process.exit(${mode === 'nonzero' ? 7 : 0});});process.send({ready:true});setInterval(()=>{},1000)`];
    const result = withManagedChild(command, { maxOutputBytes: 1024 }, async ({ message }) => { await message(); return 'done'; });
    if (mode === 'clean') assert.equal(await result, 'done');
    else await assert.rejects(result, mode === 'flood' ? /output/ : /cleanup.*unsuccessfully/);
  }
});

test('managed child deadline aborts waiting work and closes a never-ready child', async () => {
  let pid;
  await assert.rejects(withManagedChild([process.execPath, '-e', 'setInterval(()=>{},1000)'], {
    timeoutMs: 50,
  }, async ({ child, message }) => { pid = child.pid; await message(); }), /deadline/);
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});

test('managed child detects early exit and cleans an assertion failure', async () => {
  await assert.rejects(withManagedChild([process.execPath, '-e', 'process.exit(7)'], {}, async ({ guard }) => {
    await guard(new Promise(() => {}));
  }), /exited/);
  let pid;
  await assert.rejects(withManagedChild([process.execPath, '-e', 'setInterval(()=>{},1000)'], {}, async ({ child }) => {
    pid = child.pid;
    throw new Error('injected assertion');
  }), /injected assertion/);
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});

test('managed child rejects output flood and forced shutdown cannot pass cleanup', async () => {
  await assert.rejects(withManagedChild([process.execPath, '-e', 'process.stdout.write("x".repeat(4096));setInterval(()=>{},1000)'], {
    maxOutputBytes: 1024,
  }, async ({ guard }) => guard(new Promise(() => {}))), /output/);
  let pid;
  await assert.rejects(withManagedChild([process.execPath, '-e', 'process.on("SIGTERM",()=>{});process.send({ready:true});setInterval(()=>{},1000)'], {
    shutdownMs: 50, timeoutMs: 1000,
  }, async ({ child, message }) => {
    pid = child.pid;
    await message();
  }), /forced|cleanup/);
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});

const nodeOutcomeResult = () => ({
  check: 'packaged-cli-application-outcome',
  status: 'pass',
  cases: [
    { name: 'pass', passing: true, report: { private: 'PRIVATE-REPORT-SENTINEL' } },
    { name: 'ignored', passing: false, report: { private: 'PRIVATE-REPORT-SENTINEL' } },
    { name: 'cleanup-failure', passing: false, report: { private: 'PRIVATE-REPORT-SENTINEL' } },
    ...Array.from({ length: 10 }, (_, index) => ({ name: `other-${index}`, passing: false })),
  ],
  cliEvaluationCalls: 13,
});

const nodeOutcomeJunit = `<?xml version="1.0" encoding="utf-8"?>
<testsuites>
  <testcase name="pass" time="0.1" classname="test" file="fixture"/>
  <testcase name="ignored" time="0.1" classname="test" file="fixture" failure="Outcome case did not pass"><failure type="testCodeFailure" message="Outcome case did not pass">fixed</failure></testcase>
  <testcase name="cleanup-failure" time="0.1" classname="test" file="fixture" failure="Outcome case did not pass"><failure type="testCodeFailure" message="Outcome case did not pass">fixed</failure></testcase>
  <!-- tests 3 --><!-- suites 0 --><!-- pass 1 --><!-- fail 2 --><!-- cancelled 0 --><!-- skipped 0 --><!-- todo 0 -->
</testsuites>`;

test('node runner qualification rejects missing, extra, skipped and wrong native controls', async () => {
  const { validateNodeOutcomeArtifacts } = await import('./cli-outcome-node-acceptance.mjs');
  const sidecar = {
    schemaVersion: 1,
    productVersion: '1.9.0',
    runtime: process.version,
    cases: [
      { name: 'pass', passing: true },
      { name: 'ignored', passing: false },
      { name: 'cleanup-failure', passing: false },
    ],
  };
  const junit = nodeOutcomeJunit;
  assert.equal(validateNodeOutcomeArtifacts({ sidecar, junit, expectedVersion: '1.9.0' }).failed, 2);
  for (const changed of [
    junit.replace('<!-- cancelled 0 -->', '<!-- cancelled 1 -->'),
    junit.replace('<!-- skipped 0 -->', '<!-- skipped 1 -->'),
    junit.replace('</testsuites>', '<testcase name="extra"/></testsuites>'),
    junit.replace('name="ignored"', 'name="renamed"'),
    junit.replace('<!-- fail 2 -->', '<!-- fail 1 -->'),
    junit
      .replace(
        '<testcase name="pass" time="0.1" classname="test" file="fixture"/>',
        '<testcase name="pass" failure="Outcome case did not pass"><failure type="testCodeFailure" message="Outcome case did not pass">fixed</failure></testcase>'
      )
      .replace(
        '<testcase name="ignored" time="0.1" classname="test" file="fixture" failure="Outcome case did not pass"><failure type="testCodeFailure" message="Outcome case did not pass">fixed</failure></testcase>',
        '<testcase name="ignored"/>'
      ),
  ]) {
    assert.throws(
      () => validateNodeOutcomeArtifacts({ sidecar, junit: changed, expectedVersion: '1.9.0' }),
      /Node test qualification failed/
    );
  }
  assert.throws(
    () => validateNodeOutcomeArtifacts({ sidecar: undefined, junit, expectedVersion: '1.9.0' }),
    /Node test qualification failed/
  );
});

test('node runner qualification invokes one process and always removes private transport', async () => {
  const { qualifyCliOutcomeWithNodeTest } = await import('./cli-outcome-node-acceptance.mjs');
  const directory = await mkdtemp(join(tmpdir(), 'agentbrowser-node-qualification-test-'));
  let calls = 0;
  let privateDirectory;
  try {
    const result = await qualifyCliOutcomeWithNodeTest(
      nodeOutcomeResult(),
      { directory, env: { PATH: process.env.PATH }, expectedVersion: '1.9.0' },
      {
        runner: async (command, options) => {
          calls++;
          assert.equal(options.expectedExitCode, 1);
          const configPath = command.at(-1);
          privateDirectory = dirname(configPath);
          assert.equal((await stat(configPath)).mode & 0o777, 0o600);
          assert.equal((await stat(privateDirectory)).mode & 0o777, 0o700);
          const config = JSON.parse(await readFile(configPath, 'utf8'));
          assert.ok(!JSON.stringify(config).includes('PRIVATE-REPORT-SENTINEL'));
          await writeFile(
            config.resultPath,
            JSON.stringify({
              schemaVersion: 1,
              productVersion: config.expectedVersion,
              runtime: process.version,
              cases: config.cases,
            }),
            { flag: 'wx', mode: 0o600 }
          );
          return {
            code: 1,
            stderr: '',
            stdout: nodeOutcomeJunit,
          };
        },
      }
    );
    assert.equal(calls, 1);
    assert.equal(result.cases.length, 13);
    assert.deepEqual(result.conventionalRunner.counts, { tests: 3, passed: 1, failed: 2, cancelled: 0, skipped: 0 });
    assert.equal(result.conventionalRunner.exitCode, 1);
    assert.ok(!JSON.stringify(result.conventionalRunner).includes('PRIVATE-REPORT-SENTINEL'));
    await assert.rejects(stat(privateDirectory), { code: 'ENOENT' });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('node runner qualification rejects missing sidecars and private runner failures after cleanup', async () => {
  const { qualifyCliOutcomeWithNodeTest } = await import('./cli-outcome-node-acceptance.mjs');
  const directory = await mkdtemp(join(tmpdir(), 'agentbrowser-node-qualification-refusal-'));
  try {
    await assert.rejects(
      qualifyCliOutcomeWithNodeTest(
        nodeOutcomeResult(),
        { directory, env: { PATH: process.env.PATH }, expectedVersion: '1.9.0' },
        { runner: async () => ({ code: 1, stdout: nodeOutcomeJunit, stderr: '' }) }
      ),
      /Node test qualification failed/
    );
    assert.deepEqual(await readdir(directory), []);

    let failure;
    await assert.rejects(
      qualifyCliOutcomeWithNodeTest(
        nodeOutcomeResult(),
        { directory, env: { PATH: process.env.PATH }, expectedVersion: '1.9.0' },
        { runner: async () => { throw new Error('PRIVATE-RUNNER-SENTINEL'); } }
      ),
      (error) => {
        failure = error;
        return true;
      }
    );
    assert.match(failure.message, /Node test qualification failed/);
    assert.doesNotMatch(failure.stack, /PRIVATE-RUNNER-SENTINEL/);
    assert.deepEqual(await readdir(directory), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('node runner qualification exercises the native JUnit reporter without private report data', async () => {
  const { qualifyCliOutcomeWithNodeTest } = await import('./cli-outcome-node-acceptance.mjs');
  const directory = await mkdtemp(join(tmpdir(), 'agentbrowser-node-qualification-native-'));
  try {
    const result = await qualifyCliOutcomeWithNodeTest(nodeOutcomeResult(), {
      directory,
      env: { PATH: process.env.PATH, LANG: 'C' },
      expectedVersion: '1.9.0',
    });
    assert.equal(result.conventionalRunner.reporter, 'junit');
    assert.match(result.conventionalRunner.runtime, /^v\d+\./);
    assert.ok(result.conventionalRunner.artifact.sizeBytes > 0);
    assert.ok(result.conventionalRunner.artifact.sizeBytes <= 64 * 1024);
    assert.deepEqual(
      Object.keys(result.conventionalRunner.artifact).sort(),
      ['mediaType', 'sha256', 'sizeBytes']
    );
    assert.equal(result.conventionalRunner.artifact.mediaType, 'application/xml');
    assert.match(result.conventionalRunner.artifact.sha256, /^[a-f0-9]{64}$/);
    assert.ok(!JSON.stringify(result.conventionalRunner).includes('PRIVATE-REPORT-SENTINEL'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('shared native JUnit checker preserves fixed case identities and exact digest diagnostics', async () => {
  const { validateNativeNodeReport } = await import('./node-junit-report.mjs');
  const cases = [{ name: 'live recipe', passing: false }];
  const diagnostic = `Private evaluation artifact: sha256:${'a'.repeat(64)}`;
  const junit = `<?xml version="1.0" encoding="utf-8"?>
<testsuites><testcase name="live recipe"><failure type="testCodeFailure" message="Recipe failed">fixed</failure></testcase>
<!-- ${diagnostic} -->
<!-- tests 1 --><!-- suites 0 --><!-- pass 0 --><!-- fail 1 -->
<!-- cancelled 0 --><!-- skipped 0 --><!-- todo 0 --></testsuites>`;
  const expected = { cases, failureMessage: 'Recipe failed', diagnostic };
  assert.deepEqual(validateNativeNodeReport(junit, expected), {
    tests: 1, passed: 0, failed: 1, cancelled: 0, skipped: 0,
  });
  for (const changed of [
    junit.replace('name="live recipe"', 'name="wrong recipe"'),
    junit.replace('type="testCodeFailure"', 'type="hookFailed"'),
    junit.replace('message="Recipe failed"', 'message="Other failure"'),
    junit.replace('<!-- skipped 0 -->', '<!-- skipped 1 -->'),
    junit.replace('<!-- cancelled 0 -->', '<!-- cancelled 1 -->'),
    junit.replace('<!-- tests 1 -->', '<!-- tests 0 -->'),
    junit.replace('<!-- todo 0 -->', '<!-- todo 1 -->'),
    junit.replace('</failure>', ''),
    junit.replace('name="live recipe"', 'name="live recipe" name="other"'),
    junit.replace('<testsuites>', '<!DOCTYPE testsuites><testsuites>'),
    junit.replace('<failure ', '<error '),
    junit.replace('</testsuites>', '<testcase name="extra"/></testsuites>'),
    junit.replace(`<!-- ${diagnostic} -->`, ''),
    junit.replace(`<!-- ${diagnostic} -->`, `<!-- ${diagnostic} EXTRA -->`),
    junit.replace(`<!-- ${diagnostic} -->`, `<!-- ${diagnostic} --><!-- ${diagnostic} -->`),
    junit.replace(`<!-- ${diagnostic} -->`, '').replace('>fixed</failure>', `>${diagnostic}</failure>`),
    junit.replace('</testsuites>', ''),
    junit + 'x'.repeat(65537),
  ]) assert.throws(() => validateNativeNodeReport(changed, expected), {
    message: 'Node test qualification failed',
  });
  assert.throws(() => validateNativeNodeReport(junit, {
    ...expected, cases: [{ name: 'live recipe', passing: true }],
  }));
});

test('shared checker qualifies actual native JUnit and fixed digest comments for each recipe case', async () => {
  const { validateNativeNodeReport, summarizeNativeNodeReport } = await import('./node-junit-report.mjs');
  const { APPLICATION_RECIPE_FAILURE, applicationRecipeTestName, createCliEnvironment } =
    await import('../examples/node-test/application-outcome.mjs');
  const { runExecutable } = await import('./release-smoke.mjs');
  const { createHash } = await import('node:crypto');
  for (const name of ['pass', 'broken', 'cleanup-failure']) {
    const passing = name === 'pass';
    const testName = applicationRecipeTestName(name);
    const diagnostic = `Private evaluation artifact: sha256:${'b'.repeat(64)}`;
    const source = `require('node:test')(${JSON.stringify(testName)},t=>{
      t.diagnostic(${JSON.stringify(diagnostic)});
      if(!${passing})throw Error(${JSON.stringify(APPLICATION_RECIPE_FAILURE)});
    });`;
    const output = await runExecutable([process.execPath, '--test-reporter=junit', '-e', source], {
      env: createCliEnvironment(process.env), expectedExitCode: passing ? 0 : 1,
      timeoutMs: 5000, maxOutputBytes: 65536,
    });
    assert.equal(output.stderr, '');
    assert.deepEqual(validateNativeNodeReport(output.stdout, {
      cases: [{ name: testName, passing }], failureMessage: APPLICATION_RECIPE_FAILURE, diagnostic,
    }), { tests: 1, passed: passing ? 1 : 0, failed: passing ? 0 : 1, cancelled: 0, skipped: 0 });
    const { validateApplicationRecipeNativeReport } = await import('./application-recipe-acceptance.mjs');
    assert.equal(validateApplicationRecipeNativeReport({
      name, stdout: output.stdout, stderr: '', digest: 'b'.repeat(64),
    }).counts.failed, passing ? 0 : 1);
    assert.deepEqual(summarizeNativeNodeReport(output.stdout), {
      mediaType: 'application/xml', sizeBytes: Buffer.byteLength(output.stdout),
      sha256: createHash('sha256').update(output.stdout).digest('hex'),
    });
  }
  assert.throws(() => applicationRecipeTestName('PRIVATE_UNKNOWN_CASE'));
});
