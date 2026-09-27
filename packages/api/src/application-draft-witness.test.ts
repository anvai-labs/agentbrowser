import type { PreparedEvidenceRead } from '@agentbrowser/control';
import type { NativeFormEvidence } from '@agentbrowser/engine';
import { expect, it, vi } from 'vitest';
import type { PreparedNativeFormRead } from './service.js';
import { createDraftWitnessCollector } from './test-support/application-draft-evidence.js';
import { createApplicationDraft } from './test-support/application-draft.js';

function fixture() {
  const draft = createApplicationDraft({ id: 'witness' });
  draft.update(0, {
    fullName: 'Person',
    currentCompany: 'Current',
    previousCompany: 'Previous',
    preference: 'remote',
    relocation: null,
    referral: '',
    terms: true,
  });
  const data = draft.upload(1, {
    name: 'resume.pdf',
    type: 'application/pdf',
    bytes: Buffer.from('bytes'),
  });
  let nextNode = 0;
  const text = (id: string, value: string, type = 'text') => ({
    nodeId: `doc:${++nextNode}`,
    blockId: null,
    id,
    name: '',
    tag: 'input' as const,
    type,
    value,
    disabled: false,
    required: false,
    visible: type !== 'hidden',
  });
  const select = (id: string, selected: number, options: [string, string][]) => ({
    ...text(id, options[selected]?.[0] ?? ''),
    tag: 'select' as const,
    type: 'select-one',
    selectedIndex: selected,
    options: options.map(([value, label], index) => ({
      value,
      label,
      selected: index === selected,
      disabled: false,
    })),
  });
  const native: NativeFormEvidence = {
    url: 'http://127.0.0.1:1234/',
    documentId: 'doc',
    form: { nodeId: 'doc:200', id: '', name: '', action: 'http://127.0.0.1:1234/', method: 'get' },
    controls: [
      text('fullName', 'Person'),
      { ...text('currentCompany', 'Current'), blockId: 'doc:100' },
      { ...text('previousCompany', 'Previous'), blockId: 'doc:101' },
      select('preference', 1, [
        ['', 'Choose'],
        ['remote', 'Remote'],
        ['hybrid', 'Hybrid'],
      ]),
      select('relocation', 0, [
        ['', 'Unanswered'],
        ['yes', 'Yes'],
        ['no', 'No'],
      ]),
      text('referral', ''),
      { ...text('terms', 'on', 'checkbox'), checked: true },
      text('source', 'direct', 'hidden'),
      {
        ...text('resume', 'C:\\fakepath\\resume.pdf', 'file'),
        files: [
          {
            name: 'resume.pdf',
            type: 'application/pdf',
            size: 5,
            lastModified: 1,
            sha256: data.attachment?.sha256 ?? '',
          },
        ],
      },
      { ...text('remove', ''), tag: 'button', type: 'button', text: 'Remove attachment' },
      {
        ...text('sync', ''),
        tag: 'button',
        type: 'button',
        disabled: true,
        text: `Draft sync ${JSON.stringify({
          version: 2,
          pending: 0,
          failed: false,
          preference: 'remote',
          attachment: { name: 'resume.pdf', type: 'application/pdf', size: 5 },
        })}`,
      },
    ],
  };
  const application = Object.assign(
    vi.fn(async () => ({
      status: 'ready' as const,
      evidence: structuredClone(data),
      evidenceRefIds: [],
    })),
    { assertAuthorized: vi.fn() }
  ) satisfies PreparedEvidenceRead;
  const page = {
    identity: { sessionId: 'session', pageId: 'page', sessionIncarnation: 'incarnation' },
    assertAuthority: vi.fn(),
    publication: { assertCurrent: vi.fn() },
    read: vi.fn(async () => structuredClone(native)),
  } satisfies PreparedNativeFormRead;
  const {
    version: _version,
    fields: _fields,
    attachment: _attachment,
    complete: _complete,
    missing: _missing,
    contract: _contract,
    ...identity
  } = data;
  const expected = {
    page: {
      ...page.identity,
      url: native.url,
      documentId: native.documentId,
      formNodeId: native.form.nodeId,
      controls: Object.fromEntries(
        native.controls.map(({ id, nodeId, blockId }) => [id, { nodeId, blockId }])
      ),
    },
    application: identity,
  };
  const collect = () => createDraftWitnessCollector({ application, page, expected });
  return { draft, data, native, application, page, expected, collect };
}

