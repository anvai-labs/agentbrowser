import { SecretManager } from '@agentbrowser/core';
import type { PageState } from '@agentbrowser/protocol';
import { expect, it, vi } from 'vitest';
import { ownerPublication } from './owner-publication.js';

const COOKIE = 'OwnerCookiePrivacyCanary-123456';
const state = (): PageState => ({
  sessionId: 'owner',
  pageId: 'page',
  revision: 1,
  url: 'https://app.test/',
  title: COOKIE,
  status: 'interactive',
  elements: [
    {
      ref: 'e1_0',
      role: 'button',
      name: COOKIE,
      visible: true,
      enabled: true,
      attributes: { [COOKIE]: COOKIE, '***': 'kept' },
    },
  ],
  truncated: false,
  untrustedContent: true,
});
function fixture(globals: Record<string, string> = {}) {
  const secrets = new SecretManager(globals);
  secrets.initializeSessionSecrets('owner', [COOKIE]);
  secrets.registerSessionSecret('other', 'OtherTenantCookie-987654');
  const failure = vi.fn();
  const publication = ownerPublication(
    () => secrets.captureRegisteredScopedRedactor('owner'),
    failure
  );
  return { secrets, failure, publication };
}

it('redacts only owner values and untrusted attribute keys, retaining exact refs and input isolation', () => {
  const f = fixture();
  const source = state();
  source.elements[0]!.value = 'OtherTenantCookie-987654';
  const output = f.publication.pageState(source);
  expect(JSON.stringify(output)).not.toContain(COOKIE);
  expect(output.elements[0]).toMatchObject({
    ref: 'e1_0',
    name: '***',
    value: 'OtherTenantCookie-987654',
    attributes: { '***': '***', '***#1': 'kept' },
  });
  expect(source.elements[0]?.name).toBe(COOKIE);
  expect(f.failure).not.toHaveBeenCalled();
});

it('preserves trusted field keys and enum constants while redacting their use as page strings', () => {
  const f = fixture({
    'vault://status': 'status',
    'vault://interactive': 'interactive',
    'vault://name': 'name',
    'vault://risk': 'transaction',
  });
  const source = state();
  source.elements[0]!.name = 'interactive status name';
  source.elements[0]!.risk = 'transaction';
  const output = f.publication.pageState(source);
  expect(output.status).toBe('interactive');
  expect(output.elements[0]).toMatchObject({ name: '*** *** ***', risk: 'transaction' });
  expect(Object.hasOwn(output, 'status')).toBe(true);
  expect(Object.hasOwn(output.elements[0]!, 'name')).toBe(true);
});

it('keeps diff structural keys and constants while protecting changed values and attribute dictionaries', () => {
  const f = fixture({ 'vault://risk': 'transaction', 'vault://name': 'name' });
  const source = state();
  source.changes = [
    {
      ref: 'e1_0',
      change: 'modified',
      properties: {
        name: { old: COOKIE, new: COOKIE },
        attributes: { old: { [COOKIE]: COOKIE }, new: { [COOKIE]: COOKIE } },
        risk: { old: 'transaction', new: 'transaction' },
      },
    },
  ];
  const output = f.publication.pageState(source);
  expect(output.changes?.[0]).toMatchObject({
    ref: 'e1_0',
    change: 'modified',
    properties: {
      name: { old: '***', new: '***' },
      attributes: { old: { '***': '***' }, new: { '***': '***' } },
      risk: { old: 'transaction', new: 'transaction' },
    },
  });
});

it('redacts generated projection echoes and new/removed element payloads', () => {
  const f = fixture();
  const source = state();
  source.projection = { name: COOKIE, roles: [COOKIE], matched: 1, total: 1 };
  source.changes = [
    {
      ref: 'e1_0',
      change: 'added',
      properties: { element: { old: null, new: source.elements[0] } },
    },
  ];
  const output = f.publication.pageState(source);
  expect(output.projection).toMatchObject({ name: '***', roles: ['***'] });
  expect(output.changes?.[0]?.properties.element?.new).toMatchObject({ ref: 'e1_0', name: '***' });
  expect(JSON.stringify(output)).not.toContain(COOKIE);
});

