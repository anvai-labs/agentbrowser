import assert from 'node:assert/strict';
import { type PreparedEvidenceRead, TrustedEvidenceSourceRegistry } from '@agentbrowser/control';
import { canonicalJson } from '@agentbrowser/core';
import { FakeEngine } from '@agentbrowser/testkit';
import { expect, it, vi } from 'vitest';
import { AgentBrowserService, type ServiceOutcomeEvidenceContext } from './service.js';
import { createDraftDataQualifier } from './test-support/application-draft-evidence.js';
import { createApplicationDraft } from './test-support/application-draft.js';

function fixture() {
  const draft = createApplicationDraft({ id: 'qualified-draft' });
  draft.update(0, {
    fullName: 'Synthetic Person',
    currentCompany: 'Current Co',
    previousCompany: 'Previous Co',
    preference: 'remote',
    relocation: null,
    referral: '',
    terms: true,
  });
  const snapshot = draft.upload(1, {
    name: 'candidate.pdf',
    type: 'application/pdf',
    bytes: Buffer.from('Synthetic bytes'),
  });
  const { id, incarnation, version, job, destination, intent } = snapshot;
  const expected = { id, incarnation, version, job, destination, intent };
  return { draft, snapshot, expected };
}

it('independently validates a complete detached native draft against pinned trusted identity', () => {
  const { snapshot, expected } = fixture();
  const qualify = createDraftDataQualifier(expected);
  const result = qualify(snapshot);
  expect(result).toEqual(snapshot);
  snapshot.fields.fullName = 'Changed caller data';
  expected.job.id = 'changed-config';
  expect(result.fields.fullName).toBe('Synthetic Person');
  expect(() => qualify(result)).not.toThrow();
});

it.each([
  ['fullName', ''],
  ['currentCompany', ''],
  ['previousCompany', ''],
  ['preference', ''],
  ['preference', 'custom-widget'],
  ['terms', false],
  ['source', 'hidden-replacement'],
  ['relocation', 'yes'],
  ['referral', 1],
  ['fullName', 'x'.repeat(257)],
  ['fullName', 'private\nvalue'],
])('refuses forged complete:true with invalid field %s=%s', (key, value) => {
  const { snapshot, expected } = fixture();
  Object.assign(snapshot.fields, { [key]: value });
  expect(() => createDraftDataQualifier(expected)(snapshot)).toThrow('Draft evidence unavailable');
});

it('requires a committed conditional choice and accepts explicit false', () => {
  const { snapshot, expected } = fixture();
  snapshot.fields.preference = 'hybrid';
  const qualify = createDraftDataQualifier(expected);
  expect(() => qualify(snapshot)).toThrow();
  snapshot.fields.relocation = false;
  expect(qualify(snapshot).fields.relocation).toBe(false);
});

it.each(['id', 'incarnation', 'version', 'job', 'destination', 'intent'] as const)(
  'refuses changed pinned %s even when every answer matches',
  (key) => {
    const { snapshot, expected } = fixture();
    const qualify = createDraftDataQualifier(expected);
    const altered = { ...snapshot, [key]: key === 'version' ? 3 : 'wrong' };
    expect(() => qualify(altered)).toThrow();
  }
);

it.each([
  ['id', ''],
  ['name', '../private.pdf'],
  ['name', 'x'.repeat(129)],
  ['type', 'text/plain'],
  ['size', 0],
  ['size', 32769],
  ['size', 1.5],
  ['sha256', 'not-a-digest'],
])('refuses invalid attachment %s', (key, value) => {
  const { snapshot, expected } = fixture();
  assert(snapshot.attachment);
  Object.assign(snapshot.attachment, { [key]: value });
  expect(() => createDraftDataQualifier(expected)(snapshot)).toThrow();
});

it.each(['root', 'contract', 'job', 'fields', 'attachment'] as const)(
  'rejects unknown and omitted keys in %s',
  (part) => {
    const { snapshot, expected } = fixture();
    const qualify = createDraftDataQualifier(expected);
    const target = (part === 'root' ? snapshot : snapshot[part]) as unknown as Record<
      string,
      unknown
    >;
    target.unknown = 'unqualified';
    expect(() => qualify(snapshot)).toThrow();
    Reflect.deleteProperty(target, 'unknown');
    const key = Object.keys(target)[0];
    assert(key);
    Reflect.deleteProperty(target, key);
    expect(() => qualify(snapshot)).toThrow();
  }
);

it.each([
  { complete: false },
  { missing: ['terms'] },
  { attachment: null },
  { contract: { id: 'synthetic-application-draft', version: 2 } },
  { version: Number.NaN },
  { version: -1 },
])('refuses malformed or contradictory envelope %j', (patch) => {
  const { snapshot, expected } = fixture();
  expect(() => createDraftDataQualifier(expected)({ ...snapshot, ...patch })).toThrow();
});

