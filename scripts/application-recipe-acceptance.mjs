/** Qualify the standalone Node recipe against the already-running composed host. */
import assert from 'node:assert/strict';
import { copyFile, chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  APPLICATION_RECIPE_FAILURE,
  applicationRecipeTestName,
  counterDescriptor,
  createCliEnvironment,
  readJson,
} from '../examples/node-test/application-outcome.mjs';
import { cleanupRecipeFiles, readRecipeArtifacts } from '../examples/node-test/report-artifacts.mjs';
import { validateNativeNodeReport, summarizeNativeNodeReport } from './node-junit-report.mjs';
import { runExecutable } from './release-smoke.mjs';

const recipeScript = fileURLToPath(
  new URL('../examples/node-test/application-outcome.mjs', import.meta.url)
);

/** Exercise exactly the documented two-file copy; own and remove all staging. */
export async function withStandaloneRecipe(directory, exercise, { remove = rm } = {}) {
  let root;
  try { root = await mkdtemp(join(directory, 'standalone-recipe-')); }
  catch { throw new Error('Standalone recipe staging failed'); }
  let failed = false;
  try {
    const source = join(root, 'source');
    const cwd = join(root, 'unrelated-cwd');
    try {
      await mkdir(source, { mode: 0o700 });
      await mkdir(cwd, { mode: 0o700 });
      for (const name of ['application-outcome.mjs', 'report-artifacts.mjs']) {
        const target = join(source, name);
        await copyFile(new URL(`../examples/node-test/${name}`, import.meta.url), target);
        await chmod(target, 0o600);
      }
    } catch { throw new Error('Standalone recipe staging failed'); }
    return await exercise({ script: join(source, 'application-outcome.mjs'), cwd });
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    try { await remove(root, { recursive: true, force: true }); }
    catch { throw new Error(failed ? 'Standalone recipe execution and cleanup failed' : 'Standalone recipe cleanup failed'); }
  }
}
const cases = Object.freeze([
  Object.freeze({ name: 'pass', resource: 'recipe-pass', exitCode: 0 }),
  Object.freeze({ name: 'broken', resource: 'recipe-broken', exitCode: 1 }),
  Object.freeze({
    name: 'cleanup-failure',
    resource: 'recipe-cleanup-failure',
    exitCode: 1,
  }),
]);

function expectedCase(name) {
  return {
    verdict: name === 'pass' ? 'passed' : 'failed',
    cleanup: name === 'cleanup-failure' ? 'failed' : 'complete',
    verification: name === 'broken' ? 'unknown' : 'passed',
    snapshot: name === 'broken' ? { version: 0, total: 0 } : { version: 1, total: 2 },
  };
}

