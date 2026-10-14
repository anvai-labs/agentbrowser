/**
 * Secret Manager (TD-016)
 *
 * Credentials are addressed by vault reference (vault://...) and resolved
 * only at the moment of use. The safety invariant: a registered secret value
 * must never appear in anything the service emits - logs, error messages,
 * observations, or their serialized forms. redact() enforces that boundary.
 */

import { BoundedCache } from './bounded-cache.js';

/** Raised for reference resolution failures. */
export class SecretError extends Error {
  constructor(
    public code: string,
    message: string
  ) {
    super(message);
    this.name = 'SecretError';
  }
}

const REDACTED = '***';
const REFERENCE_PREFIX = 'vault://';

export interface SecretManagerOptions {
  /**
   * Bound on the redaction memo (TD-BROWSER-9, A1): without a cap it grows
   * with every distinct string ever redacted over process uptime. `0`
   * disables the cache entirely - redaction stays correct, just uncached.
   * Governs the global memo AND every per-session memo.
   */
  redactionCacheMaxEntries?: number;
  /**
   * Bound on tracked session scopes (TD-BROWSER-9, A9): each scope holds its
   * values, pattern and memo; without a cross-scope bound, closed sessions
   * would retain memory for process uptime. Least-recently-used scopes are
   * evicted; `0` disables session scopes entirely.
   */
  sessionScopesMaxSessions?: number;
}

/** Values too weak to be worth redacting: under 8 characters, or fewer than
 * 3 distinct characters (repeats like "aaaaaaaa"). A fixed, documented
 * threshold (TD-BROWSER-16 phase 2, ADR-025 §6). */
const MIN_SECRET_LENGTH = 8;
const MIN_DISTINCT_CHARACTERS = 3;
function negligibleEntropy(value: string): boolean {
  return value.length < MIN_SECRET_LENGTH || new Set(value).size < MIN_DISTINCT_CHARACTERS;
}

export class SecretManager {
  private readonly secrets: Map<string, string>;
  /** Values sorted longest-first so overlapping secrets redact fully. */
  private sortedValues: string[] = [];
  /** Precompiled regex pattern for efficient redaction. */
  private redactionPattern: RegExp | null = null;
  /** Cache of already-redacted strings to avoid repeated work. */
  private readonly redactionCache: BoundedCache<string, string>;
  /**
   * TD-BROWSER-16 phase 2: per-session scopes. A value registered in a
   * session's scope redacts only that session's observations, logs, traces
   * and errors — never another session's, and never the global surface.
   */
  private readonly sessionSecrets = new Map<string, string[]>();
  private readonly sessionPatterns = new Map<string, RegExp | null>();
  private readonly sessionCaches = new Map<string, BoundedCache<string, string>>();
  private readonly sessionCacheMaxEntries: number;
  private readonly sessionScopesBound: number;

  constructor(secrets: Record<string, string> = {}, options: SecretManagerOptions = {}) {
    this.redactionCache = new BoundedCache({
      maxEntries: options.redactionCacheMaxEntries ?? 10_000,
    });
    this.sessionCacheMaxEntries = options.redactionCacheMaxEntries ?? 10_000;
    this.sessionScopesBound = options.sessionScopesMaxSessions ?? 512;
    this.secrets = new Map(Object.entries(secrets));
    this.sortedValues = [...this.secrets.values()]
      .filter((value) => value.length > 0)
      .sort((a, b) => b.length - a.length);
    this.buildRedactionPattern();
  }

  /**
   * Build a precompiled regex pattern for all secrets.
   * Special regex characters are properly escaped.
   */
  private buildRedactionPattern(): void {
    if (this.sortedValues.length === 0) {
      this.redactionPattern = null;
      return;
    }

    // Escape special regex characters in secrets
    const escaped = this.sortedValues.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const pattern = escaped.join('|');
    this.redactionPattern = new RegExp(pattern, 'g');
  }

  /** Whether a value looks like a secret reference. */
  isReference(value: string): boolean {
    return value.startsWith(REFERENCE_PREFIX);
  }

  /** Resolve a reference to its secret value, for use at execution time only. */
  async resolve(reference: string): Promise<string> {
    if (!this.isReference(reference)) {
      // Never echo the rejected input: callers paste real credentials here by
      // mistake, and an unregistered value cannot be redacted downstream.
      throw new SecretError(
        'INVALID_REFERENCE',
        `Not a secret reference: values must start with ${REFERENCE_PREFIX} (input withheld)`
      );
    }
    const value = this.secrets.get(reference);
    if (value === undefined) {
      // Same withholding rule: the reference body is arbitrary caller text
      // and may itself be a pasted credential.
      throw new SecretError(
        'SECRET_NOT_FOUND',
        'No secret registered for that reference (input withheld)'
      );
    }
    return value;
  }

  /**
   * Replace every occurrence of every registered secret with `***`. Walks
   * objects and arrays recursively; returns anything else with strings
   * scrubbed and other primitives unchanged.
   */
  redact<T>(input: T): T {
    if (this.sortedValues.length === 0) {
      return input;
    }
    return this.redactValue(input) as T;
  }

  /**
   * TD-BROWSER-16 phase 2: redact with a session's scope — the global values
   * plus exactly that session's registered values.
   */
  redactScoped<T>(input: T, sessionId: string): T {
    if (this.sessionSecrets.get(sessionId) === undefined && this.sortedValues.length === 0) {
      return input;
    }
    return this.redactValue(input, false, sessionId) as T;
  }

