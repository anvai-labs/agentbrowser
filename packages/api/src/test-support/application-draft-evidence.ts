import type { PreparedEvidenceRead } from '@agentbrowser/control';
import { canonicalJson } from '@agentbrowser/core';
import {
  type NativeFormControlEvidence,
  type NativeFormEvidence,
  parseNativeFormEvidence,
} from '@agentbrowser/engine';
import { VERIFICATION_SNAPSHOT_LIMITS, snapshotJsonData } from '@agentbrowser/protocol';
import type { PreparedNativeFormRead } from '../service.js';
import type { DraftSnapshot } from './application-draft.js';

type DraftIdentity = Pick<
  DraftSnapshot,
  'id' | 'incarnation' | 'version' | 'job' | 'destination' | 'intent'
>;
const identityKeys = ['id', 'incarnation', 'version', 'job', 'destination', 'intent'] as const;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function requireData(condition: unknown): asserts condition {
  if (!condition) throw new Error('Draft evidence unavailable');
}
function snapshot(value: unknown): unknown {
  return JSON.parse(canonicalJson(snapshotJsonData(value, VERIFICATION_SNAPSHOT_LIMITS)));
}
function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  requireData(value !== null && typeof value === 'object' && !Array.isArray(value));
  const object = value as Record<string, unknown>;
  requireData(
    Object.keys(object).length === keys.length && keys.every((key) => Object.hasOwn(object, key))
  );
  return object;
}
function text(value: unknown, max = 256): value is string {
  return (
    typeof value === 'string' &&
    value.length <= max &&
    [...value].every((character) => character.charCodeAt(0) >= 32)
  );
}
function identity(value: Record<string, unknown>): void {
  requireData(typeof value.id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value.id));
  requireData(typeof value.incarnation === 'string' && uuid.test(value.incarnation));
  requireData(Number.isSafeInteger(value.version) && Number(value.version) >= 0);
  const job = exact(value.job, ['id', 'company']);
  requireData(job.id === 'synthetic-platform-role' && job.company === 'Synthetic Company');
  requireData(value.destination === 'https://example.test/apply' && value.intent === 'draft');
}

/** Test-only data qualification. Does not attest page identity, freshness or submission. */
export function createDraftDataQualifier(
  expected: DraftIdentity
): (input: unknown) => DraftSnapshot {
  try {
    const pinned = exact(snapshot(expected), identityKeys);
    identity(pinned);
    const pinnedIdentity = canonicalJson(pinned);
    return (input) => {
      try {
        const value = exact(snapshot(input), [
          ...identityKeys,
          'contract',
          'fields',
          'attachment',
          'complete',
          'missing',
        ]);
        identity(value);
        const observedIdentity = Object.fromEntries(identityKeys.map((key) => [key, value[key]]));
        requireData(canonicalJson(observedIdentity) === pinnedIdentity);
        const contract = exact(value.contract, ['id', 'version']);
        requireData(contract.id === 'synthetic-application-draft' && contract.version === 1);
        const fields = exact(value.fields, [
          'fullName',
          'currentCompany',
          'previousCompany',
          'preference',
          'relocation',
          'referral',
          'terms',
          'source',
        ]);
        for (const key of ['fullName', 'currentCompany', 'previousCompany']) {
          const answer = fields[key];
          requireData(text(answer) && answer.trim().length > 0);
        }
        requireData(text(fields.referral));
        requireData(fields.preference === 'remote' || fields.preference === 'hybrid');
        requireData(
          typeof fields.relocation === 'boolean' ||
            (fields.preference === 'remote' && fields.relocation === null)
        );
        requireData(fields.terms === true && fields.source === 'direct');
        const attachment = exact(value.attachment, ['id', 'name', 'type', 'size', 'sha256']);
        requireData(typeof attachment.id === 'string' && uuid.test(attachment.id));
        requireData(
          text(attachment.name, 128) &&
            attachment.name.length > 0 &&
            attachment.name.trim() === attachment.name &&
            !/[\\/]/.test(attachment.name)
        );
        requireData(
          attachment.type === 'application/pdf' &&
            Number.isSafeInteger(attachment.size) &&
            Number(attachment.size) > 0 &&
            Number(attachment.size) <= 32 * 1024
        );
        requireData(
          typeof attachment.sha256 === 'string' && /^[0-9a-f]{64}$/.test(attachment.sha256)
        );
        // Completeness was derived above; these owner assertions must agree, not replace it.
        requireData(
          value.complete === true && Array.isArray(value.missing) && value.missing.length === 0
        );
        return value as unknown as DraftSnapshot;
      } catch {
        throw new Error('Draft evidence unavailable');
      }
    };
  } catch {
    throw new Error('Draft evidence unavailable');
  }
}