/** Bind a native test exit to its canonical evaluation and independent app oracle. */
export function validateApplicationRecipeResult({
  name,
  exitCode,
  evaluation,
  oracle,
  expectedVersion,
}) {
  const definition = cases.find((entry) => entry.name === name);
  assert.ok(definition, 'Unknown application recipe case');
  assert.equal(exitCode, definition.exitCode, 'Application recipe process exit mismatch');
  const expected = expectedCase(name);
  const descriptor = counterDescriptor(expectedVersion);
  assert.equal(evaluation?.schemaVersion, 1);
  assert.equal(evaluation?.provenance, 'caller_observed');
  assert.equal(evaluation?.verdict, expected.verdict);
  assert.deepEqual(evaluation?.descriptor, descriptor);
  assert.equal(evaluation?.report?.setup, 'completed');
  assert.equal(evaluation?.report?.cleanup, expected.cleanup);
  assert.deepEqual(evaluation?.report?.case, {
    id: descriptor.id,
    version: descriptor.version,
  });
  assert.deepEqual(evaluation?.report?.environment, descriptor.environment);
  assert.equal(evaluation?.report?.assertions?.length, 1);
  const assertion = evaluation.report.assertions[0];
  assert.equal(assertion.id, 'save');
  assert.equal(assertion.status, 'completed');
  assert.equal(assertion.report?.outcome?.verification?.status, expected.verification);
  assert.equal(assertion.report.outcome.verification.verifier?.id, 'fixture.ui-commit');
  assert.equal(assertion.report.outcome.verification.verifier?.version, '1');
  assert.equal(assertion.report.outcome.availability, 'available');
  assert.equal(assertion.report.outcome.execution, 'completed');
  assert.equal(assertion.report.outcome.cleanup, 'not_needed');
  assert.equal(assertion.report.outcome.testedSeam, 'ui');
  assert.equal(assertion.report.plan?.ok, true);
  assert.equal(assertion.report.plan?.completed, 1);

  assert.equal(oracle?.closed, false);
  assert.equal(oracle?.reserved, true);
  assert.deepEqual(oracle?.snapshot, expected.snapshot);
  assert.equal(oracle?.claims, 1);
  assert.equal(oracle?.actions, 1);
  assert.equal(oracle?.shortcuts, 0);
  assert.ok(oracle?.reads > 0 && oracle.reads <= 20);
  assert.equal(typeof oracle?.claimSessionId, 'string');
  if (name === 'broken') {
    assert.equal(oracle.genericReceipt, null);
    assert.equal(oracle.receipt, null);
    assert.deepEqual(assertion.report.outcome.verification.evidenceRefIds, []);
  } else {
    assert.equal(oracle.receipt?.channel, 'reserved_ui');
    assert.deepEqual(oracle.genericReceipt, {
      operationId: oracle.receipt.operationId,
      expectedVersion: 0,
      amount: 2,
      version: 1,
      total: 2,
    });
    for (const [key, value] of Object.entries(oracle.genericReceipt))
      assert.equal(oracle.receipt[key], value);
    assert.equal(oracle.receipt.scope?.sessionId, oracle.claimSessionId);
    assert.deepEqual(assertion.report.outcome.verification.evidenceRefIds, [
      `fixture-ui-event-${oracle.receipt.eventId}`,
    ]);
  }
  return {
    name,
    nodeExitCode: exitCode,
    verdict: evaluation.verdict,
    cleanup: evaluation.report.cleanup,
    verification: assertion.report.outcome.verification.status,
    oracle: {
      snapshot: oracle.snapshot,
      actions: oracle.actions,
      claims: oracle.claims,
      reads: oracle.reads,
      shortcuts: oracle.shortcuts,
    },
  };
}

/** Fixed live controls only: reporting supplements the canonical evaluation and oracle. */
export function validateApplicationRecipeNativeReport({ name, stdout, stderr, digest }) {
  try {
    const definition = cases.find((entry) => entry.name === name);
    assert.ok(definition && stderr === '');
    const counts = validateNativeNodeReport(stdout, {
      cases: [{ name: applicationRecipeTestName(name), passing: definition.exitCode === 0 }],
      failureMessage: APPLICATION_RECIPE_FAILURE,
      diagnostic: `Private evaluation artifact: sha256:${digest}`,
    });
    return {
      reporter: 'junit', runtime: process.version, counts,
      artifact: summarizeNativeNodeReport(stdout),
    };
  } catch { throw new Error('Application recipe native report is invalid'); }
}

export async function runNodeRecipe({ configPath, env, expectedExitCode, proc, script = recipeScript, cwd }) {
  let child;
  let escalation;
  let terminationRequested = false;
  const abort = () => {
    if (terminationRequested || !child || child.exitCode !== null || child.signalCode !== null)
      return;
    terminationRequested = true;
    child.kill('SIGTERM');
    escalation ??= setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }, 1000);
    escalation.unref?.();
  };
  let execution;
  try {
    proc.signal.throwIfAborted();
    execution = runExecutable([process.execPath, '--test-reporter=junit', script, configPath], {
      env,
      cwd,
      expectedExitCode,
      timeoutMs: 60_000,
      maxOutputBytes: 64 * 1024,
      onSpawn(value) {
        child = value;
        proc.signal.addEventListener('abort', abort, { once: true });
        if (proc.signal.aborted) abort();
      },
    });
    execution.catch(() => {});
    try {
      return await proc.guard(execution);
    } catch (error) {
      abort();
      try {
        await execution;
      } catch {
        // Preserve the authority/host failure after the owned process drains.
      }
      throw error;
    }
  } finally {
    clearTimeout(escalation);
    proc.signal.removeEventListener('abort', abort);
  }
}