  /** The untrusted-key variant with a session's scope (phase 6 wiring). */
  redactUntrustedScoped(input: Record<string, unknown>, sessionId: string): Record<string, unknown>;
  redactUntrustedScoped(input: unknown, sessionId: string): unknown;
  redactUntrustedScoped(input: unknown, sessionId: string): unknown {
    if (this.sessionSecrets.get(sessionId) === undefined && this.sortedValues.length === 0) {
      return input;
    }
    return this.redactValue(input, true, sessionId);
  }

  /**
   * Register a value in one session's scope (TD-BROWSER-16 phase 2). Values
   * under the entropy floor are ignored: redacting "1", "en" or "true" would
   * corrupt unrelated output while protecting nothing. Registration
   * invalidates that scope's memoized redaction cache.
   */
  registerSessionSecret(sessionId: string, value: string): void {
    if (this.sessionScopesBound === 0 || negligibleEntropy(value)) return;
    const values = this.sessionSecrets.get(sessionId) ?? [];
    if (!values.includes(value)) values.push(value);
    // Longest-first, so overlapping values redact fully.
    values.sort((a, b) => b.length - a.length);
    this.sessionSecrets.set(sessionId, values);
    this.evictStaleScopes();
    this.buildSessionPattern(sessionId, values);
    // The cached results no longer reflect the new value.
    this.sessionCaches.delete(sessionId);
  }

  /**
   * TD-BROWSER-9, A9: bound the number of live scopes, evicting the least
   * recently used (Map insertion order; a scope touches its own entry on
   * registration). Evicting a scope only loses its redaction memo — values
   * are re-registered by the caller that owns them (phase 6 re-registers at
   * handoff), and correctness never depended on the cache.
   */
  private evictStaleScopes(): void {
    while (this.sessionScopesBound > 0 && this.sessionSecrets.size > this.sessionScopesBound) {
      const oldest = this.sessionSecrets.keys().next().value;
      if (oldest === undefined) break;
      this.clearSessionSecrets(oldest);
    }
  }

  /** A session's registered values leave with it. */
  clearSessionSecrets(sessionId: string): void {
    this.sessionSecrets.delete(sessionId);
    this.sessionPatterns.delete(sessionId);
    this.sessionCaches.delete(sessionId);
  }

  private buildSessionPattern(sessionId: string, values: string[]): void {
    const all = [...values, ...this.sortedValues].sort((a, b) => b.length - a.length);
    this.sessionPatterns.set(
      sessionId,
      all.length === 0
        ? null
        : new RegExp(all.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g')
    );
  }

  /** Registered references, for inventory. Values never leave this class. */
  references(): string[] {
    return [...this.secrets.keys()];
  }

  /** Page/model dictionary keys are untrusted too; trusted protocol keys stay intact in redact(). */
  redactUntrusted(input: Record<string, unknown>): Record<string, unknown>;
  redactUntrusted(input: unknown): unknown;
  redactUntrusted(input: unknown): unknown {
    return this.redactValue(input, true);
  }

  /**
   * Safe serialization: accidental JSON.stringify of the manager must never
   * leak values, so it renders as a reference inventory only.
   */
  toJSON(): unknown {
    return { redacted: true, references: this.references() };
  }

  private redactValue(value: unknown, redactKeys = false, scope?: string): unknown {
    if (typeof value === 'string') {
      return this.redactString(value, scope);
    }
    if (Array.isArray(value)) {
      return value.map((item) => this.redactValue(item, redactKeys, scope));
    }
    if (value !== null && typeof value === 'object') {
      const seen = new Set<string>();
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => {
          const base = redactKeys ? this.redactString(key, scope) : key;
          let safeKey = base;
          let suffix = 1;
          // Preserve both values if redacted names collide, without exposing
          // original keys. fromEntries also treats __proto__ as an own key.
          while (seen.has(safeKey)) safeKey = `${base}#${suffix++}`;
          seen.add(safeKey);
          return [safeKey, this.redactValue(item, redactKeys, scope)];
        })
      );
    }
    return value;
  }

  private redactString(text: string, scope?: string): string {
    if (scope === undefined) {
      const cached = this.redactionCache.get(text);
      if (cached !== undefined) return cached;
      if (!this.redactionPattern) return text;
      const redacted = text.replace(this.redactionPattern, REDACTED);
      this.redactionCache.set(text, redacted);
      return redacted;
    }
    // Session scope: its own pattern and its own cache (invalidated on
    // registration; the option governs it like the global memo). An unknown
    // scope never allocates: only registered scopes get a cache.
    const cache =
      this.sessionCaches.get(scope) ??
      (this.sessionSecrets.has(scope)
        ? new BoundedCache<string, string>({ maxEntries: this.sessionCacheMaxEntries })
        : undefined);
    if (cache !== undefined) {
      const cached = cache.get(text);
      if (cached !== undefined) return cached;
    }
    const pattern = this.sessionPatterns.get(scope) ?? this.redactionPattern;
    if (!pattern) return text;
    const redacted = text.replace(pattern, REDACTED);
    if (cache !== undefined) {
      if (!this.sessionCaches.has(scope)) this.sessionCaches.set(scope, cache);
      cache.set(text, redacted);
    }
    return redacted;
  }
}
