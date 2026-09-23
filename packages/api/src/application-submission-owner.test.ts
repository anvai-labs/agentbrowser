import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { ApplicationScope } from '@agentbrowser/control';
import { expect, it } from 'vitest';
import { startDraftFixture } from './test-support/application-draft-http.js';
import { createApplicationDraft } from './test-support/application-draft.js';

function complete(id = 'draft') {
  const owner = createApplicationDraft({ id });
  owner.update(0, {
    fullName: 'Synthetic Person',
    currentCompany: 'Current Co',
    previousCompany: 'Previous Co',
    preference: 'remote',
    relocation: null,
    referral: '',
    terms: true,
  });
  const bytes = Buffer.from('AAAA');
  owner.upload(1, { name: 'resume.pdf', type: 'application/pdf', bytes });
  const expected = owner.read();
  return { owner, bytes, command: { operationId: 'submit-once', intent: 'submit', expected } };
}
const scope = (changes: Partial<ApplicationScope> = {}): ApplicationScope => ({
  sessionId: 'session',
  sessionIncarnation: 'session-incarnation',
  tenant: 'owner',
  resource: 'draft',
  signal: new AbortController().signal,
  ...changes,
});

it('atomically accepts the complete app-owned payload and actual received bytes once', () => {
  const { owner, bytes, command } = complete();
  bytes.fill(66);
  const accepted = owner.submit(2, command);
  expect(accepted).toMatchObject({
    contract: { id: 'synthetic-application-acceptance', version: 1 },
    submissionId: expect.any(String),
    operationId: 'submit-once',
    intent: 'submit',
    accepted: command.expected,
    committedVersion: 3,
  });
  expect(owner.read().version).toBe(3);
  expect(owner.submissionCount()).toBe(1);
  expect(owner.acceptedAttachment()).toEqual(Buffer.from('AAAA'));
  const received = owner.acceptedAttachment();
  assert(received);
  expect(createHash('sha256').update(received).digest('hex')).toBe(
    accepted.accepted.attachment?.sha256
  );
  accepted.accepted.fields.fullName = 'forged';
  owner.acceptedAttachment()?.fill(67);
  expect(owner.receipt('submit-once')?.accepted.fields.fullName).toBe('Synthetic Person');
  expect(owner.acceptedAttachment()).toEqual(Buffer.from('AAAA'));
});

it('reconciles a lost return by independent receipt and exact replay before stale-version refusal', async () => {
  const { owner, command } = complete();
  const results = await Promise.all([0, 1].map(async () => owner.submit(2, command)));
  expect(results[1]).toEqual(results[0]);
  expect(owner.receipt('submit-once')).toEqual(results[0]);
  expect(owner.submissionCount()).toBe(1);
  expect(() => owner.submit(2, { ...command, operationId: 'different' })).toThrow(
    'ALREADY_SUBMITTED'
  );
  expect(() => owner.submit(3, command)).toThrow('OPERATION_CONFLICT');
  expect(() =>
    owner.submit(2, { ...command, expected: { ...command.expected, destination: 'other' } })
  ).toThrow('OPERATION_CONFLICT');
  expect(owner.submissionCount()).toBe(1);
});

it.each([
  ['contract', 'id', 'other'],
  ['job', 'id', 'other'],
  ['job', 'company', 'other'],
  ['fields', 'fullName', 'other'],
  ['fields', 'currentCompany', 'other'],
  ['fields', 'previousCompany', 'other'],
  ['fields', 'preference', 'hybrid'],
  ['fields', 'relocation', true],
  ['fields', 'referral', 'other'],
  ['fields', 'terms', false],
  ['fields', 'source', 'other'],
  ['attachment', 'id', 'other'],
  ['attachment', 'name', 'other.pdf'],
  ['attachment', 'type', 'text/plain'],
  ['attachment', 'size', 5],
  ['attachment', 'sha256', '0'.repeat(64)],
] as const)('refuses changed %s.%s without acceptance', (section, key, value) => {
  const { owner, command } = complete();
  const expected = structuredClone(command.expected);
  const target = expected[section];
  assert(target);
  Object.assign(target, { [key]: value });
  expect(() => owner.submit(2, { ...command, expected })).toThrow('PAYLOAD_MISMATCH');
  expect(owner.submissionCount()).toBe(0);
  expect(owner.read().version).toBe(2);
});

it.each(['id', 'incarnation', 'destination', 'intent', 'version', 'complete', 'missing'])(
  'refuses a changed top-level %s',
  (key) => {
    const { owner, command } = complete();
    const expected = { ...command.expected, [key]: 'forged' };
    expect(() => owner.submit(2, { ...command, expected })).toThrow('PAYLOAD_MISMATCH');
    expect(owner.submissionCount()).toBe(0);
  }
);

it('refuses incomplete, stale and replaced drafts or same-size received file changes', () => {
  const { owner, command } = complete();
  const empty = createApplicationDraft({ id: 'draft' });
  expect(() =>
    empty.submit(0, { ...command, expected: { ...empty.read(), complete: true, missing: [] } })
  ).toThrow('DRAFT_INCOMPLETE');
  const replacement = complete().owner;
  expect(() => replacement.submit(2, command)).toThrow('PAYLOAD_MISMATCH');
  owner.upload(2, { name: 'resume.pdf', type: 'application/pdf', bytes: Buffer.from('BBBB') });
  expect(() => owner.submit(2, command)).toThrow('VERSION_CONFLICT');
  expect(() => owner.submit(3, command)).toThrow('PAYLOAD_MISMATCH');
  expect(owner.submissionCount()).toBe(0);
});

