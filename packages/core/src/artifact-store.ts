/**
 * Artifact Store (TD-017)
 *
 * Bounded, TTL-expiring storage for artifacts (downloads, evidence).
 * Oversize payloads are refused rather than truncated. When the store is
 * full the oldest artifact of the tenant holding the most is evicted (most
 * artifacts under count pressure, most bytes under byte pressure; a tie
 * evicts the writer's own). Max-min fair: no tenant can be pushed below an
 * equal share of the store (within one artifact) by others' writes, however
 * they are sized or ordered. MVP storage is in-memory, matching ephemeral
 * sessions.
 */

/** Artifact metadata safe to hand to clients. */
export interface ArtifactMetadata {
  artifactId: string;
  controlEpoch?: number;
  type: 'download' | 'screenshot' | 'pdf' | 'trace' | 'html' | 'dom';
  contentType: string;
  sizeBytes: number;
  createdAt: number;
  expiresAt: number;
  filename?: string;
  sessionId?: string;
  /** Immutable owner, retained independently of the live session. */
  tenantId?: string;
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
  /** Maximum aggregate bytes retained across all artifacts. */
  maxTotalBytes?: number;
  clock?(): number;
}

const DEFAULT_TTL_MS = 15 * 60_000;
/** Per-artifact payload ceiling. */
export const DEFAULT_MAX_ARTIFACT_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_ARTIFACTS = 100;
const DEFAULT_MAX_TOTAL_BYTES = 256 * 1024 * 1024;

export class ArtifactStore {
  private readonly entries = new Map<string, StoredArtifact>();
  /** Per-owner index (insertion-ordered ids and byte total); '' is unowned. */
  private readonly owners = new Map<string, { ids: Set<string>; bytes: number }>();
  private readonly ttlMs: number;
  private readonly maxBytes: number;
  private readonly maxArtifacts: number;
  private readonly maxTotalBytes: number;
  private readonly clock: () => number;
  private counter = 0;
  private storedBytes = 0;

  constructor(options: ArtifactStoreOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_ARTIFACT_BYTES;
    this.maxArtifacts = options.maxArtifacts ?? DEFAULT_MAX_ARTIFACTS;
    this.maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
    if (this.maxBytes > this.maxTotalBytes) {
      throw new ArtifactError(
        'INVALID_ARTIFACT_LIMITS',
        `maxBytes (${this.maxBytes}) exceeds maxTotalBytes (${this.maxTotalBytes}).`
      );
    }
    this.clock = options.clock ?? Date.now;
  }

  /** Store a payload, enforcing size and count limits. */
  put(
    type: ArtifactMetadata['type'],
    contentType: string,
    bytes: Uint8Array,
    labels: { filename?: string; sessionId?: string; tenantId?: string; controlEpoch?: number } = {}
  ): ArtifactMetadata {
    if (bytes.length > this.maxBytes) {
      throw new ArtifactError(
        'ARTIFACT_TOO_LARGE',
        `Payload is ${bytes.length} bytes; the maximum is ${this.maxBytes}.`
      );
    }

    // Evict expired entries first, then the largest holder's oldest until
    // both the count and the aggregate byte cap leave room.
    this.sweep();
    const writer = labels.tenantId ?? '';
    while (this.entries.size > 0) {
      const byCount = this.entries.size >= this.maxArtifacts;
      if (!byCount && this.storedBytes + bytes.length <= this.maxTotalBytes) break;
      const victim = this.largestHolder(writer, byCount)?.ids.values().next().value;
      if (victim === undefined) break;
      this.remove(victim);
    }

    const now = this.clock();
    const metadata: ArtifactMetadata = {
      ...(labels.controlEpoch !== undefined ? { controlEpoch: labels.controlEpoch } : {}),
      artifactId: `art_${now}_${++this.counter}`,
      type,
      contentType,
      sizeBytes: bytes.length,
      createdAt: now,
      expiresAt: now + this.ttlMs,
      ...(labels.filename !== undefined ? { filename: labels.filename } : {}),
      ...(labels.sessionId !== undefined ? { sessionId: labels.sessionId } : {}),
      ...(labels.tenantId !== undefined ? { tenantId: labels.tenantId } : {}),
    };

    this.entries.set(metadata.artifactId, { metadata, bytes });
    this.storedBytes += bytes.length;
    const owner = this.owners.get(writer) ?? { ids: new Set<string>(), bytes: 0 };
    owner.ids.add(metadata.artifactId);
    owner.bytes += bytes.length;
    this.owners.set(writer, owner);
    return metadata;
  }

  /** Retrieve an artifact; expired entries are gone. */
  get(artifactId: string): StoredArtifact | undefined {
    const entry = this.entries.get(artifactId);
    if (!entry) {
      return undefined;
    }
    if (this.clock() > entry.metadata.expiresAt) {
      this.remove(artifactId);
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
        this.remove(id);
        swept += 1;
      }
    }
    return swept;
  }

  count(): number {
    return this.entries.size;
  }

  /** Aggregate bytes currently retained. */
  totalBytes(): number {
    return this.storedBytes;
  }

  clear(): void {
    this.entries.clear();
    this.owners.clear();
    this.storedBytes = 0;
  }

  /** The owner holding the most artifacts (count) or bytes; ties pick the writer. */
  private largestHolder(writer: string, byCount: boolean) {
    let largest: { ids: Set<string>; bytes: number } | undefined;
    let largestSize = -1;
    for (const [key, owner] of this.owners) {
      const size = byCount ? owner.ids.size : owner.bytes;
      if (size > largestSize || (size === largestSize && key === writer)) {
        largest = owner;
        largestSize = size;
      }
    }
    return largest;
  }

  private remove(artifactId: string): void {
    const entry = this.entries.get(artifactId);
    if (!entry) return;
    this.entries.delete(artifactId);
    this.storedBytes -= entry.bytes.length;
    const key = entry.metadata.tenantId ?? '';
    const owner = this.owners.get(key);
    if (!owner) return;
    owner.ids.delete(artifactId);
    owner.bytes -= entry.bytes.length;
    if (owner.ids.size === 0) this.owners.delete(key);
  }
}
