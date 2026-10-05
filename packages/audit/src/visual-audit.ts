import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';

/** T7 slice 1: visual audit adapter. Wraps pixelmatch (the specialist
 * comparison library) and pngjs; the adapter itself is engine-agnostic —
 * callers capture PNGs, the adapter measures against explicit, versioned
 * baselines. This package is deliberately outside the default dependency
 * closures (cli/mcp-server/api do not depend on it); consumption arrives
 * with the audit mode/profile selection slice. */

export class VisualAuditError extends Error {
  constructor(
    public code: string,
    message: string
  ) {
    super(message);
    this.name = 'VisualAuditError';
  }
}

export interface VisualIdentity {
  label: string;
  viewport: { width: number; height: number };
  capturedAt: string;
}

export interface VisualBaseline {
  formatVersion: 1;
  identity: VisualIdentity;
  /** pixelmatch per-pixel color-distance tolerance, 0..1. */
  colorThreshold: number;
  /** Changed-pixel ratio budget for `within-threshold`, 0..1. */
  changeRatioLimit: number;
  imageBase64: string;
}

export type VisualVerdict = 'match' | 'within-threshold' | 'regression' | 'dimension-change';

export interface VisualDiffResult {
  verdict: VisualVerdict;
  changedPixels: number;
  totalPixels: number;
  /** changedPixels / totalPixels, rounded to 6 dp — the verdict derives
   * from this SAME rounded value so reports can re-derive it. */
  ratio: number;
  /** Base64 PNG highlighting changed pixels; empty for dimension-change. */
  diffPngBase64: string;
  /** Present on dimension-change: the guidance for the report adapter. */
  rebaselineRequired?: boolean;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const LABEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function assertPng(png: Buffer): void {
  if (png.length < 8 || !png.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new VisualAuditError('INVALID_PNG', 'visual audit input must be a PNG buffer');
  }
}

function assertLabel(label: string): void {
  if (!LABEL_PATTERN.test(label)) {
    throw new VisualAuditError(
      'INVALID_LABEL',
      `label must match ${LABEL_PATTERN.source} (no path separators): ${JSON.stringify(label)}`
    );
  }
}

function assertThresholds(colorThreshold: number, changeRatioLimit: number): void {
  for (const [name, value] of [
    ['colorThreshold', colorThreshold],
    ['changeRatioLimit', changeRatioLimit],
  ] as const) {
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      throw new VisualAuditError(
        'INVALID_THRESHOLD',
        `${name} must be a finite number in [0, 1]; got ${value}`
      );
    }
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
  options?: { colorThreshold?: number }
): VisualDiffResult {
  const colorThreshold = options?.colorThreshold ?? baseline.colorThreshold;
  assertThresholds(colorThreshold, baseline.changeRatioLimit);
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
  const diff = new PNG({ width: current.width, height: current.height });
  const changedPixels = pixelmatch(
    new Uint8Array(current.data),
    new Uint8Array(stored.data),
    new Uint8Array(diff.data),
    current.width,
    current.height,
    { threshold: colorThreshold }
  );
  const totalPixels = current.width * current.height;
  // The verdict derives from the SAME rounded value the result carries, so
  // a report re-deriving the verdict from the fields agrees at the boundary.
  const ratio = Math.round((changedPixels / totalPixels) * 1e6) / 1e6;
  const verdict: VisualVerdict =
    changedPixels === 0
      ? 'match'
      : ratio <= baseline.changeRatioLimit
        ? 'within-threshold'
        : 'regression';
  return {
    verdict,
    changedPixels,
    totalPixels,
    ratio,
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
      versions: Array<{ version: number; capturedAt: string; colorThreshold: number }>;
    }
  >;
}

/** File-backed baseline store: one manifest (baselines.json) plus versioned
 * PNG files per label. Saves APPEND a version and never overwrite (the
 * manifest itself is written via temp+rename); the comparator never touches
 * the directory. Single-process by contract — cross-process saves race. */
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
    const manifest = JSON.parse(readFileSync(this.manifestPath, 'utf8')) as StoreManifest;
    if (manifest.formatVersion !== 1) {
      throw new VisualAuditError(
        'UNSUPPORTED_MANIFEST',
        `baseline manifest formatVersion ${manifest.formatVersion} is not supported`
      );
    }
    return manifest;
  }

  private writeManifest(manifest: StoreManifest): void {
    mkdirSync(this.directory, { recursive: true });
    const temp = `${this.manifestPath}.pending`;
    writeFileSync(temp, JSON.stringify(manifest, null, 2));
    renameSync(temp, this.manifestPath);
  }

  /** Latest baseline for the label, or undefined. */
  load(label: string): VisualBaseline | undefined {
    assertLabel(label);
    return this.readManifest().baselines[label]?.latest;
  }

  /** Retained version history for the label (explicit baseline changes). */
  versions(label: string): Array<{ version: number; capturedAt: string; colorThreshold: number }> {
    assertLabel(label);
    return this.readManifest().baselines[label]?.versions ?? [];
  }

  /** Append a new version for the label. Explicit by contract: this is the
   * ONLY way a baseline changes. The claimed viewport must match the actual
   * PNG dimensions; the label is a strict filename component. Returns the
   * stored baseline. */
  save(input: {
    label: string;
    viewport: { width: number; height: number };
    colorThreshold: number;
    changeRatioLimit: number;
    png: Buffer;
  }): VisualBaseline {
    assertLabel(input.label);
    assertThresholds(input.colorThreshold, input.changeRatioLimit);
    const decoded = decode(input.png);
    if (decoded.width !== input.viewport.width || decoded.height !== input.viewport.height) {
      throw new VisualAuditError(
        'VIEWPORT_MISMATCH',
        `claimed viewport ${input.viewport.width}x${input.viewport.height} does not match the PNG's ${decoded.width}x${decoded.height}`
      );
    }
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
      colorThreshold: input.colorThreshold,
      changeRatioLimit: input.changeRatioLimit,
      imageBase64: input.png.toString('base64'),
    };
    entry.latest = baseline;
    entry.version = version;
    entry.versions.push({
      version,
      capturedAt: baseline.identity.capturedAt,
      colorThreshold: input.colorThreshold,
    });
    manifest.baselines[input.label] = entry;
    this.writeManifest(manifest);
    return baseline;
  }
}
