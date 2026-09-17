import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const { ApplicationSessions, ApplicationAuthority, defineApplicationOperation } = await import(pathToFileURL(process.argv[2]).href);
const sessions = new ApplicationSessions();
const operator = { actor: 'operator', tenant: 'owner' };
const { sessionId } = sessions.create(operator);
// Independently inspected application state, not an asserted tool-response value.
let total = 0;
const receipts = new Map();
const receiptKey = (scope, id = scope.operationId) =>
  `${scope.tenant}\0${scope.resource}\0${scope.sessionIncarnation}\0${id}`;
const port = new ApplicationAuthority(sessions.authority, [{
  id: 'owned-counter', authorize: ({ tenant, resource }) => tenant === 'owner' && resource === 'account',
  operations: { add: defineApplicationOperation({ mode: 'write',
    parse(value) { assert.equal(value, 1); return value; },
    async execute(value, scope) {
      assert.equal(scope.expectedVersion, 0);
      assert.equal(scope.sessionId, sessionId);
      assert.equal(scope.sessionIncarnation, sessions.authority.sessionIncarnation(sessionId));
      assert.equal(total, 0);
      total += value;
      const receipt = { operationId: scope.operationId, total };
      receipts.set(receiptKey(scope), receipt);
      return { status: 'committed', value: receipt };
    },
  }) },
  async receipt(scope, id) { return receipts.get(receiptKey(scope, id)); },
}]);
try {
  port.bind(sessionId, operator, { adapter: 'owned-counter', resource: 'account' });
  const review = sessions.authority.get(sessionId).prepareResume();
  const { token } = sessions.authority.delegate(sessionId, review.epoch);
  const agent = sessions.authority.authenticate(token);
  assert.ok(agent);
  const request = { operation: 'add', input: 1, operationId: 'effect-1', expectedVersion: 0 };
  await port.execute(sessionId, agent, request);
  assert.equal(total, 1);
  assert.equal((await port.execute(sessionId, agent, request)).replay, true);
  assert.equal(total, 1);
  await assert.rejects(port.readReceiptInScope(sessionId, 'effect-1'));
  const receipt = await sessions.authority.run(sessionId, agent,
    { id: 'outer-run-1', fingerprint: 'fixture-read' },
    () => port.readReceiptInScope(sessionId, 'effect-1'));
  assert.deepEqual(receipt, { operationId: 'effect-1', total: 1 });
  assert.equal(sessions.authority.get(sessionId).operation('outer-run-1').dispatched, false);
  assert.equal(total, 1);
  sessions.authority.takeover(sessionId);
  assert.equal(sessions.authority.authenticate(token), undefined);
  await assert.rejects(port.execute(sessionId, agent, request));
  assert.deepEqual(await port.lookupReceipt(sessionId, operator, 'effect-1'), { operationId: 'effect-1', total: 1 });
} finally { sessions.dispose(); }
