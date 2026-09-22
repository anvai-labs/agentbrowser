/**
 * TDD Tests for the Secret Manager (TD-016)
 *
 * Safety invariant: a registered secret value must never appear in any
 * output the service produces - logs, error messages, observations, or
 * serialized forms thereof. Values are addressed by vault reference and
 * resolved only at the moment of use.
 */

import { describe, expect, it } from 'vitest';
import { SecretError, SecretManager } from './secret-manager';

describe('SecretManager', () => {
  describe('reference resolution', () => {
    it('should resolve a vault reference to its value', async () => {
      const manager = new SecretManager({
        'vault://tenant/login/password': 'hunter2-correct-horse',
      });

      await expect(manager.resolve('vault://tenant/login/password')).resolves.toBe(
        'hunter2-correct-horse'
      );
    });

    it('should resolve multiple distinct references', async () => {
      const manager = new SecretManager({
        'vault://tenant/login/user': 'agent@example.com',
        'vault://tenant/login/token': 'tok_abc123',
      });

      await expect(manager.resolve('vault://tenant/login/user')).resolves.toBe('agent@example.com');
      await expect(manager.resolve('vault://tenant/login/token')).resolves.toBe('tok_abc123');
    });

    it('should reject an unknown reference with a typed error', async () => {
      const manager = new SecretManager({});

      try {
        await manager.resolve('vault://tenant/login/missing');
        throw new Error('expected resolve to reject');
      } catch (error) {
        expect(error).toBeInstanceOf(SecretError);
        expect((error as SecretError).code).toBe('SECRET_NOT_FOUND');
        // The reference is an identifier, not a secret, so it may appear.
        expect((error as SecretError).message).toContain('vault://tenant/login/missing');
      }
    });

    it('should report whether a value is a secret reference', () => {
      const manager = new SecretManager({});
      expect(manager.isReference('vault://x/y')).toBe(true);
      expect(manager.isReference('plain-text-input')).toBe(false);
    });

    it('should resolve through an indirect reference once (no chains)', async () => {
      const manager = new SecretManager({
        'vault://a': 'vault://b',
        'vault://b': 'final-value',
      });
      // The stored value happens to look like a reference; it is a value,
      // not dereferenced again.
      await expect(manager.resolve('vault://a')).resolves.toBe('vault://b');
    });

    it('keeps the rejected input out of the INVALID_REFERENCE message', async () => {
      // A credential pasted where a reference belongs must never be echoed:
      // the value is unregistered, so redact() can never scrub it downstream.
      const manager = new SecretManager({});
      const error: unknown = await manager.resolve('plain-text-password').then(
        () => {
          throw new Error('expected resolve to reject');
        },
        (e: unknown) => e
      );
      expect(error).toBeInstanceOf(SecretError);
      expect((error as SecretError).code).toBe('INVALID_REFERENCE');
      expect((error as SecretError).message).not.toContain('plain-text-password');
    });
  });

  describe('redaction', () => {
    it('should redact a known secret from a string', () => {
      const manager = new SecretManager({ 'vault://p': 'swordfish' });

      const safe = manager.redact('login failed for password=swordfish');

      expect(safe).not.toContain('swordfish');
      expect(safe).toContain('***');
    });

    it('should redact secrets nested in objects and arrays', () => {
      const manager = new SecretManager({
        'vault://p': 'swordfish',
        'vault://t': 'tok_abc123',
      });

      const safe = manager.redact({
        action: 'fill',
        value: 'swordfish',
        context: { token: 'tok_abc123', notes: ['token tok_abc123 expired'] },
      });

      const serialized = JSON.stringify(safe);
      expect(serialized).not.toContain('swordfish');
      expect(serialized).not.toContain('tok_abc123');
      expect(serialized).toContain('***');
    });

    it('should leave non-secret content untouched', () => {
      const manager = new SecretManager({ 'vault://p': 'swordfish' });

      const safe = manager.redact({ message: 'all good', count: 3 });

      expect(safe).toEqual({ message: 'all good', count: 3 });
    });

    it('should match the longest secret first when values overlap', () => {
      const manager = new SecretManager({
        'vault://short': 'abc',
        'vault://long': 'abcdef',
      });

      const safe = manager.redact('value=abcdef');

      expect(safe).not.toContain('abcdef');
      expect(safe).toContain('***');
    });

    it('should return input unchanged when no secrets are registered', () => {
      const manager = new SecretManager({});
      expect(manager.redact('anything at all')).toBe('anything at all');
    });

    it('should redact secrets that appear in error messages', () => {
      const manager = new SecretManager({ 'vault://p': 'swordfish' });

      const safe = manager.redact(new Error('auth failed for swordfish').message);

      expect(safe).not.toContain('swordfish');
    });
  });

  describe('untrusted dictionary redaction (keys are untrusted too)', () => {
    it('passes strings and keys through untouched when no secrets are registered', () => {
      const manager = new SecretManager({});
      const input = { plain: 'value', nested: { k: ['a', 1, null] } };

      expect(manager.redactUntrusted(input)).toEqual(input);
    });

    it('redacts secret occurrences in both keys and values of page-supplied dictionaries', () => {
      const manager = new SecretManager({ 'vault://p': 'swordfish' });

      const safe = manager.redactUntrusted({
        swordfish: 'leaks the swordfish',
        note: 'key never redacted without the untrusted variant',
        more: { 'contains swordfish': 1 },
      });
      const serialized = JSON.stringify(safe);

      expect(serialized).not.toContain('swordfish');
      expect(safe['***']).toBe('leaks the ***');
      expect(safe.note).toBe('key never redacted without the untrusted variant');
      expect((safe.more as Record<string, unknown>)['contains ***']).toBe(1);
    });

    it('keeps both values when redacted key names collide', () => {
      const manager = new SecretManager({
        'vault://a': 'x key',
        'vault://b': 'key',
      });

      const safe = manager.redactUntrusted({ 'x key': 'v1', key: 'v2' });

      // 'x key' -> '***' collides with 'key' -> '***'; the second is
      // disambiguated instead of silently overwriting the first.
      expect(Object.keys(safe)).toEqual(['***', '***#1']);
      expect(Object.values(safe)).toEqual(['v1', 'v2']);
    });
  });

  describe('safety invariants', () => {
    it('must never expose a registered value through redact output', () => {
      const manager = new SecretManager({
        'vault://tenant/login/password': 'correct-horse-battery-staple',
      });

      const candidates = [
        'fill password=correct-horse-battery-staple',
        { value: 'correct-horse-battery-staple' },
        ['nested', { secret: 'correct-horse-battery-staple' }],
      ];

      for (const candidate of candidates) {
        expect(JSON.stringify(manager.redact(candidate))).not.toContain(
          'correct-horse-battery-staple'
        );
      }
    });

    it('should list references without ever exposing values', () => {
      const manager = new SecretManager({ 'vault://p': 'swordfish' });

      expect(manager.references()).toEqual(['vault://p']);
      expect(JSON.stringify(manager)).not.toContain('swordfish');
    });
  });

  describe('redaction cache (TD-BROWSER-9, A1)', () => {
    it('should redact correctly with the cache disabled (maxEntries: 0)', () => {
      const manager = new SecretManager(
        { 'vault://p': 'swordfish' },
        { redactionCacheMaxEntries: 0 }
      );

      // Repeat the same string to exercise the cache-miss path every time.
      expect(manager.redact('login failed for swordfish')).not.toContain('swordfish');
      expect(manager.redact('login failed for swordfish')).not.toContain('swordfish');
    });

    it('should evict the least-recently-used entry once the cap is hit', () => {
      const manager = new SecretManager(
        { 'vault://p': 'swordfish' },
        { redactionCacheMaxEntries: 2 }
      );

      // Three distinct strings through a cache capped at two entries: this
      // must never throw and must keep redacting correctly regardless of
      // which entries were evicted.
      const inputs = [
        'contains swordfish once',
        'contains swordfish twice',
        'contains swordfish thrice',
      ];
      for (const input of inputs) {
        expect(manager.redact(input)).not.toContain('swordfish');
      }
      // Re-redacting the first (likely evicted) input must still be correct.
      expect(manager.redact(inputs[0] as string)).not.toContain('swordfish');
    });
  });
});
