import { VERIFICATION_SNAPSHOT_LIMITS, snapshotJsonData } from '@agentbrowser/protocol';
import { EngineError } from './errors.js';
import type { NativeFormEvidence } from './types.js';

/** Shared capture/parser bounds, independent of any named application's field schema. */
export const NATIVE_FORM_EVIDENCE_LIMITS = Object.freeze({
  treeElements: 10_000,
  controls: 32,
  options: 32,
  files: 1,
  fileBytes: 32 * 1024,
  identifier: 512,
  value: 4096,
  text: 4096,
  url: 2048,
  mimeType: 127,
  serializedBytes: VERIFICATION_SNAPSHOT_LIMITS.maxBytes,
  inputTypes: Object.freeze([
    'text',
    'email',
    'tel',
    'url',
    'search',
    'number',
    'password',
    'hidden',
    'checkbox',
    'radio',
    'file',
    'button',
    'submit',
    'reset',
  ]),
});

/** Strict detached internal evidence; this validates shape, not page/application truth. */
export function parseNativeFormEvidence(input: unknown): NativeFormEvidence {
  try {
    const limits = NATIVE_FORM_EVIDENCE_LIMITS;
    const snapshot = snapshotJsonData(input, VERIFICATION_SNAPSHOT_LIMITS);
    if (Buffer.byteLength(JSON.stringify(snapshot), 'utf8') > limits.serializedBytes)
      throw new Error();
    const record = (value: unknown, keys: readonly string[]): Record<string, unknown> => {
      if (
        !value ||
        typeof value !== 'object' ||
        Array.isArray(value) ||
        Object.keys(value).length !== keys.length ||
        keys.some((key) => !Object.hasOwn(value, key))
      )
        throw new Error();
      return value as Record<string, unknown>;
    };
    const string = (value: unknown, maximum: number): string => {
      if (typeof value !== 'string' || value.length > maximum) throw new Error();
      return value;
    };
    const boolean = (value: unknown) => {
      if (typeof value !== 'boolean') throw new Error();
    };
    const root = record(snapshot, ['url', 'documentId', 'form', 'controls']);
    const documentId = string(root.documentId, 128);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(documentId)) throw new Error();
    const token = (value: unknown): string => {
      const text = string(value, 160);
      if (
        !text.startsWith(`${documentId}:`) ||
        !/^[1-9][0-9]*$/.test(text.slice(documentId.length + 1)) ||
        !Number.isSafeInteger(Number(text.slice(documentId.length + 1)))
      )
        throw new Error();
      return text;
    };
    string(root.url, limits.url);
    const form = record(root.form, ['nodeId', 'id', 'name', 'action', 'method']);
    const identities = new Set([token(form.nodeId)]);
    string(form.id, limits.identifier);
    string(form.name, limits.identifier);
    string(form.action, limits.url);
    if (typeof form.method !== 'string' || !['get', 'post', 'dialog'].includes(form.method))
      throw new Error();
    if (
      !Array.isArray(root.controls) ||
      root.controls.length < 1 ||
      root.controls.length > limits.controls
    )
      throw new Error();
    const ids = new Set<string>();
    if (form.id) ids.add(form.id as string);
    const blocks = new Set<string>();
    let files = 0;
    for (const candidate of root.controls) {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate))
        throw new Error();
      const tag = candidate.tag;
      const type = candidate.type;
      if (!['input', 'select', 'textarea', 'button'].includes(tag)) throw new Error();
      if (
        (tag === 'input' && !limits.inputTypes.includes(type)) ||
        (tag === 'select' && type !== 'select-one') ||
        (tag === 'textarea' && type !== 'textarea') ||
        (tag === 'button' && !['button', 'submit', 'reset'].includes(type))
      )
        throw new Error();
      const fields = [
        'nodeId',
        'blockId',
        'id',
        'name',
        'tag',
        'type',
        'value',
        'disabled',
        'required',
        'visible',
      ];
      if (tag === 'select') fields.push('options', 'selectedIndex');
      if (tag === 'button') fields.push('text');
      if (tag === 'input' && ['checkbox', 'radio'].includes(type)) fields.push('checked');
      if (tag === 'input' && type === 'file') fields.push('files');
      const control = record(candidate, fields);
      const identity = token(control.nodeId);
      if (identities.has(identity)) throw new Error();
      identities.add(identity);
      if (control.blockId !== null) blocks.add(token(control.blockId));
      const id = string(control.id, limits.identifier);
      if (id) {
        if (ids.has(id)) throw new Error();
        ids.add(id);
      }
      string(control.name, limits.identifier);
      string(control.value, limits.value);
      boolean(control.disabled);
      boolean(control.required);
      boolean(control.visible);
      if ('checked' in control) boolean(control.checked);
      if ('text' in control) string(control.text, limits.text);
      if ('options' in control) {
        if (
          !Array.isArray(control.options) ||
          control.options.length > limits.options ||
          typeof control.selectedIndex !== 'number' ||
          !Number.isInteger(control.selectedIndex) ||
          control.selectedIndex < -1 ||
          control.selectedIndex >= control.options.length
        )
          throw new Error();
        for (const [index, candidate] of control.options.entries()) {
          const option = record(candidate, ['value', 'label', 'selected', 'disabled']);
          string(option.value, limits.value);
          string(option.label, limits.identifier);
          boolean(option.selected);
          boolean(option.disabled);
          if (option.selected !== (index === control.selectedIndex)) throw new Error();
        }
        if (control.value !== (control.options[control.selectedIndex]?.value ?? ''))
          throw new Error();
      }
      if ('files' in control) {
        if (!Array.isArray(control.files)) throw new Error();
        files += control.files.length;
        if (files > limits.files) throw new Error();
        for (const candidate of control.files) {
          const file = record(candidate, ['name', 'type', 'size', 'lastModified', 'sha256']);
          string(file.name, limits.identifier);
          string(file.type, limits.mimeType);
          if (
            typeof file.size !== 'number' ||
            !Number.isSafeInteger(file.size) ||
            file.size < 0 ||
            file.size > limits.fileBytes ||
            typeof file.lastModified !== 'number' ||
            !Number.isSafeInteger(file.lastModified) ||
            typeof file.sha256 !== 'string' ||
            !/^[a-f0-9]{64}$/.test(file.sha256)
          )
            throw new Error();
        }
      }
    }
    if ([...blocks].some((block) => identities.has(block))) throw new Error();
    return snapshot as NativeFormEvidence;
  } catch {
    throw new EngineError('ENGINE_UNSUPPORTED', 'Native form evidence unavailable');
  }
}
