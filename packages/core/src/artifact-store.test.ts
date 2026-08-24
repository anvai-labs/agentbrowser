/**
 * TDD Tests for the Artifact Store (TD-017)
 *
 * Artifacts (downloads, screenshots-as-evidence) live in a bounded,
 * TTL-expiring store: nothing accumulates forever, nothing outlives its
 * retention window, and oversize payloads are refused rather than truncated.
 */

import { describe, expect, it, beforeEach } from 'vitest';
import { ArtifactStore, ArtifactError } from './artifact-store';

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

  it('should clear with the store', () => {
    const artifacts = store();
    const { artifactId } = artifacts.put('download', 'text/plain', new Uint8Array([1]));

    artifacts.clear();

    expect(artifacts.get(artifactId)).toBeUndefined();
    expect(artifacts.count()).toBe(0);
  });
});
