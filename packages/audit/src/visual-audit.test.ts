import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { afterEach, describe, expect, it } from 'vitest';
import { BaselineStore, type VisualBaseline, compareVisual } from './visual-audit.js';

function solidPng(width: number, height: number, rgb: [number, number, number]): Buffer {
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const at = (width * y + x) * 4;
      png.data[at] = rgb[0];
      png.data[at + 1] = rgb[1];
      png.data[at + 2] = rgb[2];
      png.data[at + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}

function drawDefect(png: Buffer, from: number, to: [number, number, number]): Buffer {
  const decoded = PNG.sync.read(png);
  for (let y = 0; y < 10; y += 1) {
    for (let x = from; x < from + 10; x += 1) {
      const at = (decoded.width * y + x) * 4;
      decoded.data[at] = to[0];
      decoded.data[at + 1] = to[1];
      decoded.data[at + 2] = to[2];
      decoded.data[at + 3] = 255;
    }
  }
  return PNG.sync.write(decoded);
}

function baselineFor(png: Buffer, threshold = 0.01): VisualBaseline {
  return {
    formatVersion: 1,
    identity: {
      label: 'fixture-page',
      viewport: { width: 40, height: 40 },
      capturedAt: '2026-10-03T00:00:00.000Z',
    },
    threshold,
    imageBase64: png.toString('base64'),
  };
}

const cleanup: Array<string> = [];
afterEach(() => {
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('visual audit adapter (T7 slice 1)', () => {
  it('gate 1: an unchanged page matches its baseline with zero changed pixels', () => {
    const png = solidPng(40, 40, [20, 40, 60]);
    const result = compareVisual(png, baselineFor(png));
    expect(result.verdict).toBe('match');
    expect(result.changedPixels).toBe(0);
    expect(result.totalPixels).toBe(1600);
  });

  it('gate 2: a seeded defect regresses with a diff artifact', () => {
    const png = solidPng(40, 40, [20, 40, 60]);
    const defect = drawDefect(png, 5, [200, 30, 30]);
    const result = compareVisual(defect, baselineFor(png));
    expect(result.verdict).toBe('regression');
    expect(result.changedPixels).toBeGreaterThan(0);
    // The diff artifact decodes as a PNG of the same dimensions.
    const diff = PNG.sync.read(Buffer.from(result.diffPngBase64, 'base64'));
    expect(diff.width).toBe(40);
    expect(diff.height).toBe(40);
  });

  it('gate 3: a small defect is within a generous threshold and regresses under a strict one', () => {
    const png = solidPng(40, 40, [20, 40, 60]);
    // A 10x10 hard defect on a 40x40 page: ratio ~0.0625. Under a 0.1
    // threshold the change is tolerated; under a strict 0.01 it regresses.
    const defect = drawDefect(png, 5, [200, 30, 30]);
    const within = compareVisual(defect, baselineFor(png, 0.1));
    expect(within.verdict).toBe('within-threshold');
    expect(within.ratio).toBeGreaterThan(0);
    expect(within.ratio).toBeLessThanOrEqual(0.1);
    expect(compareVisual(defect, baselineFor(png, 0.001)).verdict).toBe('regression');
  });

  it('gate 4: comparison never writes; saves version explicitly with retained history', () => {
    const dir = mkdtempSync(join(tmpdir(), 'audit-store-'));
    cleanup.push(dir);
    const store = new BaselineStore({ directory: dir });
    expect(store.load('fixture-page')).toBeUndefined();
    expect(readdirSync(dir)).toEqual([]);

    // compare-only against the populated store leaves the directory untouched.
    const png = solidPng(40, 40, [20, 40, 60]);
    store.save({
      label: 'fixture-page',
      viewport: { width: 40, height: 40 },
      threshold: 0.01,
      png,
    });
    const filesAfterSave = readdirSync(dir).sort();
    compareVisual(png, store.load('fixture-page') as VisualBaseline);
    expect(readdirSync(dir).sort()).toEqual(filesAfterSave);

    // An explicit save after a change adds a NEW version; history is retained.
    const defect = drawDefect(png, 5, [200, 30, 30]);
    store.save({
      label: 'fixture-page',
      viewport: { width: 40, height: 40 },
      threshold: 0.01,
      png: defect,
    });
    const versions = store.versions('fixture-page');
    expect(versions.map((entry) => entry.version)).toEqual([1, 2]);
    // The latest is what a plain load returns.
    const latest = store.load('fixture-page') as VisualBaseline;
    const latestCompare = compareVisual(defect, latest);
    expect(latestCompare.verdict).toBe('match');
  });

  it('gate 5: a dimension change is an explicit re-baseline result, not a crash', () => {
    const baselinePng = solidPng(40, 40, [20, 40, 60]);
    const other = solidPng(80, 20, [20, 40, 60]);
    const result = compareVisual(other, baselineFor(baselinePng));
    expect(result.verdict).toBe('dimension-change');
  });

  it('gate 6: non-PNG input is a typed error', () => {
    expect(() =>
      compareVisual(Buffer.from('<html>not a png</html>'), baselineFor(solidPng(40, 40, [0, 0, 0])))
    ).toThrowError(/PNG/i);
  });

  it('gate 7: the audit package stays out of the default dependency closures', () => {
    for (const consumer of ['cli', 'mcp-server', 'api']) {
      const packageDir = join(
        dirname(fileURLToPath(import.meta.url)),
        '..',
        '..',
        '..',
        'packages',
        consumer
      );
      const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      const all = { ...manifest.dependencies, ...manifest.devDependencies };
      expect(all['@agentbrowser/audit']).toBeUndefined();
    }
  });
});
