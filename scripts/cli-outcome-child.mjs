/** Isolated packaged host for real CLI outcome acceptance. No MCP transport is involved. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { startVersionedApp } from '../packages/testkit/dist/index.js';
import { resolvePackagedModules } from './package-acceptance.mjs';

const modules = await resolvePackagedModules(process.argv[2], process.argv[3], {
  expectedCommit: process.argv[4],
  allowDirty: process.argv[5] === 'allow-dirty',
});
const { applicationReceiptOutcomeOptions, buildServer } = await import(pathToFileURL(modules.api));
const { PlaywrightChromiumEngine } = await import(pathToFileURL(modules.engine));
const { NetworkPolicy } = await import(pathToFileURL(modules.policy));
const { TrustedVerifierRegistry, defineVerifier } = await import(pathToFileURL(modules.control));

const TENANT = 'cli-outcome';
const ADAPTER = 'fixture-counter';
const SOURCE = 'fixture.ui-receipt';
const CAPABILITY = 'fixture.ui-commit';
const VERIFIER = 'fixture.ui-commit';
const VERSION = '1';
const CASES = new Set([
  'pass',
  'pass-repeat',
  'navigation-reset',
  'lost-response',
  'historical',
  'ignored',
  'api-shortcut',
  'required-skip',
  'partial-setup',
  'cleanup-failure',
  'failed-action',
  'stale',
  'wrong-resource',
  'recipe-pass',
  'recipe-broken',
  'recipe-cleanup-failure',
]);
const fixtures = new Map();

function exactObject(value, keys, error) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.keys(value).sort().join(',') !== [...keys].sort().join(',')
  )
    throw new Error(error);
  return value;
}

function counterCommand(value) {
  const command = exactObject(
    value,
    ['operationId', 'expectedVersion', 'amount'],
    'INVALID_COUNTER_COMMAND'
  );
  if (
    typeof command.operationId !== 'string' ||
    !/^[A-Za-z0-9_-]{1,100}$/u.test(command.operationId) ||
    !Number.isSafeInteger(command.expectedVersion) ||
    command.expectedVersion < 0 ||
    !Number.isSafeInteger(command.amount) ||
    command.amount < 1 ||
    command.amount > 100
  )
    throw new Error('INVALID_COUNTER_COMMAND');
  return Object.freeze({
    operationId: command.operationId,
    expectedVersion: command.expectedVersion,
    amount: command.amount,
  });
}

function scopedCounterCommand(value, scope) {
  const command = counterCommand(value);
  if (
    typeof scope.operationId !== 'string' ||
    (scope.resource !== 'historical' && scope.operationId === command.operationId) ||
    scope.expectedVersion !== command.expectedVersion
  )
    throw new Error('INVALID_COUNTER_COMMAND');
  return counterCommand({
    operationId: scope.operationId,
    expectedVersion: scope.expectedVersion,
    amount: command.amount,
  });
}

function counterEvidence(value) {
  const receipt = exactObject(
    value,
    ['operationId', 'expectedVersion', 'amount', 'version', 'total', 'scope', 'channel', 'eventId'],
    'INVALID_COUNTER_EVIDENCE'
  );
  const command = counterCommand({
    operationId: receipt.operationId,
    expectedVersion: receipt.expectedVersion,
    amount: receipt.amount,
  });
  const scope = exactObject(
    receipt.scope,
    ['tenant', 'resource', 'sessionId', 'sessionIncarnation'],
    'INVALID_COUNTER_EVIDENCE'
  );
  if (
    Object.values(scope).some((entry) => typeof entry !== 'string' || entry.length === 0) ||
    receipt.channel !== 'reserved_ui' ||
    typeof receipt.eventId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
      receipt.eventId
    ) ||
    !Number.isSafeInteger(receipt.version) ||
    receipt.version < 1 ||
    !Number.isSafeInteger(receipt.total) ||
    receipt.total < 0
  )
    throw new Error('INVALID_COUNTER_EVIDENCE');
  return Object.freeze({ ...command, version: receipt.version, total: receipt.total });
}

function intentScope(scope) {
  return {
    tenant: scope.tenant,
    resource: scope.resource,
    sessionId: scope.sessionId,
    sessionIncarnation: scope.sessionIncarnation,
  };
}

function requireFixture(name) {
  const fixture = fixtures.get(name);
  if (!fixture) throw new Error('Unknown CLI outcome fixture');
  return fixture;
}

function requireOpenFixture(name) {
  const fixture = requireFixture(name);
  if (fixture.closed) throw new Error('CLI outcome fixture is closed');
  return fixture;
}

function stateOfFixture(name) {
  const fixture = requireFixture(name);
  const receipt = fixture.issued
    ? (fixture.app.intentReceipt(fixture.issued.scope, fixture.issued.command.operationId) ?? null)
    : null;
  const genericReceipt = fixture.issued
    ? (fixture.app.oracle.receipt(fixture.issued.command.operationId) ?? null)
    : null;
  return {
    url: fixture.url,
    closed: fixture.closed,
    reserved: fixture.issued !== undefined,
    snapshot: fixture.app.oracle.snapshot(),
    receipt,
    genericReceipt,
    claims: fixture.claims,
    claimSessionId: fixture.claimScope?.sessionId ?? null,
    reads: fixture.reads,
    actions: fixture.actions,
    shortcuts: fixture.shortcuts,
  };
}

async function closeFixture(name) {
  const fixture = requireFixture(name);
  if (!fixture.closed) {
    await fixture.app.close();
    fixture.closed = true;
  }
  return { closed: true };
}

const verifierRegistry = new TrustedVerifierRegistry([
  defineVerifier({
    descriptor: {
      id: VERIFIER,
      version: VERSION,
      inputSchemaId: 'fixture-counter-command.v1',
      evidenceSchemaId: 'fixture.reserved-ui-receipt.v1',
      requiredCapability: CAPABILITY,
      evidenceSource: SOURCE,
      requiredLayer: 'G4',
      budget: {
        maxReads: 20,
        timeoutMs: 1500,
        pollIntervalMs: 50,
        cleanupTimeoutMs: 100,
        maxEvidenceRefs: 1,
      },
      redaction: 'reference_only',
      unsupported: [],
      cleanup: 'not_needed',
    },
    parseInput: counterCommand,
    parseEvidence: counterEvidence,
    predicate: (command, receipt) =>
      receipt.operationId === command.operationId &&
      receipt.expectedVersion === command.expectedVersion &&
      receipt.amount === command.amount &&
      receipt.version === command.expectedVersion + 1,
  }),
]);

const applicationAdapter = {
  id: ADAPTER,
  authorize: ({ tenant, resource }) =>
    tenant === TENANT && fixtures.has(resource) && !fixtures.get(resource).closed,
  operations: {
    reserve: {
      mode: 'read',
      prepare(input) {
        exactObject(input, [], 'INVALID_RESERVE_INPUT');
        return async (scope) => {
          const fixture = requireOpenFixture(scope.resource);
          const issued = fixture.app.reserveIntent(intentScope(scope), 2);
          fixture.issued = issued;
          return { status: 'read', value: issued };
        };
      },
    },
    shortcut: {
      mode: 'write',
      prepare(input) {
        const command = counterCommand(input);
        return async (scope) => {
          const fixture = requireOpenFixture(scope.resource);
          const scoped = scopedCounterCommand(command, scope);
          if (fixture.app.oracle.snapshot().version !== scoped.expectedVersion)
            return { status: 'rejected', reason: 'stale business version' };
          const receipt = fixture.app.oracle.execute(scoped);
          fixture.shortcuts++;
          return { status: 'committed', value: receipt };
        };
      },
    },
  },
  async receipt(scope, operationId) {
    const fixture = requireOpenFixture(scope.resource);
    fixture.reads++;
    if (operationId !== fixture.issued?.command.operationId)
      return fixture.app.oracle.receipt(operationId);
    return fixture.app.intentReceipt(intentScope(scope), operationId);
  },
};

const apiKey = process.env.AGENTBROWSER_API_KEY;
assert.ok(apiKey, 'AGENTBROWSER_API_KEY is required');
const engine = new PlaywrightChromiumEngine();
const createEngineSession = engine.createSession;
engine.createSession = async function (...args) {
  const session = await Reflect.apply(createEngineSession, this, args);
  const createPage = session.newPage;
  session.newPage = async function (...pageArgs) {
    const page = await Reflect.apply(createPage, this, pageArgs);
    const act = page.act;
    page.act = function (...actionArgs) {
      const url = page.getCachedUrl?.();
      if (url) {
        try {
          const origin = new URL(url).origin;
          for (const fixture of fixtures.values()) {
            if (!fixture.closed && origin === fixture.url) {
              fixture.actions++;
              break;
            }
          }
        } catch {
          // Tracking is diagnostic only; the engine remains the action authority.
        }
      }
      return Reflect.apply(act, this, actionArgs);
    };
    return page;
  };
  return session;
};
const server = await buildServer({
  engine,
  networkPolicy: new NetworkPolicy({
    blockLoopback: false,
    blockPrivateIPs: true,
    blockMetadata: true,
  }),
  apiKeys: new Map([[createHash('sha256').update(apiKey).digest('hex'), TENANT]]),
  ...applicationReceiptOutcomeOptions({
    adapters: [applicationAdapter],
    verifierRegistry,
    verifier: { id: VERIFIER, version: VERSION },
    authorize(request) {
      const { identity, source, verifier, correlationId } = request;
      if (
        source.id !== SOURCE ||
        source.capability !== CAPABILITY ||
        source.authorization !== 'required' ||
        source.correlation !== 'required' ||
        verifier.id !== VERIFIER ||
        verifier.version !== VERSION ||
        identity.admission.actor !== 'agent' ||
        identity.admission.mode !== 'qa' ||
        identity.admission.tenant !== TENANT ||
        identity.adapter !== ADAPTER
      )
        return undefined;
      const fixture = fixtures.get(identity.resource);
      if (!fixture || fixture.closed) return undefined;
      const command = counterCommand(verifier.input);
      if (correlationId !== command.operationId) return undefined;
      fixture.app.claimIntent(
        {
          tenant: identity.admission.tenant,
          resource: identity.resource,
          sessionId: identity.sessionId,
          sessionIncarnation: identity.sessionIncarnation,
        },
        correlationId,
        command
      );
      fixture.claimScope = Object.freeze({ ...identity });
      fixture.claims++;
      if (identity.resource === 'stale') {
        fixture.app.oracle.execute({
          operationId: 'stale-other-writer',
          expectedVersion: 0,
          amount: 1,
        });
      }
      return { generation: 0, currentGeneration: () => 0 };
    },
    evidenceRefs: (receipt) => [`fixture-ui-event-${receipt.eventId}`],
  }),
});
const baseUrl = await server.listen({ port: 0, host: '127.0.0.1' });

let shuttingDown;
function shutdown() {
  shuttingDown ??= (async () => {
    const settled = await Promise.allSettled([
      server.close(),
      ...[...fixtures.keys()].map((name) => closeFixture(name)),
    ]);
    const rejected = settled.find((entry) => entry.status === 'rejected');
    if (rejected) throw rejected.reason;
    if (process.connected) process.disconnect();
  })().catch((error) => {
    console.error(error instanceof Error ? error.message : 'CLI outcome child cleanup failed');
    process.exitCode = 1;
    if (process.connected) process.disconnect();
  });
  return shuttingDown;
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
process.on('disconnect', shutdown);

function reply(value) {
  if (!process.connected) return;
  process.send(value, (error) => {
    if (error && !shuttingDown) {
      console.error('CLI outcome child IPC failed');
      process.exitCode = 1;
      void shutdown();
    }
  });
}

let queue = Promise.resolve();
process.on('message', ({ id, method, params }) => {
  queue = queue.then(async () => {
    try {
      assert.ok(!shuttingDown, 'CLI outcome child is shutting down');
      let result;
      if (method === 'fixture') {
        const name = params?.name;
        assert.ok(CASES.has(name), 'Unknown CLI outcome fixture case');
        assert.ok(!fixtures.has(name), 'CLI outcome fixture already exists');
        const app = await startVersionedApp({
          ...(name === 'ignored' || name === 'api-shortcut' || name === 'recipe-broken'
            ? { ignoreUiClicks: true }
            : {}),
          ...(name === 'lost-response' ? { loseFirstResponse: true } : {}),
        });
        fixtures.set(name, {
          app,
          url: app.url,
          closed: false,
          issued: undefined,
          claims: 0,
          claimScope: undefined,
          reads: 0,
          actions: 0,
          shortcuts: 0,
        });
        result = { url: app.url };
      } else if (method === 'closeFixture') {
        result = await closeFixture(params?.name);
      } else if (method === 'fixtureState') {
        result = stateOfFixture(params?.name);
      } else if (method === 'oracle') {
        result = stateOfFixture(params?.name);
      } else {
        throw new Error('Unknown CLI outcome child method');
      }
      reply({ id, result });
    } catch (error) {
      reply({ id, error: error instanceof Error ? error.message : 'CLI outcome child failed' });
    }
  });
});

reply({ kind: 'ready', baseUrl, modules, fixture: { id: ADAPTER, version: VERSION } });
