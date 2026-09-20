/** Internal reporter fault controls, consuming only fresh, finalized qualification results. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { runAgentCli } from './cli-outcome-acceptance.mjs';

export const NODE_OUTCOME_CONTROLS = Object.freeze([
  Object.freeze({ name: 'pass', passing: true }),
  Object.freeze({ name: 'ignored', passing: false }),
  Object.freeze({ name: 'cleanup-failure', passing: false }),
]);
export const NODE_OUTCOME_FAILURE = 'Outcome case did not pass';
const failure = () => new Error('Node test qualification failed');
const probe = fileURLToPath(new URL('./cli-outcome-node-probe.mjs', import.meta.url));
const MAX_BYTES = 64 * 1024;

/** Strict transport shape; the reporter does not evaluate or certify case truth. */
export function validNodeOutcomeProjection(cases) {
  return Array.isArray(cases) && cases.length === NODE_OUTCOME_CONTROLS.length &&
    cases.every((entry, index) => entry &&
      Object.keys(entry).sort().join(',') === 'name,passing' &&
      entry.name === NODE_OUTCOME_CONTROLS[index].name && typeof entry.passing === 'boolean');
}

/** Narrow qualification of our fixed local Node reporter, not a general XML importer. */
export function validateNodeOutcomeArtifacts({ sidecar, junit, expectedVersion }) {
  try {
    assert.ok(isDeepStrictEqual(sidecar, {
      schemaVersion: 1, productVersion: expectedVersion, runtime: process.version,
      cases: NODE_OUTCOME_CONTROLS,
    }));
    assert.ok(typeof junit === 'string' && Buffer.byteLength(junit) <= MAX_BYTES);
    assert.match(junit, /^<\?xml\b/u);
    assert.equal((junit.match(/<testsuites>/gu) ?? []).length, 1);
    assert.equal((junit.match(/<\/testsuites>/gu) ?? []).length, 1);
    assert.ok(!/<(?:error|skipped)\b|<!DOCTYPE|<!ENTITY/u.test(junit));
    const entries = [...junit.matchAll(/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/gu)];
    assert.equal(entries.length, 3);
    assert.equal((junit.match(/<testcase\b/gu) ?? []).length, 3);
    assert.equal((junit.match(/<failure\b/gu) ?? []).length, 2);
    for (const [index, match] of entries.entries()) {
      const control = NODE_OUTCOME_CONTROLS[index];
      const name = /(?:^|\s)name="([^"]*)"/u.exec(match[1])?.[1];
      assert.equal(name, control.name);
      const failures = [...(match[2] ?? '').matchAll(/<failure\b([^>]*)>/gu)];
      assert.equal(failures.length, control.passing ? 0 : 1);
      if (failures.length) {
        assert.match(failures[0][1], /\btype="testCodeFailure"/u);
        assert.ok(failures[0][1].includes(`message="${NODE_OUTCOME_FAILURE}"`));
      }
    }
    for (const [name, count] of Object.entries({
      tests: 3, suites: 0, pass: 1, fail: 2, cancelled: 0, skipped: 0, todo: 0,
    })) {
      const matches = [...junit.matchAll(new RegExp(`<!--\\s*${name} (\\d+)\\s*-->`, 'gu'))];
      assert.equal(matches.length, 1);
      assert.equal(Number(matches[0][1]), count);
    }
    return { tests: 3, passed: 1, failed: 2, cancelled: 0, skipped: 0 };
  } catch { throw failure(); }
}

/** Called only after the live coordinator has returned; never starts a service/browser. */
export async function qualifyCliOutcomeWithNodeTest(
  result, { directory, env, expectedVersion }, { runner = runAgentCli } = {}
) {
  let transport;
  try {
    assert.equal(result.status, 'pass');
    const cases = NODE_OUTCOME_CONTROLS.map(({ name }) => {
      const matches = result.cases.filter((entry) => entry.name === name);
      assert.equal(matches.length, 1);
      return { name, passing: matches[0].passing };
    });
    assert.ok(validNodeOutcomeProjection(cases));
    transport = await mkdtemp(join(directory, 'node-outcome-'));
    const configPath = join(transport, 'config.json');
    const resultPath = join(transport, 'result.json');
    await writeFile(configPath, JSON.stringify({ expectedVersion, resultPath, cases }), {
      flag: 'wx', mode: 0o600,
    });
    const output = await runner([
      process.execPath, '--test-reporter=junit', probe, configPath,
    ], { cwd: directory, env, expectedExitCode: 1, timeoutMs: 20_000, maxOutputBytes: MAX_BYTES });
    assert.equal(output.code, 1);
    assert.equal(output.stderr, '');
    const bytes = await readFile(resultPath);
    assert.ok(bytes.length <= MAX_BYTES);
    const sidecar = JSON.parse(bytes.toString('utf8'));
    const counts = validateNodeOutcomeArtifacts({ sidecar, junit: output.stdout, expectedVersion });
    return {
      ...result,
      conventionalRunner: {
        purpose: 'failure-propagation-controls',
        liveExecutionOwner: 'package-acceptance',
        reporter: 'junit', runtime: sidecar.runtime, exitCode: output.code, counts,
        cases,
        artifact: {
          mediaType: 'application/xml', sizeBytes: Buffer.byteLength(output.stdout),
          sha256: createHash('sha256').update(output.stdout).digest('hex'),
        },
      },
    };
  } catch { throw failure(); }
  finally {
    if (transport) {
      try { await rm(transport, { recursive: true, force: true }); }
      catch { throw failure(); }
    }
  }
}
