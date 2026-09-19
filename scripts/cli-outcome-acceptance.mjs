/** Real installed CLI -> packaged service -> controlled UI handler -> scoped receipt. */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { runExecutable } from './release-smoke.mjs';

const childScript = fileURLToPath(new URL('./cli-outcome-child.mjs', import.meta.url));
const cases = [
  'pass',
  'lost-response',
  'historical',
  'ignored',
  'failed-action',
  'stale',
  'wrong-resource',
];

// Inject the existing lifecycle/HTTP helpers to avoid a circular entrypoint import.
export async function checkCliApplicationOutcome(
  options,
  { withManagedChild, apiRequest, waitFor }
) {
  const { modules, expectedVersion, cli, directory, env } = options;
  assert.ok(modules.control, 'Packaged outcome control module is required');
  const key = randomBytes(24).toString('hex');
  const results = [];
  await withManagedChild(
    [
      process.execPath,
      childScript,
      modules.root,
      expectedVersion,
      modules.commit,
      modules.dirty ? 'allow-dirty' : 'clean',
    ],
    {
      env: { ...env, AGENTBROWSER_API_KEY: key },
    },
    async (proc) => {
      const ready = await proc.message();
      assert.equal(ready.kind, 'ready');
      assert.deepEqual(ready.modules, modules, 'CLI host must use the audited extracted package');
      const request = (path, args = {}) =>
        proc.guard(apiRequest(ready.baseUrl, path, { key, signal: proc.signal, ...args }));
      const invoke = async (args, token, payload, expectedExitCode) => {
        let child;
        const abort = () => child?.kill('SIGTERM');
        try {
          proc.signal.throwIfAborted();
          return await proc.guard(
            runExecutable([...cli, '--base-url', ready.baseUrl, '--json', ...args], {
              cwd: directory,
              env: { ...env, AGENTBROWSER_API_KEY: token },
              stdin: JSON.stringify(payload),
              expectedExitCode,
              onSpawn(value) {
                child = value;
                proc.signal.addEventListener('abort', abort, { once: true });
                if (proc.signal.aborted) abort();
              },
            })
          );
        } finally {
          proc.signal.removeEventListener('abort', abort);
        }
      };
      for (const name of cases) {
        const otherResource =
          name === 'wrong-resource' ? await proc.rpc('oracle', { name: 'pass' }) : undefined;
        const { url } = await proc.rpc('fixture', { name });
        const session = await request('/v1/sessions', {
          method: 'POST',
          body: { controlMode: 'delegated' },
        });
        assert.equal(session.engine?.name, 'playwright-chromium');
        const base = `/v1/sessions/${session.sessionId}`;
        try {
          await request(`${base}/application`, {
            method: 'PUT',
            body: { adapter: 'fixture-counter', resource: name },
          });
          const reserved = await request(`${base}/application/execute`, {
            method: 'POST',
            body: { operation: 'reserve', input: {} },
          });
          assert.equal(reserved.status, 'read');
          const intent = reserved.value;
          const page = await request(`${base}/pages`, {
            method: 'POST',
            operationId: `page-${name}`,
            body: {},
          });
          const pagePath = `${base}/pages/${page.pageId}`;
          await request(`${pagePath}/navigate`, {
            method: 'POST',
            operationId: `navigate-${name}`,
            body: { url },
          });
          let button;
          await waitFor(
            async () => {
              const snapshot = await request(`${pagePath}/snapshot`);
              button = snapshot.fields.find(
                (field) => field.role === 'button' && field.label === 'Add' && !field.disabled
              );
              return !!button;
            },
            proc.guard,
            'Reserved form readiness'
          );
          if (name === 'wrong-resource') {
            await request(`${base}/application`, {
              method: 'PUT',
              body: { adapter: 'fixture-counter', resource: 'pass' },
            });
          }
          const review = await request(`${base}/control/prepare-resume`, { method: 'POST' });
          const grant = await request(`${base}/control/delegate`, {
            method: 'POST',
            body: { epoch: review.epoch, mode: 'qa' },
          });
          const payload = {
            actions: [
              {
                action: 'click',
                target: { ref: name === 'failed-action' ? 'e999999_999' : button.ref },
              },
            ],
            verification: {
              verifier: { id: 'fixture.ui-commit', version: '1' },
              input: intent.command,
              evidenceCorrelationId: intent.command.operationId,
            },
          };
          const outerId = `cli-outcome-${name}`;
          assert.notEqual(outerId, intent.command.operationId);
          const args = ['--operation-id', outerId, 'outcome', session.sessionId, page.pageId, '-'];
          const positive = name === 'pass' || name === 'lost-response';
          const first = await invoke(args, grant.token, payload, positive ? 0 : 1);
          assert.equal(first.stderr, '', `${name}: no CLI diagnostics for canonical reports`);
          const { outcome } = JSON.parse(first.stdout);
          assert.equal(
            outcome.verification.status === 'passed',
            positive,
            `${name}: canonical outcome`
          );
          const denied = name === 'historical' || name === 'wrong-resource';
          assert.equal(outcome.availability, denied ? 'blocked' : 'available');
          assert.equal(outcome.cleanup, 'not_needed');
          if (positive) {
            assert.equal(outcome.execution, 'completed');
          } else {
            assert.deepEqual(outcome.verification.evidenceRefIds, []);
            if (name === 'historical' || name === 'wrong-resource')
              assert.equal(outcome.execution, 'not_started');
            if (name === 'ignored' || name === 'stale')
              assert.equal(outcome.execution, 'completed');
            if (name === 'failed-action') assert.notEqual(outcome.execution, 'completed');
          }
          const oracle = await proc.rpc('oracle', { name });
          assert.equal(oracle.claims, denied ? 0 : 1, `${name}: admitted claims`);
          if (denied || name === 'failed-action') assert.equal(oracle.reads, 0);
          else assert.ok(oracle.reads > 0 && oracle.reads <= 20);
          assert.deepEqual(
            oracle.snapshot,
            positive || name === 'historical'
              ? { version: 1, total: 2 }
              : name === 'stale'
                ? { version: 1, total: 1 }
                : { version: 0, total: 0 },
            `${name}: independent backend state`
          );
          if (positive) {
            assert.equal(oracle.receipt.channel, 'reserved_ui');
            assert.deepEqual(outcome.verification.evidenceRefIds, [
              `fixture-ui-event-${oracle.receipt.eventId}`,
            ]);
            assert.deepEqual(oracle.receipt.scope, intent.scope);
            for (const [key, value] of Object.entries(intent.command))
              assert.equal(oracle.receipt[key], value);
            assert.match(oracle.receipt.eventId, /^[a-f0-9-]{36}$/u);
          } else assert.equal(oracle.receipt, null, `${name}: no UI commit evidence`);
          const recorded = await request(`${base}/operations/${outerId}`);
          const replay = await invoke(args, grant.token, payload, 1);
          assert.equal(replay.stdout, '', `${name}: replay must not claim a fresh CLI outcome`);
          assert.match(replay.stderr, /OPERATION_RECORDED/u);
          assert.deepEqual(
            await request(`${base}/operations/${outerId}`),
            recorded,
            `${name}: replay admission`
          );
          assert.deepEqual(
            await proc.rpc('oracle', { name }),
            oracle,
            `${name}: no replay effects, claims or evidence reads`
          );
          if (otherResource)
            assert.deepEqual(
              await proc.rpc('oracle', { name: 'pass' }),
              otherResource,
              'Wrong-resource request and replay preserve the other resource'
            );
          results.push({
            name,
            exitCode: positive ? 0 : 1,
            execution: outcome.execution,
            verification: outcome.verification.status,
            replay: 'recorded_without_dispatch',
          });
        } finally {
          await request(base, { method: 'DELETE', statuses: [200, 404] });
        }
      }
    }
  );
  return {
    check: 'packaged-cli-application-outcome',
    status: 'pass',
    cases: results,
    limits:
      'G4 controlled fixture, exclusive UI actor; no production causal source or G6 qualification',
  };
}
