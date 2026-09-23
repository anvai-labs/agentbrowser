import { expect, it } from 'vitest';
import { parseNativeFormEvidence } from './native-form-evidence.js';

function evidence() {
  return {
    url: 'https://example.test/apply',
    documentId: 'doc',
    form: {
      nodeId: 'doc:1',
      id: 'draft',
      name: '',
      action: 'https://example.test/save',
      method: 'post',
    },
    controls: [
      {
        nodeId: 'doc:2',
        blockId: null,
        id: 'name',
        name: 'name',
        tag: 'input',
        type: 'text',
        value: 'Private Name',
        disabled: false,
        required: true,
        visible: true,
      },
    ],
  };
}
it('returns detached complete native-form evidence', () => {
  const original = evidence();
  const parsed = parseNativeFormEvidence(original);
  const first = original.controls[0];
  if (!first) throw new Error('Missing fixture control');
  first.value = 'changed';
  expect(parsed.controls[0]?.value).toBe('Private Name');
});
it.each([null, false, 1, 'private', {}, [], { ...evidence(), private: 'PRIVATE' }])(
  'refuses malformed root %j',
  (input) => {
    expect(() => parseNativeFormEvidence(input)).toThrow('Native form evidence unavailable');
  }
);
it.each([
  'missing',
  'extra-form-key',
  'extra-control-key',
  'bad-bool',
  'bad-node',
  'wrong-document',
  'unexpected-checked',
  'oversize-value',
  'too-many-controls',
  'accessor',
  'duplicate-control',
  'forged-block',
  'aggregate',
] as const)('refuses invalid bounded shape: %s', (kind) => {
  const input = evidence();
  const first = input.controls[0];
  if (!first) throw new Error('Missing fixture control');
  if (kind === 'missing') Reflect.deleteProperty(first, 'value');
  if (kind === 'extra-form-key') Object.assign(input.form, { private: 'PRIVATE' });
  if (kind === 'extra-control-key') Object.assign(first, { private: 'PRIVATE' });
  if (kind === 'bad-bool') Object.assign(first, { required: 'true' });
  if (kind === 'bad-node') first.nodeId = '';
  if (kind === 'wrong-document') first.nodeId = 'other:2';
  if (kind === 'unexpected-checked') Object.assign(first, { checked: true });
  if (kind === 'oversize-value') first.value = 'x'.repeat(4097);
  if (kind === 'too-many-controls')
    input.controls = Array.from({ length: 33 }, (_, i) => ({
      ...first,
      id: `${i}`,
      nodeId: `doc:${i + 2}`,
    }));
  if (kind === 'accessor')
    Object.defineProperty(first, 'value', {
      get() {
        throw new Error('PRIVATE');
      },
    });
  if (kind === 'duplicate-control') input.controls.push({ ...first });
  if (kind === 'forged-block') Object.assign(first, { blockId: input.form.nodeId });
  if (kind === 'aggregate')
    input.controls = Array.from({ length: 20 }, (_, i) => ({
      ...first,
      id: `${i}`,
      nodeId: `doc:${i + 2}`,
      value: 'x'.repeat(4096),
    }));
  expect(() => parseNativeFormEvidence(input)).toThrow('Native form evidence unavailable');
});
it.each([
  'valid',
  'missing-option-field',
  'extra-option-key',
  'wrong-committed-value',
  'wrong-selected-index',
  'two-selected',
  'extra-file-key',
  'bad-digest',
  'too-large-file',
  'two-files',
  'nonfinite',
] as const)('validates selection/file variants: %s', (kind) => {
  const input = evidence();
  const first = input.controls[0];
  if (!first) throw new Error('Missing fixture control');
  const option = { value: 'remote', label: 'Remote', selected: true, disabled: false };
  const file = {
    name: 'resume.pdf',
    type: 'application/pdf',
    size: 32768,
    lastModified: 1,
    sha256: 'a'.repeat(64),
  };
  Object.assign(first, {
    tag: 'select',
    type: 'select-one',
    value: 'remote',
    selectedIndex: 0,
    options: [option],
  });
  const attachment = {
    ...first,
    id: 'file',
    nodeId: 'doc:3',
    tag: 'input',
    type: 'file',
    value: 'C:\\fakepath\\resume.pdf',
    files: [file],
  } as Record<string, unknown>;
  Reflect.deleteProperty(attachment, 'options');
  Reflect.deleteProperty(attachment, 'selectedIndex');
  input.controls.push(attachment as typeof first);
  if (kind === 'missing-option-field') Reflect.deleteProperty(option, 'selected');
  if (kind === 'extra-option-key') Object.assign(option, { secret: 'PRIVATE' });
  if (kind === 'wrong-committed-value') first.value = 'hybrid';
  if (kind === 'wrong-selected-index') Object.assign(first, { selectedIndex: 1 });
  if (kind === 'two-selected') Object.assign(first, { options: [option, option] });
  if (kind === 'extra-file-key') Object.assign(file, { secret: 'PRIVATE' });
  if (kind === 'bad-digest') file.sha256 = 'A'.repeat(64);
  if (kind === 'too-large-file') file.size++;
  if (kind === 'two-files') attachment.files = [file, file];
  if (kind === 'nonfinite') file.lastModified = Number.NaN;
  if (kind === 'valid') expect(parseNativeFormEvidence(input)).toEqual(input);
  else expect(() => parseNativeFormEvidence(input)).toThrow('Native form evidence unavailable');
});

it.each([['get'], ['post'], ['dialog']])(
  'refuses an array masquerading as form method %j',
  (...method) => {
    const input = evidence();
    Object.assign(input.form, { method });
    expect(() => parseNativeFormEvidence(input)).toThrow('Native form evidence unavailable');
  }
);

it.each(['tag', 'type'] as const)('refuses an array masquerading as control %s', (field) => {
  const input = evidence();
  const control = input.controls[0];
  if (!control) throw new Error('Missing fixture control');
  Object.assign(control, { [field]: [control[field]] });
  expect(() => parseNativeFormEvidence(input)).toThrow('Native form evidence unavailable');
});
