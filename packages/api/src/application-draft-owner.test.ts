import { createHash } from 'node:crypto';
import type { ApplicationScope } from '@agentbrowser/control';
import { expect, it } from 'vitest';
import {
  DRAFT_UPLOAD_MAX_BYTES,
  createApplicationDraft,
} from './test-support/application-draft.js';

const completeFields = {
  fullName: 'Synthetic Person',
  currentCompany: 'Current Co',
  previousCompany: 'Previous Co',
  preference: 'remote',
  relocation: null,
  referral: '',
  terms: true,
};
const file = (text = 'synthetic PDF') => ({
  name: 'resume.pdf',
  type: 'application/pdf',
  bytes: Buffer.from(text),
});
const scope = (expectedVersion = 0): ApplicationScope => ({
  sessionId: 'session',
  sessionIncarnation: 'incarnation',
  tenant: 'owner',
  resource: 'draft',
  signal: new AbortController().signal,
  operationId: 'op',
  expectedVersion,
});

it('owns immutable identity and returns detached snapshots', () => {
  const owner = createApplicationDraft({ id: 'draft' });
  const initial = owner.read();
  expect(initial).toMatchObject({
    id: 'draft',
    version: 0,
    intent: 'draft',
    fields: { source: 'direct' },
    attachment: null,
    complete: false,
  });
  initial.fields.fullName = 'forged';
  initial.job.company = 'forged';
  expect(owner.read().fields.fullName).toBe('');
  expect(owner.read().job.company).not.toBe('forged');
  expect(createApplicationDraft({ id: 'draft' }).read().incarnation).not.toBe(initial.incarnation);
});
it('computes completeness and conditional relocation from committed values', () => {
  const owner = createApplicationDraft({ id: 'draft' });
  expect(owner.update(0, completeFields)).toMatchObject({
    version: 1,
    complete: false,
    missing: ['attachment'],
  });
  expect(owner.upload(1, file()).complete).toBe(true);
  expect(owner.update(2, { preference: 'hybrid' }).missing).toEqual(['relocation']);
  expect(owner.update(3, { relocation: false }).complete).toBe(true);
  expect(owner.update(4, { terms: false }).missing).toEqual(['terms']);
});
it.each([
  { complete: true },
  { source: 'forged' },
  { version: 42 },
  { relocation: 'yes' },
  { terms: 1 },
  { preference: 'office' },
  { fullName: 'x'.repeat(257) },
  [],
  null,
])('refuses forged and malformed fields atomically', (patch) => {
  const owner = createApplicationDraft({ id: 'draft' });
  expect(() => owner.update(0, patch)).toThrow('Invalid draft input');
  expect(owner.read().version).toBe(0);
});
it('refuses stale versions and fences delayed upload even after removing an absent attachment', () => {
  const owner = createApplicationDraft({ id: 'draft' });
  expect(owner.remove(0).version).toBe(1);
  expect(() => owner.upload(0, file())).toThrow('VERSION_CONFLICT');
  expect(() => owner.update(0, completeFields)).toThrow('VERSION_CONFLICT');
  expect(owner.read()).toMatchObject({ version: 1, attachment: null });
});
it('hashes actual detached bytes, including same-size replacements', () => {
  const owner = createApplicationDraft({ id: 'draft' });
  const input = file('AAAA');
  const first = owner.upload(0, input);
  input.bytes.fill(66);
  expect(owner.read().attachment?.sha256).toBe(createHash('sha256').update('AAAA').digest('hex'));
  if (!first.attachment) throw new Error('Missing attachment');
  first.attachment.sha256 = 'forged';
  const second = owner.upload(1, file('BBBB'));
  expect(second.attachment?.size).toBe(4);
  expect(second.attachment?.sha256).toBe(createHash('sha256').update('BBBB').digest('hex'));
  expect(second.attachment?.id).not.toBe(first.attachment.id);
});
it.each([0, 32769])('rejects invalid raw byte size %s without committing', (size) => {
  const owner = createApplicationDraft({ id: 'draft' });
  expect(() => owner.upload(0, { ...file(), bytes: new Uint8Array(size) })).toThrow(
    'Invalid draft input'
  );
  expect(owner.read()).toMatchObject({ version: 0, attachment: null });
});
it('accepts the common raw-byte boundary and refuses forged metadata', () => {
  const owner = createApplicationDraft({ id: 'draft' });
  expect(DRAFT_UPLOAD_MAX_BYTES).toBe(32768);
  expect(
    owner.upload(0, { ...file(), bytes: new Uint8Array(DRAFT_UPLOAD_MAX_BYTES) }).attachment?.size
  ).toBe(32768);
  expect(() => owner.upload(1, { ...file(), sha256: 'forged' })).toThrow('Invalid draft input');
  expect(owner.read().version).toBe(1);
});
it('refuses accessors without invoking them or partially committing', () => {
  const owner = createApplicationDraft({ id: 'draft' });
  let called = false;
  const patch = Object.defineProperty({}, 'fullName', {
    enumerable: true,
    get: () => {
      called = true;
      return 'PRIVATE';
    },
  });
  expect(() => owner.update(0, patch)).toThrow('Invalid draft input');
  expect(called).toBe(false);
  expect(owner.read().version).toBe(0);
});
it('projects only read/update/upload/remove and reuses owner version semantics', async () => {
  const owner = createApplicationDraft({ id: 'draft' });
  expect(Object.keys(owner.adapter.operations)).toEqual(['read', 'update', 'upload', 'remove']);
  expect(owner.adapter.authorize({ tenant: 'owner', resource: 'draft' })).toBe(true);
  expect(owner.adapter.authorize({ tenant: 'foreign', resource: 'draft' })).toBe(false);
  expect(owner.adapter.authorize({ tenant: 'owner', resource: 'foreign' })).toBe(false);
  const update = owner.adapter.operations.update;
  if (!update) throw new Error('Missing update');
  expect(await update.prepare(completeFields)(scope())).toMatchObject({
    status: 'committed',
    value: { version: 1 },
  });
  expect(await update.prepare({ fullName: 'Other' })(scope())).toEqual({
    status: 'rejected',
    reason: 'VERSION_CONFLICT',
  });
  expect(await owner.adapter.receipt(scope(), 'op')).toBeNull();
});
it('adapter requires canonical bounded base64 and hashes decoded bytes', async () => {
  const owner = createApplicationDraft({ id: 'draft' });
  const operation = owner.adapter.operations.upload;
  if (!operation) throw new Error('Missing upload');
  for (const base64 of ['QQ', 'QQ==\n', 'QR==', '@@@@', '']) {
    expect(() =>
      operation.prepare({ name: 'resume.pdf', type: 'application/pdf', base64 })
    ).toThrow('Invalid draft input');
  }
  expect(() =>
    operation.prepare({
      name: 'resume.pdf',
      type: 'application/pdf',
      base64: Buffer.alloc(32769).toString('base64'),
    })
  ).toThrow('Invalid draft input');
  const result = await operation.prepare({
    name: 'resume.pdf',
    type: 'application/pdf',
    base64: Buffer.from('AAAA').toString('base64'),
  })(scope());
  expect(result).toMatchObject({
    status: 'committed',
    value: { attachment: { size: 4, sha256: createHash('sha256').update('AAAA').digest('hex') } },
  });
});

