/**
 * Time-boxed artifact authorization (spec 13.1)
 *
 * Artifact URLs are usable by anyone holding the URL while the artifact
 * lives. This mints short-lived signed tokens: GET /v1/artifacts/{id}?token=...
 * (or Authorization: Bearer) grants access until exp even from callers
 * without a session-scoped path. HMAC-SHA256 over artifactId|exp|sessionId
 * with the server key; constant-time compare.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

export interface ArtifactTokenOptions {
  /** Signing key; must be stable across restarts for tokens to survive. */
  key: string;
  /** Token lifetime in ms (default 5 minutes). */
  ttlMs?: number;
}

export class ArtifactAuthorizer {
  private readonly key: string;
  private readonly ttlMs: number;

  constructor(options: ArtifactTokenOptions) {
    this.key = options.key;
    this.ttlMs = options.ttlMs ?? 300_000;
  }

  /** Mint a token for one artifact, expiring now + ttl. */
  mint(artifactId: string, now = Date.now()): { token: string; expiresAt: number } {
    const expiresAt = now + this.ttlMs;
    const payload = `${artifactId}|${expiresAt}`;
    const signature = createHmac('sha256', this.key).update(payload).digest('hex');
    return { token: `${expiresAt}.${signature}`, expiresAt };
  }

  /** Verify a token for one artifact (expired = false, never throws). */
  verify(artifactId: string, token: string, now = Date.now()): boolean {
    const separator = token.indexOf('.');
    if (separator <= 0) {
      return false;
    }
    const expiresAt = Number.parseInt(token.slice(0, separator), 10);
    const signature = token.slice(separator + 1);
    if (!Number.isInteger(expiresAt) || now > expiresAt) {
      return false;
    }
    const expected = createHmac('sha256', this.key)
      .update(`${artifactId}|${expiresAt}`)
      .digest('hex');
    const a = Buffer.from(signature, 'utf8');
    const b = Buffer.from(expected, 'utf8');
    return a.length === b.length && timingSafeEqual(a, b);
  }
}