it.each(['draft', '', undefined])('requires explicit submit intent (%s)', (intent) => {
  const { owner, command } = complete();
  expect(() => owner.submit(2, { ...command, intent })).toThrow('Invalid draft input');
  expect(owner.submissionCount()).toBe(0);
});

it.each(['getter', 'symbol', 'hidden', 'extra', 'oversized'])(
  'refuses malformed %s commands without accepting or invoking accessors',
  (kind) => {
    const { owner, command } = complete();
    let called = false;
    const input = { ...command };
    if (kind === 'getter')
      Object.defineProperty(input, 'intent', {
        enumerable: true,
        get() {
          called = true;
          return 'submit';
        },
      });
    if (kind === 'symbol') Object.defineProperty(input, Symbol('extra'), { value: 'private' });
    if (kind === 'hidden') Object.defineProperty(input, 'extra', { value: 'private' });
    if (kind === 'extra') Object.assign(input, { extra: true });
    if (kind === 'oversized') Object.assign(input, { expected: { private: 'x'.repeat(65537) } });
    expect(() => owner.submit(2, input)).toThrow('Invalid draft input');
    expect(called).toBe(false);
    expect(owner.submissionCount()).toBe(0);
  }
);

it('observes synchronous input-inspection reentry before the final comparison', () => {
  const { owner, command } = complete();
  let changed = false;
  const input = new Proxy(command, {
    ownKeys(target) {
      if (!changed) {
        changed = true;
        owner.update(2, { referral: 'changed during input inspection' });
      }
      return Reflect.ownKeys(target);
    },
  });
  expect(() => owner.submit(2, input)).toThrow('VERSION_CONFLICT');
  expect(owner.submissionCount()).toBe(0);
});

it('prevents all draft edits after acceptance without altering the accepted bytes', () => {
  const { owner, command } = complete();
  owner.submit(2, command);
  expect(() => owner.update(3, { referral: 'after' })).toThrow('DRAFT_SUBMITTED');
  expect(() => owner.remove(3)).toThrow('DRAFT_SUBMITTED');
  expect(() =>
    owner.upload(3, { name: 'resume.pdf', type: 'application/pdf', bytes: Buffer.from('BBBB') })
  ).toThrow('DRAFT_SUBMITTED');
  expect(owner.acceptedAttachment()).toEqual(Buffer.from('AAAA'));
  expect(owner.read().version).toBe(3);
});

it('keeps submit unavailable over HTTP/application and authorizes independent receipt reads', async () => {
  const { owner, command } = complete();
  expect(Object.keys(owner.adapter.operations)).toEqual(['read', 'update', 'upload', 'remove']);
  const http = await startDraftFixture(owner);
  try {
    expect((await fetch(new URL('/submit', http.url), { method: 'POST' })).status).toBe(403);
    expect(http.submissionAttempts()).toBe(1);
    expect(owner.submissionCount()).toBe(0);
    const accepted = owner.submit(2, command);
    expect(await owner.adapter.receipt(scope(), 'submit-once')).toEqual(accepted);
    expect(await owner.adapter.receipt(scope({ tenant: 'foreign' }), 'submit-once')).toBeNull();
    expect(await owner.adapter.receipt(scope({ resource: 'foreign' }), 'submit-once')).toBeNull();
    expect(
      await owner.adapter.receipt(scope({ signal: AbortSignal.abort() }), 'submit-once')
    ).toBeNull();
    expect(owner.receipt('unknown')).toBeNull();
  } finally {
    await http.close();
  }
});

it.each([-1, 0.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])(
  'refuses invalid expected version %s without acceptance',
  (version) => {
    const { owner, command } = complete();
    expect(() => owner.submit(version, command)).toThrow('Invalid draft input');
    expect(owner.submissionCount()).toBe(0);
  }
);
it.each(['', 'bad operation id', 'x'.repeat(129)])(
  'refuses malformed operation identity %s',
  (operationId) => {
    const { owner, command } = complete();
    expect(() => owner.submit(2, { ...command, operationId })).toThrow('Invalid draft input');
    expect(owner.submissionCount()).toBe(0);
  }
);
it('admits only one acceptance for concurrent distinct operation IDs', async () => {
  const { owner, command } = complete();
  const results = await Promise.allSettled(
    ['first', 'second'].map(async (operationId) => owner.submit(2, { ...command, operationId }))
  );
  expect(results.map((result) => result.status)).toEqual(['fulfilled', 'rejected']);
  expect(owner.receipt('first')).not.toBeNull();
  expect(owner.receipt('second')).toBeNull();
  expect(owner.submissionCount()).toBe(1);
});
it('cannot overwrite an acceptance created reentrantly during input inspection', () => {
  const { owner, command } = complete();
  let nested = false;
  const input = new Proxy(command, {
    ownKeys(target) {
      if (!nested) {
        nested = true;
        owner.submit(2, { ...command, operationId: 'nested' });
      }
      return Reflect.ownKeys(target);
    },
  });
  expect(() => owner.submit(2, input)).toThrow('ALREADY_SUBMITTED');
  expect(owner.receipt('nested')).not.toBeNull();
  expect(owner.receipt(command.operationId)).toBeNull();
  expect(owner.submissionCount()).toBe(1);
});
it('does not accept removed bytes and pins only the later uploaded attachment', () => {
  const { owner, command } = complete();
  owner.remove(2);
  expect(() => owner.submit(3, { ...command, expected: owner.read() })).toThrow('DRAFT_INCOMPLETE');
  owner.upload(3, { name: 'resume.pdf', type: 'application/pdf', bytes: Buffer.from('CCCC') });
  owner.submit(4, { ...command, expected: owner.read() });
  expect(owner.acceptedAttachment()).toEqual(Buffer.from('CCCC'));
});
