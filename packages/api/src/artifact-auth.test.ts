/**
 * TDD Tests for time-boxed artifact authorization (spec 13.1)
 */

import { describe, expect, it } from 'vitest';
import { ArtifactAuthorizer } from './artifact-auth';

describe('ArtifactAuthorizer', () => {
  it('should mint a token that verifies for its artifact', () => {
    const auth = new ArtifactAuthorizer({ key: 'test-key' });
    const { token, expiresAt } = auth.mint('art_1');

    expect(auth.verify('art_1', token)).toBe(true);
    expect(expiresAt).toBeGreaterThan(Date.now());
  });

  it('should reject a token minted for a different artifact', () => {
    const auth = new ArtifactAuthorizer({ key: 'test-key' });
    const { token } = auth.mint('art_1');

    expect(auth.verify('art_2', token)).toBe(false);
  });

  it('should reject an expired token', () => {
    const auth = new ArtifactAuthorizer({ key: 'test-key', ttlMs: 100 });
    const { token } = auth.mint('art_1', Date.now() - 1000);

    expect(auth.verify('art_1', token)).toBe(false);
  });

  it('should reject tampered signatures and malformed tokens', () => {
    const auth = new ArtifactAuthorizer({ key: 'test-key' });
    const { token } = auth.mint('art_1');

    expect(auth.verify('art_1', `9999999999.${token.split('.')[1]}`)).toBe(false);
    expect(auth.verify('art_1', 'garbage')).toBe(false);
    expect(auth.verify('art_1', '')).toBe(false);
  });

  it('should not verify across keys', () => {
    const minting = new ArtifactAuthorizer({ key: 'key-a' });
    const verifying = new ArtifactAuthorizer({ key: 'key-b' });
    const { token } = minting.mint('art_1');

    expect(verifying.verify('art_1', token)).toBe(false);
  });
});
