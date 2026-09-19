/** Real installed CLI -> packaged service -> controlled UI handler -> scoped receipt. */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runExecutable } from './release-smoke.mjs';

/** Agent processes inherit runtime essentials, never the operator/server environment. */
export function runAgentCli(command, { env, token, ...options }) {
  const allowed = new Set([
    'PATH',
    'PATHEXT',
    'SYSTEMROOT',
    'WINDIR',
    'COMSPEC',
    'TMPDIR',
    'TMP',
    'TEMP',
    'LANG',
    'LC_ALL',
    'LC_CTYPE',
    'SSL_CERT_FILE',
    'SSL_CERT_DIR',
    'NODE_EXTRA_CA_CERTS',
  ]);
  const isolated = Object.fromEntries(
    Object.entries(env).filter(
      ([name, value]) => allowed.has(name.toUpperCase()) && typeof value === 'string'
    )
  );
  if (token !== undefined) isolated.AGENTBROWSER_API_KEY = token;
  return runExecutable(command, { ...options, env: isolated });
}

const childScript = fileURLToPath(new URL('./cli-outcome-child.mjs', import.meta.url));
const cases = [
  'pass',
  'pass-repeat',
  'lost-response',
  'historical',
  'ignored',
  'failed-action',
  'stale',
  'wrong-resource',
  'api-shortcut',
  'required-skip',
  'partial-setup',
  'cleanup-failure',
];

// The assertion builder receives only the frozen page/command context. Operator
// credentials, fixture readers and lifecycle ownership stay in the adapter below.
function counterAssertion(context) {
  return {
    actions: [{ action: 'click', target: { ref: context.targetRef } }],
    verification: {
      verifier: { id: 'fixture.ui-commit', version: '1' },
      input: context.command,
      evidenceCorrelationId: context.businessCorrelationId,
    },
  };
}

