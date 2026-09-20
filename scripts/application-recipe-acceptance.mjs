/** Qualify the standalone Node recipe against the already-running composed host. */
import assert from 'node:assert/strict';
import { readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  counterDescriptor,
  createCliEnvironment,
  readJson,
} from '../examples/node-test/application-outcome.mjs';
import { runExecutable } from './release-smoke.mjs';

const recipeScript = fileURLToPath(
  new URL('../examples/node-test/application-outcome.mjs', import.meta.url)
);
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

async function readPrivateReport(path) {
  const metadata = await stat(path);
  assert.ok(metadata.isFile(), 'Application recipe report is not a file');
  assert.ok(
    metadata.size > 0 && metadata.size <= 64 * 1024,
    'Application recipe report is invalid'
  );
  if (process.platform !== 'win32')
    assert.equal(metadata.mode & 0o077, 0, 'Application recipe report is not private');
  return JSON.parse(await readFile(path, 'utf8'));
}

export async function runNodeRecipe({ configPath, env, expectedExitCode, proc }) {
  let child;
  let escalation;
  const abort = () => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    child.kill('SIGTERM');
    escalation ??= setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }, 1000);
    escalation.unref?.();
  };
  let execution;
  try {
    proc.signal.throwIfAborted();
    execution = runExecutable([process.execPath, recipeScript, configPath], {
      env,
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
  assert.ok(proc?.rpc && proc?.guard && proc?.signal, 'Managed composed host is required');
  assert.ok(Array.isArray(cli) && cli.length > 0, 'Installed CLI command is required');
  assert.deepEqual(fixture, { id: 'fixture-counter', version: '1' });
  const staged = [];
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
      await writeFile(configPath, `${JSON.stringify(config)}\n`, { flag: 'wx', mode: 0o600 });
      const recipeEnv = {
        ...createCliEnvironment(env),
        AGENTBROWSER_RECIPE_OPERATOR_KEY: key,
      };
      const processResult = await runNodeRecipe({
        configPath,
        env: recipeEnv,
        expectedExitCode: definition.exitCode,
        proc,
      });
      assert.ok(
        !`${processResult.stdout}${processResult.stderr}`.includes(key),
        'Application recipe exposed its operator credential'
      );
      const evaluation = await readPrivateReport(reportPath);
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
      staged.push({ ...result, sessionCleanup: 'verified' });
    } finally {
      await rm(configPath, { force: true });
      await rm(reportPath, { force: true });
      if (url !== undefined) {
        await proc.rpc('closeFixture', { name: definition.resource });
        const closed = await proc.rpc('fixtureState', { name: definition.resource });
        assert.equal(closed.closed, true, 'Application recipe fixture remained open');
      }
    }
  }
  return {
    cases: staged,
    nodeTestCalls: staged.length,
    cliDiscoveryCalls: staged.length * 2,
    cliOutcomeCalls: staged.length,
    cliEvaluationCalls: staged.length,
    additionalBrowserCases: staged.length,
    additionalServiceHostStarts: 0,
    modelCalls: 0,
    mcpCalls: 0,
  };
}