interface DraftWitnessExpectation {
  page: PreparedNativeFormRead['identity'] & {
    url: string;
    documentId: string;
    formNodeId: string;
    controls: Record<string, { nodeId: string; blockId: string | null }>;
  };
  application: Omit<DraftIdentity, 'version'>;
}

/** Qualified only for the audited cooperative synthetic draft and trusted paired readers. */
export function createDraftWitnessCollector(options: {
  application: PreparedEvidenceRead;
  page: PreparedNativeFormRead;
  expected: DraftWitnessExpectation;
}): (signal: AbortSignal) => Promise<{ application: DraftSnapshot; page: NativeFormEvidence }> {
  try {
    const pinned = snapshot(options.expected) as DraftWitnessExpectation;
    exact(pinned, ['page', 'application']);
    exact(
      pinned.application,
      identityKeys.filter((key) => key !== 'version')
    );
    identity({ ...pinned.application, version: 0 });
    const expectedPage = exact(pinned.page, [
      'sessionId',
      'pageId',
      'sessionIncarnation',
      'url',
      'documentId',
      'formNodeId',
      'controls',
    ]);
    requireData(
      Object.entries(expectedPage).every(
        ([key, value]) => key === 'controls' || (typeof value === 'string' && value.length > 0)
      )
    );
    exact(pinned.page.controls, draftControlIds);
    for (const id of draftControlIds) {
      const control = exact(pinned.page.controls[id], ['nodeId', 'blockId']);
      requireData(typeof control.nodeId === 'string' && control.nodeId.length > 0);
      requireData(
        control.blockId === null ||
          (typeof control.blockId === 'string' && control.blockId.length > 0)
      );
    }
    const { sessionId, pageId, sessionIncarnation } = pinned.page;
    const pageIdentity = canonicalJson({ sessionId, pageId, sessionIncarnation });
    const readApplication = options.application.bind(options.application);
    const assertApplication = options.application.assertAuthorized.bind(options.application);
    const readPage = options.page.read.bind(options.page);
    const assertPage = options.page.assertAuthority.bind(options.page);
    const actualPageIdentity = snapshot(options.page.identity);
    requireData(canonicalJson(actualPageIdentity) === pageIdentity);
    const check = (signal?: AbortSignal) => {
      requireData(!signal?.aborted);
      assertApplication();
      assertPage();
      assertApplication();
      requireData(!signal?.aborted);
    };
    check();
    return async (signal) => {
      try {
        check(signal);
        const a = snapshot(await readApplication(signal));
        check(signal);
        const nativeA = snapshot(await readPage(signal));
        check(signal);
        const b = snapshot(await readApplication(signal));
        check(signal);
        const nativeB = snapshot(await readPage(signal));
        check(signal);
        requireData(
          canonicalJson(a) === canonicalJson(b) && canonicalJson(nativeA) === canonicalJson(nativeB)
        );
        const read = exact(a, ['status', 'evidence', 'evidenceRefIds']);
        requireData(read.status === 'ready');
        const raw = read.evidence as DraftSnapshot;
        const data = createDraftDataQualifier({ ...pinned.application, version: raw?.version })(
          raw
        );
        const native = validateDraftNative(nativeA, data, pinned.page);
        // Bound the complete private aggregate, not just the independently bounded inputs.
        const result = snapshot({ application: data, page: native }) as {
          application: DraftSnapshot;
          page: NativeFormEvidence;
        };
        check(signal);
        return result;
      } catch {
        // Observe revocation even when a callback or data inspection itself failed.
        try {
          check(signal);
        } catch {
          /* Prepared owners retain their own revocation. */
        }
        throw new Error('Draft witness unavailable');
      }
    };
  } catch {
    throw new Error('Draft witness unavailable');
  }
}

