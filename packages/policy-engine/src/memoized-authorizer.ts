import type { PolicyDecision } from '@agentbrowser/protocol';
import type { AuthorizationRequest, Authorizer } from './authorizer.js';

/**
 * TD-BROWSER-15 phase 4: the per-session memo. Egress checks run on every
 * network request, so each session memoizes its authorizer's decisions in a
 * bounded LRU (TD-BROWSER-9: fixed entry bound, cleared at close). The key is
 * the full structured request — the same request always decides the same way,
 * and the elision a smaller key would introduce is exactly what could make
 * two different questions share an answer.
 *
 * Address classes come from the fresh per-request classification, so a DNS
 * change changes the key.
 */
export class MemoizedAuthorizer implements Authorizer {
  readonly version: string;
  private readonly cache = new Map<string, PolicyDecision>();

  constructor(
    private readonly inner: Authorizer,
    /** Fixed entry bound; TD-BROWSER-9 discipline. */
    private readonly bound = 512
  ) {
    this.version = inner.version;
  }

  decide(request: AuthorizationRequest): PolicyDecision {
    const key = JSON.stringify([request.action, request.context]);
    const hit = this.cache.get(key);
    if (hit !== undefined) {
      // LRU touch: re-insert so the bound evicts the least recently used.
      this.cache.delete(key);
      this.cache.set(key, hit);
      return hit;
    }
    const decision = this.inner.decide(request);
    this.cache.set(key, decision);
    if (this.cache.size > this.bound) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    return decision;
  }

  /** Cleared at session close. */
  clear(): void {
    this.cache.clear();
  }

  get size(): number {
    return this.cache.size;
  }
}
