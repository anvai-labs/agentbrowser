/**
 * Artifact Store (TD-017)
 *
 * Bounded, TTL-expiring storage for artifacts (downloads, evidence).
 * Oversize payloads are refused rather than truncated; when the store is
 * full the oldest entry is evicted. MVP storage is in-memory, matching
 * ephemeral sessions.
 */

/** Artifact metadata safe to hand to clients. */
export interface ArtifactMetadata {
  artifactId: string;
  type: 'download' | 'screenshot' | 'pdf' | 'trace' | 'html' | 'dom';
  contentType: string;
  sizeBytes: number;
  createdAt: number;
  expiresAt: number;
  filename?: string;
  sessionId?: string;
  /** Honest-capability warnings attached by the producing layer. */
  warnings?: string[];
}

export interface StoredArtifact {
  metadata: ArtifactMetadata;
  bytes: Uint8Array;
}

/** Raised for store-level policy violations. */
export class ArtifactError extends Error {
  constructor(
    public code: string,
    message: string
  ) {
    super(message);
    this.name = 'ArtifactError';
  }
}

export interface ArtifactStoreOptions {
  /** Retention window per artifact. */
  ttlMs?: number;
  /** Maximum size of a single payload. */
  maxBytes?: number;
  /** Maximum number of retained artifacts (oldest evicted). */
  maxArtifacts?: number;
  clock?(): number;
}

const DEFAULT_TTL_MS = 15 * 60_000;
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_ARTIFACTS = 100;

export class ArtifactStore {
  private readonly entries = new Map<string, StoredArtifact>();
  private readonly ttlMs: number;
  private readonly maxBytes: number;
  private readonly maxArtifacts: number;
  private readonly clock: () => number;
  private counter = 0;

  constructor(options: ArtifactStoreOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.maxArtifacts = options.maxArtifacts ?? DEFAULT_MAX_ARTIFACTS;
    this.clock = options.clock ?? Date.now;
  }

  /** Store a payload, enforcing size and count limits. */
  put(
    type: ArtifactMetadata['type'],
    contentType: string,
    bytes: Uint8Array,
    labels: { filename?: string; sessionId?: string } = {}
  ): ArtifactMetadata {
    if (bytes.length > this.maxBytes) {
      throw new ArtifactError(
        'ARTIFACT_TOO_LARGE',
        `Payload is ${bytes.length} bytes; the maximum is ${this.maxBytes}.`
      );
    }

    // Evict expired entries first, then oldest, until there is room.
    this.sweep();
    while (this.entries.size >= this.maxArtifacts) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }

    const now = this.clock();
    const metadata: ArtifactMetadata = {
      artifactId: `art_${now}_${++this.counter}`,
      type,
      contentType,
      sizeBytes: bytes.length,
      createdAt: now,
      expiresAt: now + this.ttlMs,
      ...(labels.filename !== undefined ? { filename: labels.filename } : {}),
      ...(labels.sessionId !== undefined ? { sessionId: labels.sessionId } : {}),
    };

    this.entries.set(metadata.artifactId, { metadata, bytes });
    return metadata;
  }

  /** Retrieve an artifact; expired entries are gone. */
  get(artifactId: string): StoredArtifact | undefined {
    const entry = this.entries.get(artifactId);
    if (!entry) {
      return undefined;
    }
    if (this.clock() > entry.metadata.expiresAt) {
      this.entries.delete(artifactId);
      return undefined;
    }
    return entry;
  }

  /** Remove expired entries; returns how many were swept. */
  sweep(): number {
    const now = this.clock();
    let swept = 0;
    for (const [id, entry] of this.entries) {
      if (now > entry.metadata.expiresAt) {
        this.entries.delete(id);
        swept += 1;
      }
    }
    return swept;
  }

  count(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
  }
}