// Inject the existing lifecycle/HTTP helpers to avoid a circular entrypoint import.
export async function checkCliApplicationOutcome(
  options,
  { withManagedChild, apiRequest, waitFor }
) {
  const { modules, expectedVersion, cli, directory, env } = options;
  assert.ok(modules.control && modules.protocol, 'Audited packaged outcome modules are required');
  const { createTestCaseRunContract } = await import(pathToFileURL(modules.protocol));
  assert.equal(
    typeof createTestCaseRunContract,
    'function',
    'Packaged regression contract is required'
  );
  const descriptor = {
    id: 'counter.ui-add',
    version: '1',
    testedSeam: 'ui',
    environment: {
      productVersion: expectedVersion,
      cliVersion: expectedVersion,
      engine: { name: 'playwright-chromium', version: '1.0.0' },
      fixture: { id: 'fixture-counter', version: '1' },
    },
    assertions: [{ id: 'save', required: true }],
  };
  const key = randomBytes(24).toString('hex');
  const results = [];
  const eventIds = new Set();
  const injectedSetupFailure = new Error('INJECTED_SETUP_FAILURE');
  const injectedCleanupFailure = new Error('INJECTED_CLEANUP_FAILURE');
  await withManagedChild(
    [
      process.execPath,
      childScript,
      modules.root,
      expectedVersion,
      modules.commit,
      modules.dirty ? 'allow-dirty' : 'clean',
    ],
    { env: { ...env, AGENTBROWSER_API_KEY: key } },
    async (proc) => {
      const ready = await proc.message();
      assert.equal(ready.kind, 'ready');
      assert.deepEqual(ready.modules, modules, 'CLI host must use the audited extracted package');
      const request = (path, args = {}) =>
        proc.guard(apiRequest(ready.baseUrl, path, { key, signal: proc.signal, ...args }));
      const invoke = async (args, token, payload, expectedExitCode = 0) => {
        let child;
        const abort = () => child?.kill('SIGTERM');
        try {
          proc.signal.throwIfAborted();
          return await proc.guard(
            runAgentCli([...cli, '--base-url', ready.baseUrl, '--json', ...args], {
              cwd: directory,
              env,
              token,
              ...(payload !== undefined ? { stdin: JSON.stringify(payload) } : {}),
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
      // Observe each surface independently; never fill report fields from pins.
      const discovery = JSON.parse((await invoke(['describe', 'outcome', '--schema'])).stdout);
      const cliVersion = (await invoke(['--version'])).stdout.trim();
      const health = await request('/health');
      const engine = await request('/health/ready');
      assert.equal(discovery.productVersion, cliVersion);
      assert.equal(cliVersion, health.version);
      const environment = {
        productVersion: health.version,
        cliVersion,
        engine: { name: engine.engine, version: engine.version },
        fixture: ready.fixture,
      };
      assert.deepEqual(environment, descriptor.environment, 'Observed fixture environment drift');
      const sessions = new Set();
      const fixtures = new Map();
      const closedFixtures = new Set();
      const closeSession = async (id) => {
        const base = `/v1/sessions/${id}`;
        await request(base, { method: 'DELETE', statuses: [200, 404] });
        await request(base, { statuses: [404] });
        await request(`${base}/application`, { statuses: [404] });
        sessions.delete(id);
      };
      const closeFixture = async (name) => {
        const url = fixtures.get(name);
        await proc.rpc('closeFixture', { name });
        const closed = await proc.rpc('fixtureState', { name });
        assert.equal(closed.closed, true);
        await assert.rejects(
          fetch(url, { signal: AbortSignal.timeout(1000) }),
          (error) => error.cause?.code === 'ECONNREFUSED',
          'Fixture listener must be closed'
        );
        fixtures.delete(name);
        closedFixtures.add(name);
      };
      let firstFailure;
      try {
        for (const name of cases) {
          let session;
          let setup = 'failed';
          let cleanup = 'unknown';
          let assertion = { id: 'save', status: 'skipped', reasonCode: 'PRECONDITION_UNAVAILABLE' };
          const invocations = [];
          const outerId = `cli-outcome-${name}`;
          const positive = ['pass', 'pass-repeat', 'lost-response', 'cleanup-failure'].includes(
            name
          );
          const denied = ['historical', 'wrong-resource', 'api-shortcut'].includes(name);
          let execution;
          let verification;
          let replay;
          let oracle;
          let caseError;
          let observedEnvironment = environment;
          const otherResource =
            name === 'wrong-resource' ? await proc.rpc('oracle', { name: 'pass' }) : undefined;
          try {
            const { url } = await proc.rpc('fixture', { name });
            fixtures.set(name, url); // acquire first, register immediately, even if setup fails
            session = await request('/v1/sessions', {
              method: 'POST',
              body: { controlMode: 'delegated' },
            });
            sessions.add(session.sessionId);
            observedEnvironment = { ...environment, engine: session.engine };
            const base = `/v1/sessions/${session.sessionId}`;
            await request(`${base}/application`, {
              method: 'PUT',
              body: { adapter: 'fixture-counter', resource: name },
            });
            assert.equal((await request(`${base}/application`)).resource, name);
            if (name === 'partial-setup') throw injectedSetupFailure;
            if (name === 'required-skip') {
              setup = 'completed';
              await request(`${base}/operations/${outerId}`, { statuses: [404] });
              oracle = await proc.rpc('oracle', { name });
              assert.deepEqual(oracle.snapshot, { version: 0, total: 0 });
              assert.equal(oracle.reserved, false);
              for (const counter of ['claims', 'reads', 'actions', 'shortcuts'])
                assert.equal(oracle[counter], 0);
              assert.equal(oracle.receipt, null);
            } else {
              const reserved = await request(`${base}/application/execute`, {
                method: 'POST',
                body: { operation: 'reserve', input: {} },
              });
              assert.equal(reserved.status, 'read');
              const intent = reserved.value;
              if (name === 'historical' || name === 'api-shortcut') {
                const shortcutId =
                  name === 'historical' ? intent.command.operationId : `operator-shortcut-${name}`;
                if (name === 'api-shortcut')
                  assert.notEqual(shortcutId, intent.command.operationId);
                const shortcut = await request(`${base}/application/execute`, {
                  method: 'POST',
                  body: {
                    operation: 'shortcut',
                    input: intent.command,
                    operationId: shortcutId,
                    expectedVersion: intent.command.expectedVersion,
                  },
                });
                assert.equal(shortcut.status, 'committed');
                assert.equal(shortcut.value.operationId, shortcutId);
                assert.equal(shortcut.value.total, 2);
              }
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
              if (name === 'wrong-resource')
                await request(`${base}/application`, {
                  method: 'PUT',
                  body: { adapter: 'fixture-counter', resource: 'pass' },
                });
              const review = await request(`${base}/control/prepare-resume`, { method: 'POST' });
              const grant = await request(`${base}/control/delegate`, {
                method: 'POST',
                body: { epoch: review.epoch, mode: 'qa' },
              });
              // A QA grant cannot bypass the UI through raw application routes.
              await request(`${base}/application/execute`, {
                key: grant.token,
                method: 'POST',
                statuses: [403],
                body: {
                  operation: 'shortcut',
                  input: intent.command,
                  operationId: `denied-shortcut-${name}`,
                  expectedVersion: intent.command.expectedVersion,
                },
              });
              await request(`${base}/application/receipts/${intent.command.operationId}`, {
                key: grant.token,
                statuses: [403],
              });
              setup = 'completed';
              const context = Object.freeze({
                sessionId: session.sessionId,
                pageId: page.pageId,
                targetRef: name === 'failed-action' ? 'e999999_999' : button.ref,
                command: Object.freeze({ ...intent.command }),
                businessCorrelationId: intent.command.operationId,
              });
              const payload = counterAssertion(context);
              assert.notEqual(outerId, context.businessCorrelationId);
              invocations.push({ id: 'save', operationId: outerId, request: payload });
              const args = [
                '--operation-id',
                outerId,
                'outcome',
                context.sessionId,
                context.pageId,
                '-',
              ];
              const first = await invoke(args, grant.token, payload, positive ? 0 : 1);
              assert.equal(first.stderr, '', `${name}: no diagnostics for canonical reports`);
              const report = JSON.parse(first.stdout);
              const { outcome } = report;
              assertion = { id: 'save', status: 'completed', operationId: outerId, report };
              ({ execution, verification } = {
                execution: outcome.execution,
                verification: outcome.verification.status,
              });
              assert.equal(verification === 'passed', positive, `${name}: canonical outcome`);
              assert.equal(outcome.availability, denied ? 'blocked' : 'available');
              assert.equal(outcome.cleanup, 'not_needed');
              if (positive) assert.equal(execution, 'completed');
              else {
                assert.deepEqual(outcome.verification.evidenceRefIds, []);
                if (denied) assert.equal(execution, 'not_started');
                else if (name === 'failed-action') assert.notEqual(execution, 'completed');
                else assert.equal(execution, 'completed');
              }
              oracle = await proc.rpc('oracle', { name });
              assert.equal(oracle.claims, denied ? 0 : 1, `${name}: admitted claims`);
              assert.equal(oracle.actions, denied || name === 'failed-action' ? 0 : 1, `${name}: independent action dispatch`);
              assert.equal(
                oracle.shortcuts,
                name === 'historical' || name === 'api-shortcut' ? 1 : 0
              );
              if (name === 'historical') {
                assert.deepEqual(oracle.genericReceipt, { ...intent.command, version: 1, total: 2 });
              }
              if (name === 'api-shortcut') assert.equal(oracle.genericReceipt, null);
              if (denied || name === 'failed-action') assert.equal(oracle.reads, 0);
              else assert.ok(oracle.reads > 0 && oracle.reads <= 20);
              assert.deepEqual(
                oracle.snapshot,
                positive || name === 'historical' || name === 'api-shortcut'
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
                assert.ok(
                  !eventIds.has(oracle.receipt.eventId),
                  'Fresh sessions must emit distinct events'
                );
                eventIds.add(oracle.receipt.eventId);
              } else assert.equal(oracle.receipt, null, `${name}: no UI commit evidence`);
              const recorded = await request(`${base}/operations/${outerId}`);
              const repeated = await invoke(args, grant.token, payload, 1);
              assert.equal(repeated.stdout, '');
              assert.match(repeated.stderr, /OPERATION_RECORDED/u);
              assert.deepEqual(await request(`${base}/operations/${outerId}`), recorded);
              assert.deepEqual(
                await proc.rpc('oracle', { name }),
                oracle,
                `${name}: no replay effects or I/O`
              );
              replay = 'recorded_without_dispatch';
            }
            if (otherResource)
              assert.deepEqual(await proc.rpc('oracle', { name: 'pass' }), otherResource);
          } catch (error) {
            if (name !== 'partial-setup' || error !== injectedSetupFailure) caseError = error;
            else {
              oracle = await proc.rpc('oracle', { name });
              assert.deepEqual(oracle.snapshot, { version: 0, total: 0 });
              for (const counter of ['claims', 'reads', 'actions', 'shortcuts'])
                assert.equal(oracle[counter], 0);
              await request(`/v1/sessions/${session.sessionId}/operations/${outerId}`, {
                statuses: [404],
              });
            }
          }
          try {
            if (name === 'partial-setup') {
              assert.ok(
                sessions.has(session.sessionId),
                'Partial acquisition must reach outer finalizer'
              );
              assert.ok(fixtures.has(name));
            } else {
              if (name === 'cleanup-failure') await Promise.reject(injectedCleanupFailure);
              if (session) await closeSession(session.sessionId);
              cleanup = 'complete';
            }
          } catch (error) {
            cleanup = 'failed';
            if (error !== injectedCleanupFailure) caseError ??= error;
          }
          if (caseError) throw caseError;
          const contract = createTestCaseRunContract(descriptor, invocations);
          const report = contract.parse({
            case: { id: descriptor.id, version: descriptor.version },
            environment: observedEnvironment,
            setup,
            assertions: [assertion],
            cleanup,
          });
          const passing = contract.isPassing(report);
          assert.equal(
            passing,
            ['pass', 'pass-repeat', 'lost-response'].includes(name),
            `${name}: bound verdict`
          );
          if (name === 'cleanup-failure')
            assert.equal(report.assertions[0].report.outcome.verification.evidenceRefIds.length, 1);
          results.push({
            name,
            passing,
            report,
            reportBytes: Buffer.byteLength(JSON.stringify(report)),
            ...(execution ? { execution, verification, replay } : {}),
            cliAssertionCalls: invocations.length,
            cliReplayCalls: invocations.length,
            oracle: {
              actions: oracle.actions,
              claims: oracle.claims,
              reads: oracle.reads,
              shortcuts: oracle.shortcuts,
            },
          });
        }
      } catch (error) {
        firstFailure = error;
      } finally {
        // Fallback cleanup is mandatory even after partial setup, assertion failure
        // or rejected case cleanup. A later finalizer error cannot leave a PASS.
        const fallbackSessionCount = sessions.size;
        const finalizers = await Promise.allSettled([...sessions].map(closeSession));
        // The existing managed-child RPC channel permits one outstanding receive.
        // Settle every fixture serially, even if an earlier close fails.
        for (const name of [...fixtures.keys()]) {
          try { await closeFixture(name); }
          catch (reason) { finalizers.push({ status: 'rejected', reason }); }
        }
        if (firstFailure) throw firstFailure;
        const failed = finalizers.find((entry) => entry.status === 'rejected');
        if (failed) throw failed.reason;
        assert.equal(
          fallbackSessionCount,
          2,
          'Partial setup and failed cleanup retain their sessions'
        );
        assert.equal(sessions.size, 0);
        assert.equal(fixtures.size, 0);
        assert.equal(closedFixtures.size, cases.length);
      }
    }
  );
  return {
    check: 'packaged-cli-application-outcome',
    status: 'pass',
    cases: results,
    cliDiscoveryCalls: 2,
    modelCalls: 0,
    mcpCalls: 0,
    cleanup: 'case resources and outer process finalizer verified',
    limits:
      'G4 controlled fixture, exclusive UI actor; no production causal source or G6 qualification',
  };
}
