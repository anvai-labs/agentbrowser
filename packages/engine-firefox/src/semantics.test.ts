import { describe, expect, it } from 'vitest';
import { fingerprint } from './semantics.js';

describe('fingerprint', () => {
  it('joins role, name, visibility and enabled state, dropping empty segments', () => {
    expect(fingerprint({ role: 'button', name: 'Save', visible: true, enabled: true })).toBe(
      'button_Save_visible_true_enabled_true'
    );
    expect(fingerprint({ role: 'button', name: '', visible: false, enabled: false })).toBe(
      'button_visible_false_enabled_false'
    );
  });

  it('includes a non-empty value and omits an empty one', () => {
    expect(
      fingerprint({ role: 'textbox', name: 'Note', visible: true, enabled: true, value: 'draft' })
    ).toBe('textbox_Note_visible_true_enabled_true_value_draft');
    expect(
      fingerprint({ role: 'textbox', name: 'Note', visible: true, enabled: true, value: '' })
    ).toBe('textbox_Note_visible_true_enabled_true');
  });

  it('treats a missing name as empty', () => {
    expect(fingerprint({ role: 'generic', name: undefined, visible: true, enabled: true })).toBe(
      'generic_visible_true_enabled_true'
    );
  });
});