export async function qualifyApplicationRecipe({
  proc,
  cli,
  directory,
  env,
  key,
  baseUrl,
  fixture,
  expectedVersion,
}) {
  const started = performance.now();
  assert.ok(proc?.rpc && proc?.guard && proc?.signal, 'Managed composed host is required');
  assert.ok(Array.isArray(cli) && cli.length > 0, 'Installed CLI command is required');
  assert.deepEqual(fixture, { id: 'fixture-counter', version: '1' });
  const staged = [];
  await withStandaloneRecipe(directory, async ({ script, cwd }) => {
    for (const definition of cases) {
      const configPath = join(directory, `application-recipe-${definition.name}.json`);
      const reportPath = join(directory, `application-recipe-${definition.name}.report.json`);
      let url;
      try {
        ({ url } = await proc.rpc('fixture', { name: definition.resource }));
        const config = {
          caseName: definition.name,
          serviceBaseUrl: baseUrl,
          cli,
          application: {
            adapter: 'fixture-counter',
            resource: definition.resource,
            url,
            fixture,
            verifier: { id: 'fixture.ui-commit', version: '1' },
          },
          expectedVersion,
          reportPath,
        };
        const serializedConfig = `${JSON.stringify(config)}\n`;
        await writeFile(configPath, serializedConfig, { flag: 'wx', mode: 0o600 });
        const recipeEnv = {
          ...createCliEnvironment(env),
          AGENTBROWSER_RECIPE_OPERATOR_KEY: key,
        };
        const processResult = await runNodeRecipe({
          configPath,
          env: recipeEnv,
          expectedExitCode: definition.exitCode,
          proc,
          script,
          cwd,
        });
        assert.ok(
          !`${processResult.stdout}${processResult.stderr}`.includes(key),
          'Application recipe exposed its operator credential'
        );
        const { evaluation, manifest, manifestBytes } = await readRecipeArtifacts(reportPath);
        assert.equal(manifest.oracleMatches, true, 'Application recipe oracle mismatch');
        const nativeReport = validateApplicationRecipeNativeReport({
          name: definition.name, stdout: processResult.stdout, stderr: processResult.stderr,
          digest: manifest.evaluation.sha256,
        });
        for (const privatePath of [configPath, reportPath])
          assert.ok(!`${processResult.stdout}${processResult.stderr}`.includes(privatePath), 'Recipe exposed private path');
        const oracle = await proc.rpc('oracle', { name: definition.resource });
        const result = validateApplicationRecipeResult({
          name: definition.name,
          exitCode: processResult.code,
          evaluation,
          oracle,
          expectedVersion,
        });
        await readJson(`${baseUrl}/v1/sessions/${encodeURIComponent(oracle.claimSessionId)}`, {
          operatorKey: key,
          statuses: [404],
          signal: proc.signal,
        });
        await readJson(
          `${baseUrl}/v1/sessions/${encodeURIComponent(oracle.claimSessionId)}/application`,
          { operatorKey: key, statuses: [404], signal: proc.signal }
        );
        const { href: _href, ...artifact } = manifest.evaluation;
        staged.push({
          ...result, sessionCleanup: 'verified', artifact,
          nativeReport,
          configBytes: Buffer.byteLength(serializedConfig),
          manifestBytes,
        });
      } finally {
        try {
          await cleanupRecipeFiles([configPath, reportPath, `${reportPath}.manifest.json`]);
        } finally {
          if (url !== undefined) {
            await proc.rpc('closeFixture', { name: definition.resource });
            const closed = await proc.rpc('fixtureState', { name: definition.resource });
            assert.equal(closed.closed, true, 'Application recipe fixture remained open');
          }
        }
      }
    }
  });
  return {
    cases: staged,
    standalone: { copiedFiles: 2, unrelatedCwd: true, cleanup: 'verified' },
    measurements: {
      sampleCount: 1,
      elapsedMs: Math.round(performance.now() - started),
      maxConfigBytes: Math.max(...staged.map((entry) => entry.configBytes)),
      maxEvaluationBytes: Math.max(...staged.map((entry) => entry.artifact.sizeBytes)),
      maxManifestBytes: Math.max(...staged.map((entry) => entry.manifestBytes)),
      maxJunitBytes: Math.max(...staged.map((entry) => entry.nativeReport.artifact.sizeBytes)),
      countBasis: 'fixed qualified call paths; excludes browser descendants and executable internals',
    },
    nodeTestCalls: staged.length,
    cliVersionCalls: staged.length,
    cliDiscoveryCalls: staged.length * 2,
    cliOutcomeCalls: staged.length,
    cliEvaluationCalls: staged.length,
    additionalBrowserCases: staged.length,
    additionalServiceHostStarts: 0,
    modelCalls: 0,
    mcpCalls: 0,
  };
}
