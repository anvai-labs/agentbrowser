/**
 * Secret Manager (TD-016)
 *
 * Credentials are addressed by vault reference (vault://...) and resolved
 * only at the moment of use. The safety invariant: a registered secret value
 * must never appear in anything the service emits - logs, error messages,
 * observations, or their serialized forms. redact() enforces that boundary.
 */

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

export class SecretManager {
  private readonly secrets: Map<string, string>;
  /** Values sorted longest-first so overlapping secrets redact fully. */
  private sortedValues: string[] = [];

  constructor(secrets: Record<string, string> = {}) {
    this.secrets = new Map(Object.entries(secrets));
    this.sortedValues = [...this.secrets.values()]
      .filter((value) => value.length > 0)
      .sort((a, b) => b.length - a.length);
  }

  /** Whether a value looks like a secret reference. */
  isReference(value: string): boolean {
    return value.startsWith(REFERENCE_PREFIX);
  }

  /** Resolve a reference to its secret value, for use at execution time only. */
  async resolve(reference: string): Promise<string> {
    if (!this.isReference(reference)) {
      throw new SecretError('INVALID_REFERENCE', `Not a secret reference: ${reference}`);
    }
    const value = this.secrets.get(reference);
    if (value === undefined) {
      throw new SecretError('SECRET_NOT_FOUND', `No secret registered for ${reference}`);
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

  /** Registered references, for inventory. Values never leave this class. */
  references(): string[] {
    return [...this.secrets.keys()];
  }

  /**
   * Safe serialization: accidental JSON.stringify of the manager must never
   * leak values, so it renders as a reference inventory only.
   */
  toJSON(): unknown {
    return { redacted: true, references: this.references() };
  }

  private redactValue(value: unknown): unknown {
    if (typeof value === 'string') {
      return this.redactString(value);
    }
    if (Array.isArray(value)) {
      return value.map((item) => this.redactValue(item));
    }
    if (value !== null && typeof value === 'object') {
      const output: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value)) {
        output[key] = this.redactValue(item);
      }
      return output;
    }
    return value;
  }

  private redactString(text: string): string {
    let safe = text;
    for (const secret of this.sortedValues) {
      if (safe.includes(secret)) {
        safe = safe.split(secret).join(REDACTED);
      }
    }
    return safe;
  }
}