it.each([-1, 0.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])(
  'rejects malformed expected version %s without effects',
  (version) => {
    const owner = createApplicationDraft({ id: 'draft' });
    expect(() => owner.remove(version)).toThrow('Invalid draft input');
    expect(owner.read().version).toBe(0);
  }
);
it.each([
  { ...file(), bytes: [1, 2, 3] },
  { ...file(), type: 'text/plain' },
  { ...file(), name: '../resume.pdf' },
])('refuses malformed upload data with static diagnostics', (input) => {
  const owner = createApplicationDraft({ id: 'draft' });
  expect(() => owner.upload(0, input)).toThrow('Invalid draft input');
  expect(owner.read().attachment).toBeNull();
});
it('supports the same 32 KiB upload boundary on the application adapter', async () => {
  const owner = createApplicationDraft({ id: 'draft' });
  const operation = owner.adapter.operations.upload;
  if (!operation) throw new Error('Missing upload');
  const bytes = Buffer.alloc(DRAFT_UPLOAD_MAX_BYTES, 7);
  const result = await operation.prepare({
    name: 'resume.pdf',
    type: 'application/pdf',
    base64: bytes.toString('base64'),
  })(scope());
  expect(result).toMatchObject({
    status: 'committed',
    value: {
      attachment: {
        size: DRAFT_UPLOAD_MAX_BYTES,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      },
    },
  });
});
it('refuses aborted or foreign direct adapter execution without effects', async () => {
  const owner = createApplicationDraft({ id: 'draft' });
  const update = owner.adapter.operations.update;
  if (!update) throw new Error('Missing update');
  const aborted = new AbortController();
  aborted.abort();
  expect(await update.prepare(completeFields)({ ...scope(), signal: aborted.signal })).toEqual({
    status: 'rejected',
    reason: 'INVALID_SCOPE',
  });
  expect(await update.prepare(completeFields)({ ...scope(), tenant: 'foreign' })).toEqual({
    status: 'rejected',
    reason: 'INVALID_SCOPE',
  });
  expect(owner.read().version).toBe(0);
});
