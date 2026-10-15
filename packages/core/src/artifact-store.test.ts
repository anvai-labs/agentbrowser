/**
 * TDD Tests for the Artifact Store (TD-017)
 *
 * Artifacts (downloads, screenshots-as-evidence) live in a bounded,
 * TTL-expiring store: nothing accumulates forever, nothing outlives its
 * retention window, and oversize payloads are refused rather than truncated.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { ArtifactError, ArtifactStore } from './artifact-store';

describe('ArtifactStore', () => {
  let clock: { now: number };

  beforeEach(() => {
    clock = { now: 1_000_000 };
  });

  const store = (options: ConstructorParameters<typeof ArtifactStore>[0] = {}) =>
    new ArtifactStore({ clock: () => clock.now, ...options });

  it('should store an artifact and return its metadata', () => {
    const artifacts = store();

    const artifact = artifacts.put('download', 'text/csv', new Uint8Array([1, 2, 3]), {
      filename: 'report.csv',
    });

    expect(artifact.artifactId).toEqual(expect.any(String));
    expect(artifact.type).toBe('download');
    expect(artifact.contentType).toBe('text/csv');
    expect(artifact.sizeBytes).toBe(3);
    expect(artifact.expiresAt).toBeGreaterThan(clock.now);
  });

  it('should retrieve stored bytes by id', () => {
    const artifacts = store();
    const bytes = new Uint8Array([9, 8, 7, 6]);
    const { artifactId } = artifacts.put('download', 'application/octet-stream', bytes);

    const entry = artifacts.get(artifactId);

    expect(entry?.bytes).toEqual(bytes);
    expect(entry?.metadata.sizeBytes).toBe(4);
  });

  it('should return undefined for unknown ids', () => {
    expect(store().get('art_missing')).toBeUndefined();
  });

  it('should expire entries after the TTL', () => {
    const artifacts = store({ ttlMs: 5_000 });
    const { artifactId } = artifacts.put('download', 'text/plain', new Uint8Array([1]));

    clock.now += 5_001;

    expect(artifacts.get(artifactId)).toBeUndefined();
  });

  it('should still serve entries inside the TTL', () => {
    const artifacts = store({ ttlMs: 5_000 });
    const { artifactId } = artifacts.put('download', 'text/plain', new Uint8Array([1]));

    clock.now += 4_999;

    expect(artifacts.get(artifactId)).toBeDefined();
  });

  it('should refuse oversized payloads with a typed error', () => {
    const artifacts = store({ maxBytes: 10 });

    try {
      artifacts.put('download', 'text/plain', new Uint8Array(11));
      throw new Error('expected put to reject');
    } catch (error) {
      expect(error).toBeInstanceOf(ArtifactError);
      expect((error as ArtifactError).code).toBe('ARTIFACT_TOO_LARGE');
    }
  });

  it('should evict the oldest entry when the store is full', () => {
    const artifacts = store({ maxArtifacts: 2 });

    const first = artifacts.put('download', 'text/plain', new Uint8Array([1]));
    clock.now += 1;
    const second = artifacts.put('download', 'text/plain', new Uint8Array([2]));
    clock.now += 1;
    const third = artifacts.put('download', 'text/plain', new Uint8Array([3]));

    expect(artifacts.get(first.artifactId)).toBeUndefined();
    expect(artifacts.get(second.artifactId)).toBeDefined();
    expect(artifacts.get(third.artifactId)).toBeDefined();
  });

  it('should sweep expired entries selectively', () => {
    const artifacts = store({ ttlMs: 1_000 });
    const first = artifacts.put('download', 'text/plain', new Uint8Array([1]));
    clock.now += 500; // still inside the TTL when the second is stored
    const second = artifacts.put('download', 'text/plain', new Uint8Array([2]));

    // Now only the first has expired (put() sweeps eagerly, so this sweep is
    // exercised without an intervening put).
    clock.now += 501;
    const swept = artifacts.sweep();

    expect(swept).toBe(1);
    expect(artifacts.get(first.artifactId)).toBeUndefined();
    expect(artifacts.get(second.artifactId)).toBeDefined();
  });

  describe('tenant-aware eviction and the aggregate byte cap', () => {
    const bytes = (size: number) => new Uint8Array(size);

    const owned = (artifacts: ArtifactStore, ids: string[]) =>
      ids.filter((id) => artifacts.get(id) !== undefined).length;

    it('lets a late tenant reach an equal share by evicting the largest holder', () => {
      const artifacts = store({ maxArtifacts: 4 });
      const b = [1, 2, 3, 4].map(
        () => artifacts.put('screenshot', 'image/png', bytes(1), { tenantId: 'b' }).artifactId
      );
      // Review regression: own-tenant-first eviction let a late tenant keep one artifact.
      const a = [1, 2].map(
        () => artifacts.put('screenshot', 'image/png', bytes(1), { tenantId: 'a' }).artifactId
      );
      expect(owned(artifacts, a)).toBe(2);
      expect(owned(artifacts, b)).toBe(2);
      expect(artifacts.get(b[0] as string)).toBeUndefined(); // b's oldest went first
      // At an equal share, a tie evicts the writer's own oldest.
      artifacts.put('screenshot', 'image/png', bytes(1), { tenantId: 'a' });
      expect(owned(artifacts, a)).toBe(1);
      expect(owned(artifacts, b)).toBe(2);
    });

    it('cannot flush another tenant below an equal byte share by alternating sizes', () => {
      const artifacts = store({ maxBytes: 10, maxTotalBytes: 40 });
      const b = [1, 2, 3, 4].map(
        () => artifacts.put('pdf', 'application/pdf', bytes(10), { tenantId: 'b' }).artifactId
      );
      // Review regression: small/large alternation used to evict ~10 bytes of b per pair.
      for (let round = 0; round < 20; round += 1) {
        artifacts.put('pdf', 'application/pdf', bytes(1), { tenantId: 'a' });
        artifacts.put('pdf', 'application/pdf', bytes(10), { tenantId: 'a' });
      }
      const bHeld = b.filter((id) => artifacts.get(id) !== undefined).length * 10;
      expect(bHeld).toBeGreaterThanOrEqual(20 - 10); // equal share of 40, within one artifact
      expect(artifacts.totalBytes()).toBeLessThanOrEqual(40);
    });

    it('evicts the heaviest writer from itself', () => {
      const artifacts = store({ maxArtifacts: 3 });
      const b = artifacts.put('screenshot', 'image/png', bytes(1), { tenantId: 'b' });
      const a1 = artifacts.put('screenshot', 'image/png', bytes(1), { tenantId: 'a' });
      artifacts.put('screenshot', 'image/png', bytes(1), { tenantId: 'a' });
      artifacts.put('screenshot', 'image/png', bytes(1), { tenantId: 'a' });
      expect(artifacts.get(b.artifactId)).toBeDefined();
      expect(artifacts.get(a1.artifactId)).toBeUndefined();
    });

    it('evicts until the new payload fits under maxTotalBytes', () => {
      const artifacts = store({ maxBytes: 10, maxTotalBytes: 20 });
      const first = artifacts.put('pdf', 'application/pdf', bytes(8));
      const second = artifacts.put('pdf', 'application/pdf', bytes(8));
      expect(artifacts.totalBytes()).toBe(16);
      const third = artifacts.put('pdf', 'application/pdf', bytes(10));

      expect(artifacts.get(first.artifactId)).toBeUndefined();
      expect(artifacts.get(second.artifactId)).toBeDefined();
      expect(artifacts.get(third.artifactId)).toBeDefined();
      expect(artifacts.totalBytes()).toBe(18);
    });

    it('keeps the byte total consistent through expiry, sweep and clear', () => {
      const artifacts = store({ ttlMs: 1_000 });
      const first = artifacts.put('pdf', 'application/pdf', bytes(5));
      clock.now += 600;
      artifacts.put('pdf', 'application/pdf', bytes(7));
      clock.now += 500;
      expect(artifacts.get(first.artifactId)).toBeUndefined();
      expect(artifacts.totalBytes()).toBe(7);
      clock.now += 1_000;
      artifacts.sweep();
      expect(artifacts.totalBytes()).toBe(0);
      artifacts.put('pdf', 'application/pdf', bytes(3));
      artifacts.clear();
      expect(artifacts.totalBytes()).toBe(0);
    });

    it('rejects a per-artifact limit above the aggregate cap', () => {
      expect(() => store({ maxBytes: 11, maxTotalBytes: 10 })).toThrow(ArtifactError);
    });
  });

  it('should clear with the store', () => {
    const artifacts = store();
    const { artifactId } = artifacts.put('download', 'text/plain', new Uint8Array([1]));

    artifacts.clear();

    expect(artifacts.get(artifactId)).toBeUndefined();
    expect(artifacts.count()).toBe(0);
  });
});
