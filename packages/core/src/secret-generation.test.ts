import { expect, it, vi } from 'vitest';
import { SecretManager } from './secret-manager.js';

it('captures a registered owner generation for late records without following reused identifiers', () => {
  const manager = new SecretManager({ 'vault://global': 'GlobalToken-123456' });
  manager.registerSessionSecret('owner', 'InitialCookie-123456');
  const redact = manager.captureRegisteredScopedRedactor('owner');
  manager.registerSessionSecret('owner', 'LaterCookie-987654');
  manager.clearSessionSecrets('owner');
  manager.registerSessionSecret('owner', 'ReplacementOwner-abcdef');
  expect(
    redact({
      'InitialCookie-123456': 'LaterCookie-987654 GlobalToken-123456 ReplacementOwner-abcdef',
    })
  ).toEqual({ '***': '*** *** ReplacementOwner-abcdef' });
  expect(manager.redactScoped('InitialCookie-123456', 'owner')).toBe('InitialCookie-123456');
});

it('registers a large valid seed in one atomic deduplicated compile', () => {
  const manager = new SecretManager();
  const values = Array.from(
    { length: 1000 },
    (_, i) => `${'abcD-123456789'.repeat(65)}-cookie-${i}`
  );
  const compile = vi.spyOn(manager as any, 'buildSessionPattern');
  manager.initializeSessionSecrets('owner', [...values, ...values]);
  expect(compile).toHaveBeenCalledOnce();
  const redact = manager.captureRegisteredScopedRedactor('owner')!;
  expect(redact(values.at(-1))).toBe('***');
  expect(compile).toHaveBeenCalledOnce();
});

it('keeps replacement-owner secrets when an old allocation cleanup runs', () => {
  const manager = new SecretManager();
  const clearOld = manager.initializeSessionSecrets('reused', ['OldOwnerSecret-1234']);
  const redactOld = manager.captureRegisteredScopedRedactor('reused')!;
  const clearNew = manager.initializeSessionSecrets('reused', ['NewOwnerSecret-5678']);
  clearOld();
  expect(manager.redactScoped('NewOwnerSecret-5678', 'reused')).toBe('***');
  expect(redactOld('OldOwnerSecret-1234 NewOwnerSecret-5678')).toBe('*** NewOwnerSecret-5678');
  clearNew();
  expect(manager.redactScoped('NewOwnerSecret-5678', 'reused')).toBe('NewOwnerSecret-5678');
});

it('does not install a partly registered batch when compilation fails', () => {
  const manager = new SecretManager();
  manager.initializeSessionSecrets('owner', ['ExistingOwnerSecret-1234']);
  vi.spyOn(manager as any, 'buildSessionPattern').mockImplementationOnce(() => {
    throw new Error('unpublishable secret');
  });
  expect(() => manager.registerSessionSecrets('owner', ['NewCookieSecret-5678'])).toThrow(
    'Credential redaction could not be initialized'
  );
  expect(manager.redactScoped('ExistingOwnerSecret-1234', 'owner')).toBe('***');
  expect(manager.redactScoped('NewCookieSecret-5678', 'owner')).toBe('NewCookieSecret-5678');
});

it('registers cookie values as literals rather than regular-expression authority', () => {
  const manager = new SecretManager();
  manager.initializeSessionSecrets('owner', ['Cookie[123]+(secret)?']);
  expect(manager.redactScoped('Cookie[123]+(secret)?', 'owner')).toBe('***');
  expect(manager.redactScoped('Cookie123secret', 'owner')).toBe('Cookie123secret');
});