it('rejects descriptor tricks and bounded-data overflow without leaking private errors', () => {
  const { snapshot, expected } = fixture();
  const qualify = createDraftDataQualifier(expected);
  const getter = Object.defineProperty({ ...snapshot }, 'fields', {
    enumerable: true,
    get() {
      throw new Error('PRIVATE-ANSWER');
    },
  });
  const hidden = Object.defineProperty({ ...snapshot }, 'unknown', { value: 'secret' });
  const symbol = { ...snapshot, [Symbol('unknown')]: 'secret' };
  for (const value of [getter, hidden, symbol, { ...snapshot, extra: 'x'.repeat(65537) }]) {
    expect(() => qualify(value)).toThrow('Draft evidence unavailable');
  }
});

it('requires trusted expected identity configuration to satisfy its own exact contract', () => {
  const { expected } = fixture();
  for (const value of [
    {},
    { ...expected, version: -1 },
    { ...expected, intent: 'submit' },
    { ...expected, extra: true },
    { ...expected, destination: 'javascript:alert(1)' },
  ]) {
    expect(() => createDraftDataQualifier(value as never)).toThrow('Draft evidence unavailable');
  }
});

it('qualifies real owner data through the service-owned source with fixed policy and one admission', async () => {
  const { draft, snapshot, expected } = fixture();
  const qualify = createDraftDataQualifier(expected);
  const operator = { actor: 'operator' as const, tenant: 'owner' };
  const verifier = { id: 'synthetic-draft-data', version: 'v1', input: {} };
  let sources: TrustedEvidenceSourceRegistry<ServiceOutcomeEvidenceContext> | undefined;
  let permittedSessionId: string | undefined;
  let generation = 1;
  const service = new AgentBrowserService({
    engine: new FakeEngine(),
    applicationAdapters: [draft.adapter],
    evidenceSourceRegistryProvider(builder) {
      sources = new TrustedEvidenceSourceRegistry([
        builder.applicationRead({
          descriptor: { id: 'synthetic-draft-source', capability: 'application.draft' },
          request: { operation: 'read', input: {} },
          authorize(request) {
            if (
              request.identity.sessionId !== permittedSessionId ||
              request.identity.adapter !== draft.adapter.id ||
              request.identity.resource !== expected.id ||
              request.identity.operation !== 'read' ||
              request.correlationId !== 'draft-data-check' ||
              request.source.id !== 'synthetic-draft-source' ||
              request.source.capability !== 'application.draft' ||
              canonicalJson(request.verifier) !== canonicalJson(verifier)
            )
              return undefined;
            return { generation, currentGeneration: () => generation };
          },
        }),
      ]);
      return sources;
    },
  });
  let escaped: PreparedEvidenceRead | undefined;
  try {
    const { sessionId } = await service.createSession({
      tenantId: 'owner',
      controlMode: 'delegated',
    });
    permittedSessionId = sessionId;
    service.applicationBind(sessionId, operator, {
      adapter: draft.adapter.id,
      resource: expected.id,
    });
    const run = vi.spyOn(service.authority, 'run');
    await service.authority.run(sessionId, operator, {}, async () => {
      const signal = new AbortController().signal;
      const context = { sessionId, pageId: 'not-a-page-witness', signal };
      assert(sources);
      const registry = sources;
      const prepare = (predicate = verifier) =>
        registry.prepareRead(
          'synthetic-draft-source',
          'application.draft',
          context,
          'draft-data-check',
          predicate
        );
      expect(() => prepare({ ...verifier, input: { allowIncomplete: true } })).toThrow();
      const read = prepare();
      assert(read);
      escaped = read;
      context.sessionId = 'foreign-session';
      const result = await read(signal);
      expect(result.status).toBe('ready');
      if (result.status !== 'ready') throw new Error('Expected data');
      expect(qualify(result.evidence)).toEqual(snapshot);
      read.assertAuthorized();
      // Same answers from another incarnation are not the configured draft.
      const other = fixture().snapshot;
      expect(other.fields).toEqual(snapshot.fields);
      expect(() => qualify(other)).toThrow();
      // A fresh read observes actual equal-size replacement bytes and a newer version.
      const replacement = draft.upload(2, {
        name: 'candidate.pdf',
        type: 'application/pdf',
        bytes: Buffer.from('Replacement doc'),
      });
      assert(replacement.attachment && snapshot.attachment);
      expect(replacement.attachment.size).toBe(snapshot.attachment.size);
      expect(replacement.attachment.sha256).not.toBe(snapshot.attachment.sha256);
      const changed = await read(signal);
      expect(changed.status).toBe('ready');
      if (changed.status !== 'ready') throw new Error('Expected data');
      expect(() => qualify(changed.evidence)).toThrow();
      expect(service.authority.didDispatchInScope(sessionId)).toBe(false);
      generation++;
      expect(() => read.assertAuthorized()).toThrow();
      await expect(async () => read(signal)).rejects.toThrow();
    });
    expect(run).toHaveBeenCalledTimes(1);
    run.mockRestore();
    assert(escaped);
    const read = escaped;
    await expect(async () => read(new AbortController().signal)).rejects.toThrow();
  } finally {
    await service.shutdown();
  }
});
