import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { VisualAuditError } from './visual-audit.js';

/** Shared versioned baseline storage for the finding-based audit adapters
 * (accessibility, scanner-regression). The same discipline as the visual
 * BaselineStore: saves APPEND a version and never overwrite (manifest via
 * temp+rename), the comparators never write, loading returns the latest,
 * and history is retained per label. Labels are strict filename
 * components. Single-process by contract — cross-process saves race. */

export interface FindingStoreEntry {
  version: number;
  capturedAt: string;
}

interface FindingManifest {
  formatVersion: 1;
  labels: Record<
    string,
    {
      latest: unknown;
      version: number;
      versions: FindingStoreEntry[];
    }
  >;
}

const LABEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function assertLabel(label: string): void {
  if (!LABEL_PATTERN.test(label)) {
    throw new VisualAuditError(
      'INVALID_LABEL',
      `label must match ${LABEL_PATTERN.source} (no path separators): ${JSON.stringify(label)}`
    );
  }
}

export class FindingBaselineStore<TDocument = unknown> {
  private readonly directory: string;
  private readonly manifestPath: string;

  constructor(options: { directory: string }) {
    this.directory = options.directory;
    // Deliberately distinct from the visual BaselineStore's manifest
    // (baselines.json): same filename + incompatible schema would crash
    // untyped when a caller co-locates the stores.
    this.manifestPath = join(options.directory, 'finding-baselines.json');
  }

  private readManifest(): FindingManifest {
    if (!existsSync(this.manifestPath)) {
      return { formatVersion: 1, labels: {} };
    }
    let parsed: FindingManifest;
    try {
      parsed = JSON.parse(readFileSync(this.manifestPath, 'utf8')) as FindingManifest;
    } catch (error) {
      throw new VisualAuditError(
        'CORRUPT_MANIFEST',
        `baseline manifest is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    if (parsed.formatVersion !== 1) {
      throw new VisualAuditError(
        'UNSUPPORTED_MANIFEST',
        `baseline manifest formatVersion ${String(parsed.formatVersion)} is not supported`
      );
    }
    return parsed;
  }

  private writeManifest(manifest: FindingManifest): void {
    mkdirSync(this.directory, { recursive: true });
    const temp = `${this.manifestPath}.pending`;
    writeFileSync(temp, JSON.stringify(manifest, null, 2));
    renameSync(temp, this.manifestPath);
  }

  /** Latest baseline document for the label, or undefined. */
  load(label: string): TDocument | undefined {
    assertLabel(label);
    return this.readManifest().labels[label]?.latest as TDocument | undefined;
  }

  /** Retained version history for the label (explicit baseline changes). */
  versions(label: string): FindingStoreEntry[] {
    assertLabel(label);
    return this.readManifest().labels[label]?.versions ?? [];
  }

  /** Append a new version for the label. Explicit by contract: this is the
   * ONLY way a baseline changes. Returns the new version's stamp (the
   * document is stored verbatim — its own capturedAt is untouched). */
  save(
    label: string,
    document: TDocument,
    capturedAt?: string
  ): { version: number; capturedAt: string } {
    assertLabel(label);
    const manifest = this.readManifest();
    const entry = manifest.labels[label] ?? {
      latest: undefined as unknown,
      version: 0,
      versions: [],
    };
    const version = entry.version + 1;
    const stamped = capturedAt ?? new Date().toISOString();
    entry.latest = document;
    entry.version = version;
    entry.versions.push({ version, capturedAt: stamped });
    manifest.labels[label] = entry;
    this.writeManifest(manifest);
    return { version, capturedAt: stamped };
  }
}
