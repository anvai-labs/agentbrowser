import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';

/** T7 slice 1: visual audit adapter. Wraps pixelmatch (the specialist
 * comparison library) and pngjs; the adapter itself is engine-agnostic —
 * callers capture PNGs, the adapter measures against explicit, versioned
 * baselines. This package is deliberately outside the default dependency
 * closures (cli/mcp-server/api do not depend on it); consumption arrives
 * with the audit mode/profile selection slice. */

export interface VisualIdentity {
  label: string;
  viewport: { width: number; height: number };
  capturedAt: string;
}

export interface VisualBaseline {
  formatVersion: 1;
  identity: VisualIdentity;
  /** pixelmatch color-distance threshold, 0..1. */
  threshold: number;
  imageBase64: string;
}

export type VisualVerdict = 'match' | 'within-threshold' | 'regression' | 'dimension-change';

export interface VisualDiffResult {
  verdict: VisualVerdict;
  changedPixels: number;
  totalPixels: number;
  /** changedPixels / totalPixels. */
  ratio: number;
  /** Base64 PNG highlighting changed pixels; empty for dimension-change. */
  diffPngBase64: string;
  /** Present on dimension-change: the guidance for the report adapter. */
  rebaselineRequired?: boolean;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function assertPng(png: Buffer): void {
  if (png.length < 8 || !png.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error('INVALID_PNG: visual audit input must be a PNG buffer');
  }
}

function decode(png: Buffer): PNG {
  assertPng(png);
  return PNG.sync.read(png);
}

/** Compare a captured PNG against a stored baseline. Pure: writes nothing. */
export function compareVisual(
  currentPng: Buffer,
  baseline: VisualBaseline,
  options?: { threshold?: number }
): VisualDiffResult {
  const current = decode(currentPng);
  const stored = decode(Buffer.from(baseline.imageBase64, 'base64'));
  if (current.width !== stored.width || current.height !== stored.height) {
    return {
      verdict: 'dimension-change',
      changedPixels: 0,
      totalPixels: current.width * current.height,
      ratio: 1,
      diffPngBase64: '',
      rebaselineRequired: true,
    };
  }
  const threshold = options?.threshold ?? baseline.threshold;
  const diff = new PNG({ width: current.width, height: current.height });
  const changedPixels = pixelmatch(
    new Uint8Array(current.data),
    new Uint8Array(stored.data),
    new Uint8Array(diff.data),
    current.width,
    current.height,
    { threshold }
  );
  const totalPixels = current.width * current.height;
  const ratio = totalPixels === 0 ? 0 : changedPixels / totalPixels;
  const verdict: VisualVerdict =
    changedPixels === 0 ? 'match' : ratio <= threshold ? 'within-threshold' : 'regression';
  return {
    verdict,
    changedPixels,
    totalPixels,
    ratio: Math.round(ratio * 1e6) / 1e6,
    diffPngBase64: PNG.sync.write(diff).toString('base64'),
  };
}

interface StoreManifest {
  formatVersion: 1;
  baselines: Record<
    string,
    {
      latest: VisualBaseline;
      version: number;
      versions: Array<{ version: number; capturedAt: string; threshold: number }>;
    }
  >;
}

/** File-backed baseline store: one manifest (baselines.json) plus versioned
 * PNG files per label. Saves APPEND a version and never overwrite; the
 * comparator never touches the directory. */
export class BaselineStore {
  private readonly directory: string;
  private readonly manifestPath: string;

  constructor(options: { directory: string }) {
    this.directory = options.directory;
    this.manifestPath = join(options.directory, 'baselines.json');
  }

  private readManifest(): StoreManifest {
    if (!existsSync(this.manifestPath)) {
      return { formatVersion: 1, baselines: {} };
    }
    return JSON.parse(readFileSync(this.manifestPath, 'utf8')) as StoreManifest;
  }

  private writeManifest(manifest: StoreManifest): void {
    mkdirSync(this.directory, { recursive: true });
    writeFileSync(this.manifestPath, JSON.stringify(manifest, null, 2));
  }

  /** Latest baseline for the label, or undefined. */
  load(label: string): VisualBaseline | undefined {
    return this.readManifest().baselines[label]?.latest;
  }

  /** Retained version history for the label (explicit baseline changes). */
  versions(label: string): Array<{ version: number; capturedAt: string; threshold: number }> {
    return this.readManifest().baselines[label]?.versions ?? [];
  }

  /** Append a new version for the label. Explicit by contract: this is the
   * ONLY way a baseline changes. Returns the stored baseline. */
  save(input: {
    label: string;
    viewport: { width: number; height: number };
    threshold: number;
    png: Buffer;
  }): VisualBaseline {
    const decoded = PNG.sync.read(input.png);
    const manifest = this.readManifest();
    const entry = manifest.baselines[input.label] ?? {
      latest: undefined as unknown as VisualBaseline,
      version: 0,
      versions: [],
    };
    const version = entry.version + 1;
    mkdirSync(this.directory, { recursive: true });
    writeFileSync(join(this.directory, `${input.label}.v${version}.png`), input.png);
    const baseline: VisualBaseline = {
      formatVersion: 1,
      identity: {
        label: input.label,
        viewport: { ...input.viewport },
        capturedAt: new Date().toISOString(),
      },
      threshold: input.threshold,
      imageBase64: input.png.toString('base64'),
    };
    entry.latest = baseline;
    entry.version = version;
    entry.versions.push({
      version,
      capturedAt: baseline.identity.capturedAt,
      threshold: input.threshold,
    });
    manifest.baselines[input.label] = entry;
    this.writeManifest(manifest);
    return baseline;
  }
}