it('compares complete app/native snapshots twice, bounds and detaches the private witness', async () => {
  const f = fixture();
  const collect = f.collect();
  f.expected.page.url = 'https://caller-mutation.test/';
  const witness = await collect(new AbortController().signal);
  expect(witness.application).toEqual(f.data);
  expect(witness.page).toEqual(f.native);
  expect(f.application).toHaveBeenCalledTimes(2);
  expect(f.page.read).toHaveBeenCalledTimes(2);
  witness.application.fields.fullName = 'mutated';
  expect((await collect(new AbortController().signal)).application.fields.fullName).toBe('Person');
});

it.each(['url', 'documentId', 'formNodeId'] as const)(
  'refuses wrong pinned page %s',
  async (key) => {
    const f = fixture();
    f.expected.page[key] = 'wrong';
    await expect(f.collect()(new AbortController().signal)).rejects.toThrow(
      'Draft witness unavailable'
    );
  }
);

it.each(['sessionId', 'pageId', 'sessionIncarnation'] as const)(
  'refuses a foreign prepared page %s',
  (key) => {
    const f = fixture();
    f.expected.page[key] = 'wrong';
    expect(() => f.collect()).toThrow('Draft witness unavailable');
  }
);

it.each(['fullName', 'currentCompany', 'previousCompany', 'referral', 'source'])(
  'catches changed actual field %s despite idle counters',
  async (id) => {
    const f = fixture();
    const field = f.native.controls.find((control) => control.id === id);
    if (!field) throw new Error('fixture');
    field.value = 'different';
    await expect(f.collect()(new AbortController().signal)).rejects.toThrow();
  }
);

it.each([
  'extra',
  'omitted',
  'duplicate',
  'shared-block',
  'unchecked',
  'selection',
  'file',
  'pending',
  'failed',
  'version',
  'unknown-diagnostic',
])('refuses %s native evidence', async (mode) => {
  const f = fixture();
  const controls = Object.fromEntries(f.native.controls.map((control) => [control.id, control]));
  if (mode === 'extra')
    f.native.controls.push({ ...controls.fullName!, id: 'extra', nodeId: 'doc:201' });
  if (mode === 'omitted') f.native.controls.pop();
  if (mode === 'duplicate') controls.previousCompany!.nodeId = controls.currentCompany!.nodeId;
  if (mode === 'shared-block') controls.previousCompany!.blockId = controls.currentCompany!.blockId;
  if (mode === 'unchecked') controls.terms!.checked = false;
  if (mode === 'selection') controls.preference!.value = 'hybrid';
  if (mode === 'file') controls.resume!.files![0]!.sha256 = '0'.repeat(64);
  if (['pending', 'failed', 'version', 'unknown-diagnostic'].includes(mode)) {
    const diagnostic = JSON.parse(controls.sync!.text!.slice('Draft sync '.length));
    diagnostic[mode] = mode === 'failed' ? true : 1;
    controls.sync!.text = `Draft sync ${JSON.stringify(diagnostic)}`;
  }
  await expect(f.collect()(new AbortController().signal)).rejects.toThrow();
});

it.each(['application', 'page'] as const)(
  'refuses %s drift between collection reads',
  async (target) => {
    const f = fixture();
    if (target === 'application')
      f.application.mockResolvedValueOnce({
        status: 'ready',
        evidence: { ...f.data, version: 1 },
        evidenceRefIds: [],
      });
    else f.page.read.mockResolvedValueOnce({ ...f.native, documentId: 'old' });
    await expect(f.collect()(new AbortController().signal)).rejects.toThrow();
  }
);

it('withholds results on cancellation or revoked permission and sanitizes callback failures', async () => {
  const f = fixture();
  const abort = new AbortController();
  abort.abort();
  await expect(f.collect()(abort.signal)).rejects.toThrow('Draft witness unavailable');
  expect(f.application).not.toHaveBeenCalled();
  f.page.read.mockImplementationOnce(async () => {
    f.application.assertAuthorized.mockImplementation(() => {
      throw new Error('PRIVATE');
    });
    return f.native;
  });
  await expect(f.collect()(new AbortController().signal)).rejects.toThrow(
    'Draft witness unavailable'
  );
});

it('refuses a control-to-fieldset swap that happened before both consistent reads', async () => {
  const f = fixture();
  const collect = f.collect();
  const current = f.native.controls.find((control) => control.id === 'currentCompany');
  const previous = f.native.controls.find((control) => control.id === 'previousCompany');
  if (!current || !previous) throw new Error('fixture');
  [current.blockId, previous.blockId] = [previous.blockId, current.blockId];
  await expect(collect(new AbortController().signal)).rejects.toThrow('Draft witness unavailable');
});