it('retains its generation through additions and textual ID reuse', () => {
  const f = fixture();
  f.secrets.registerSessionSecrets('owner', ['LaterOwnerCookie-123456']);
  f.secrets.clearSessionSecrets('owner');
  f.secrets.initializeSessionSecrets('owner', ['ReplacementOwnerCookie-654321']);
  const source = state();
  source.title = `${COOKIE} LaterOwnerCookie-123456 ReplacementOwnerCookie-654321`;
  expect(f.publication.pageState(source).title).toBe('*** *** ReplacementOwnerCookie-654321');
});

it('refuses an identifier collision rather than changing a service ref or publishing the secret', () => {
  const f = fixture({ 'vault://ref': 'e1_0' });
  expect(() => f.publication.pageState(state())).toThrow(
    'Credential-safe operation publication failed'
  );
  expect(f.failure).toHaveBeenCalledOnce();
});

it('does not mistake inherited schema names for trusted DTO keys', () => {
  const f = fixture({ 'vault://dictionary': 'constructor' });
  const source = state();
  Object.defineProperty(source, 'constructor', { value: COOKIE, enumerable: true });
  const output = f.publication.pageState(source);
  expect(Object.hasOwn(output, 'constructor')).toBe(false);
  expect((output as unknown as Record<string, unknown>)['***']).toBe('***');
});

it('keeps unknown-field collision suffix work linear and preserves existing suffixed fields', () => {
  const f = fixture();
  const a = 'alphaSeed-123';
  const b = 'bravoSeed-456';
  f.secrets.registerSessionSecrets('owner', [a, b]);
  const bits = 9;
  const base = '***'.repeat(bits);
  const source = state();
  Object.defineProperty(source, `${base}#1`, { value: 'reserved', enumerable: true });
  for (let i = 0; i < 2 ** bits; i++) {
    const key = Array.from({ length: bits }, (_, bit) => ((i >> bit) & 1 ? a : b)).join('');
    Object.defineProperty(source, key, { value: `value-${i}`, enumerable: true });
  }
  const original = Object.hasOwn;
  let calls = 0;
  let output: PageState;
  Object.hasOwn = (value, key) => {
    calls++;
    return original(value, key);
  };
  try {
    output = f.publication.pageState(source);
  } finally {
    Object.hasOwn = original;
  }
  expect(calls).toBeLessThan(32 * 2 ** bits);
  const fields = output as unknown as Record<string, unknown>;
  expect(fields[`${base}#1`]).toBe('reserved');
  expect(fields[base]).toBe('value-0');
  expect(fields[`${base}#2`]).toBe('value-1');
});

it('withholds capture/refresh exception text and invokes captured failure handling once', () => {
  const failed = vi.fn(() => {
    throw new Error(COOKIE);
  });
  expect(() =>
    ownerPublication(() => {
      throw new Error(COOKIE);
    }, failed)
  ).toThrow('Credential-safe operation publication failed');
  expect(failed).toHaveBeenCalledOnce();
  const later = vi.fn();
  const publication = ownerPublication(
    () => () => {
      throw new Error(COOKIE);
    },
    later
  );
  for (const operation of [
    () => publication.values(COOKIE),
    () => publication.data({ [COOKIE]: COOKIE }),
  ])
    expect(operation).toThrow('Credential-safe operation publication failed');
  expect(later).toHaveBeenCalledOnce();
});

it('refuses cyclic, accessor-bearing or excessive-depth input before raw publication', () => {
  const f = fixture();
  const accessor = state();
  const getter = vi.fn(() => COOKIE);
  Object.defineProperty(accessor, 'title', { get: getter, enumerable: true });
  expect(() => f.publication.pageState(accessor)).toThrow(
    'Credential-safe operation publication failed'
  );
  expect(getter).not.toHaveBeenCalled();
  const cyclic = state() as PageState & { extra?: unknown };
  cyclic.extra = cyclic;
  expect(() => f.publication.pageState(cyclic)).toThrow();
  const deep = state() as PageState & { extra?: unknown };
  let child: Record<string, unknown> = deep as unknown as Record<string, unknown>;
  for (let i = 0; i < 40; i++) {
    child.extra = {};
    child = child.extra as Record<string, unknown>;
  }
  expect(() => f.publication.pageState(deep)).toThrow();
});
