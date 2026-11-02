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
   * Bound on session scopes (TD-BROWSER-9, A9), enforced in two directions:
   * per-session redaction MEMOS are kept for at most this many scopes
   * (least-recently-USED, so a hot scope keeps its memo); and registration
   * FAILS CLOSED once this many live (registered, uncleared) scopes exist —
   * a live session's secret values are never silently un-protected.
   * `0` disables session scopes entirely.
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
  private readonly sessionGenerations = new Map<
    string,
    { values: string[]; pattern: RegExp | null }
  >();
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

  /**
   * Capture an already-registered owner for in-flight records after teardown.
   * Later additions to that generation stay protected; a reused ID does not
   * replace the captured registry. No registry values leave this closure.
   */
  captureRegisteredScopedRedactor(
    sessionId: string
  ): ((input: unknown, redactKeys?: boolean) => unknown) | undefined {
    const owner = this.sessionGenerations.get(sessionId);
    if (!owner) return undefined;
    const redactor = new SecretManager(
      {},
      { redactionCacheMaxEntries: 0, sessionScopesMaxSessions: 0 }
    );
    let values: string[] | undefined;
    const refresh = () => {
      redactor.sortedValues = [...this.sortedValues, ...owner.values];
      redactor.redactionPattern = owner.pattern;
      values = owner.values;
      redactor.redact('');
    };
    refresh();
    return (input, redactKeys = true) => {
      if (values !== owner.values) refresh();
      return redactKeys ? redactor.redactUntrusted(input) : redactor.redact(input);
    };
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
    if (this.sessionScopesBound === 0) return;
    this.installSessionSecrets(sessionId, [value], false, false);
  }

  /** Atomic batch registration: no cumulative per-cookie sort/regex rebuild. */
  registerSessionSecrets(sessionId: string, values: readonly string[]): void {
    if (this.sessionScopesBound === 0) return;
    this.installSessionSecrets(sessionId, values, false, true);
  }

  /** A reserved new allocation owns its own registry and identity-bound cleanup. */
  initializeSessionSecrets(sessionId: string, values: readonly string[]): () => void {
    if (this.sessionScopesBound === 0) return () => {};
    const owner = this.installSessionSecrets(sessionId, values, true, true);
    return () => {
      if (owner && this.sessionGenerations.get(sessionId) === owner)
        this.clearSessionSecrets(sessionId);
    };
  }

  private installSessionSecrets(
    sessionId: string,
    input: readonly string[],
    fresh: boolean,
    prime: boolean
  ) {
    const previous = fresh ? [] : (this.sessionSecrets.get(sessionId) ?? []);
    const values = new Set(previous);
    for (const value of input) if (!negligibleEntropy(value)) values.add(value);
    if (!fresh && values.size === previous.length) return this.sessionGenerations.get(sessionId);
    if (
      values.size &&
      !this.sessionSecrets.has(sessionId) &&
      this.sessionSecrets.size >= this.sessionScopesBound
    )
      throw new SecretError(
        'SCOPE_LIMIT',
        `Session secret scope limit reached (${this.sessionScopesBound}); close sessions or raise sessionScopesMaxSessions`
      );
    const next = [...values].sort((a, b) => b.length - a.length);
    let pattern: RegExp | null;
    try {
      pattern = next.length ? this.buildSessionPattern(next) : this.redactionPattern;
      if (prime) {
        pattern?.test('');
        if (pattern) pattern.lastIndex = 0;
      }
    } catch {
      throw new SecretError(
        'REDACTION_UNAVAILABLE',
        'Credential redaction could not be initialized'
      );
    }
    const owner = fresh
      ? { values: next, pattern }
      : (this.sessionGenerations.get(sessionId) ?? { values: next, pattern });
    owner.values = next;
    owner.pattern = pattern;
    this.sessionGenerations.set(sessionId, owner);
    if (next.length) {
      this.sessionSecrets.set(sessionId, next);
      this.sessionPatterns.set(sessionId, pattern);
    } else {
      this.sessionSecrets.delete(sessionId);
      this.sessionPatterns.delete(sessionId);
    }
    this.sessionCaches.delete(sessionId);
    return owner;
  }

  /**
   * TD-BROWSER-9, A9: bound the number of live MEMOS, evicting the
   * least-recently-used (access re-inserts the key; registration drops the
   * entry outright). Evicting a memo never un-protects anything — the values
   * and pattern stay, and redaction stays correct uncached.
   */
  private evictStaleMemos(): void {
    while (this.sessionCaches.size > this.sessionScopesBound) {
      const oldest = this.sessionCaches.keys().next().value;
      if (oldest === undefined) break;
      this.sessionCaches.delete(oldest);
    }
  }

  /** A session's registered values leave with it. */
  clearSessionSecrets(sessionId: string): void {
    this.sessionSecrets.delete(sessionId);
    this.sessionPatterns.delete(sessionId);
    this.sessionGenerations.delete(sessionId);
    this.sessionCaches.delete(sessionId);
  }

  private buildSessionPattern(values: string[]): RegExp | null {
    const all = [...values, ...this.sortedValues].sort((a, b) => b.length - a.length);
    return all.length === 0
      ? null
      : new RegExp(all.map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g');
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
      let nextSuffix: Map<string, number> | undefined;
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => {
          const base = redactKeys ? this.redactString(key, scope) : key;
          let safeKey = base;
          // Preserve both values if redacted names collide, without exposing
          // original keys. fromEntries also treats __proto__ as an own key.
          if (seen.has(safeKey)) {
            let suffix = nextSuffix?.get(base) ?? 1;
            do {
              safeKey = `${base}#${suffix++}`;
            } while (seen.has(safeKey));
            nextSuffix ??= new Map();
            nextSuffix.set(base, suffix);
          }
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
      if (!this.sessionCaches.has(scope)) {
        this.sessionCaches.set(scope, cache);
        this.evictStaleMemos();
      } else {
        // Touch: least-recently-USED, not least-recently-registered.
        this.sessionCaches.delete(scope);
        this.sessionCaches.set(scope, cache);
      }
      cache.set(text, redacted);
    }
    return redacted;
  }
}