const draftControlIds = [
  'fullName',
  'currentCompany',
  'previousCompany',
  'preference',
  'relocation',
  'referral',
  'terms',
  'source',
  'resume',
  'remove',
  'sync',
];

function validateDraftNative(
  input: unknown,
  data: DraftSnapshot,
  pinned: DraftWitnessExpectation['page']
): NativeFormEvidence {
  const native = parseNativeFormEvidence(input);
  requireData(native.url === pinned.url && native.documentId === pinned.documentId);
  const form = native.form;
  requireData(
    form.nodeId === pinned.formNodeId &&
      form.id === '' &&
      form.name === '' &&
      form.action === pinned.url &&
      form.method === 'get'
  );
  const ids = draftControlIds;
  requireData(native.controls.length === ids.length);
  const byId = new Map<string, NativeFormControlEvidence>();
  for (const value of native.controls) {
    const id = value.id;
    requireData(ids.includes(id) && !byId.has(id));
    requireData(
      value.nodeId === pinned.controls[id]?.nodeId && value.blockId === pinned.controls[id]?.blockId
    );
    requireData(
      value.name === '' &&
        value.required === false &&
        value.disabled === (id === 'sync') &&
        value.visible === (id !== 'source')
    );
    const tag = ['preference', 'relocation'].includes(id)
      ? 'select'
      : ['remove', 'sync'].includes(id)
        ? 'button'
        : 'input';
    const type =
      tag === 'select'
        ? 'select-one'
        : tag === 'button'
          ? 'button'
          : id === 'terms'
            ? 'checkbox'
            : id === 'source'
              ? 'hidden'
              : id === 'resume'
                ? 'file'
                : 'text';
    requireData(value.tag === tag && value.type === type);
    byId.set(id, value);
  }
  const get = (id: string) => {
    const value = byId.get(id);
    requireData(value);
    return value;
  };
  for (const id of ['fullName', 'currentCompany', 'previousCompany', 'referral', 'source'] as const)
    requireData(get(id).value === data.fields[id]);
  requireData(
    typeof get('currentCompany').blockId === 'string' &&
      get('currentCompany').blockId !== '' &&
      typeof get('previousCompany').blockId === 'string' &&
      get('previousCompany').blockId !== '' &&
      get('currentCompany').blockId !== get('previousCompany').blockId
  );
  requireData(get('terms').checked === data.fields.terms);
  const selection = (id: string, value: string, entries: [string, string][]) => {
    const control = get(id);
    const selected = entries.findIndex(([option]) => option === value);
    requireData(selected >= 0 && control.value === value && control.selectedIndex === selected);
    requireData(
      canonicalJson(control.options) ===
        canonicalJson(
          entries.map(([option, label], index) => ({
            value: option,
            label,
            selected: index === selected,
            disabled: false,
          }))
        )
    );
  };
  selection('preference', data.fields.preference, [
    ['', 'Choose'],
    ['remote', 'Remote'],
    ['hybrid', 'Hybrid'],
  ]);
  selection(
    'relocation',
    data.fields.relocation === null ? '' : data.fields.relocation ? 'yes' : 'no',
    [
      ['', 'Unanswered'],
      ['yes', 'Yes'],
      ['no', 'No'],
    ]
  );
  const files = get('resume').files;
  requireData(files?.length === 1 && data.attachment);
  const file = files[0];
  requireData(file);
  for (const key of ['name', 'type', 'size', 'sha256'] as const)
    requireData(file[key] === data.attachment[key]);
  requireData(get('remove').text === 'Remove attachment');
  const status = get('sync').text;
  requireData(
    typeof status === 'string' && status.startsWith('Draft sync ') && status.length <= 2048
  );
  const diagnostic = exact(JSON.parse(status.slice('Draft sync '.length)), [
    'version',
    'pending',
    'failed',
    'preference',
    'attachment',
  ]);
  requireData(
    diagnostic.version === data.version &&
      diagnostic.pending === 0 &&
      diagnostic.failed === false &&
      diagnostic.preference === data.fields.preference
  );
  const metadata = exact(diagnostic.attachment, ['name', 'type', 'size']);
  for (const key of ['name', 'type', 'size'] as const)
    requireData(metadata[key] === data.attachment[key]);
  return native;
}
