import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BaselineStore,
  VisualAuditError,
  type VisualBaseline,
  compareVisual,
} from './visual-audit.js';

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

function baselineFor(png: Buffer, changeRatioLimit = 0.01): VisualBaseline {
  return {
    formatVersion: 1,
    identity: {
      label: 'fixture-page',
      viewport: { width: 40, height: 40 },
      capturedAt: '2026-10-03T00:00:00.000Z',
    },
    colorThreshold: 0.1,
    changeRatioLimit,
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
    const diff = PNG.sync.read(Buffer.from(result.diffPngBase64, 'base64'));
    expect(diff.width).toBe(40);
    expect(diff.height).toBe(40);
  });

  it('gate 3: a small defect is within a generous ratio limit and regresses under a strict one', () => {
    const png = solidPng(40, 40, [20, 40, 60]);
    const defect = drawDefect(png, 5, [200, 30, 30]);
    const within = compareVisual(defect, baselineFor(png, 0.1));
    expect(within.verdict).toBe('within-threshold');
    expect(within.ratio).toBeGreaterThan(0);
    expect(within.ratio).toBeLessThanOrEqual(0.1);
    expect(compareVisual(defect, baselineFor(png, 0.001)).verdict).toBe('regression');
  });

  it('gate 3b: a saved viewport must match the actual PNG dimensions', () => {
    const dir = mkdtempSync(join(tmpdir(), 'audit-store-'));
    cleanup.push(dir);
    const store = new BaselineStore({ directory: dir });
    expect(() =>
      store.save({
        label: 'fixture-page',
        viewport: { width: 100, height: 100 },
        colorThreshold: 0.1,
        changeRatioLimit: 0.01,
        png: solidPng(40, 40, [20, 40, 60]),
      })
    ).toThrowError(VisualAuditError);
  });

  it('gate 3c: labels are strict filename components and thresholds are validated', () => {
    const dir = mkdtempSync(join(tmpdir(), 'audit-store-'));
    cleanup.push(dir);
    const store = new BaselineStore({ directory: dir });
    const validPng = solidPng(40, 40, [20, 40, 60]);
    expect(() =>
      store.save({
        label: '../escape',
        viewport: { width: 40, height: 40 },
        colorThreshold: 0.1,
        changeRatioLimit: 0.01,
        png: validPng,
      })
    ).toThrowError(VisualAuditError);
    expect(() =>
      store.save({
        label: 'fixture',
        viewport: { width: 40, height: 40 },
        colorThreshold: -1,
        changeRatioLimit: 0.01,
        png: validPng,
      })
    ).toThrowError(VisualAuditError);
    for (const name of readdirSync(dir)) expect(name.startsWith('escape')).toBe(false);
  });

  it('gate 4: comparison never writes; saves version explicitly with retained history', () => {
    const dir = mkdtempSync(join(tmpdir(), 'audit-store-'));
    cleanup.push(dir);
    const store = new BaselineStore({ directory: dir });
    expect(store.load('fixture-page')).toBeUndefined();
    expect(readdirSync(dir)).toEqual([]);

    const png = solidPng(40, 40, [20, 40, 60]);
    store.save({
      label: 'fixture-page',
      viewport: { width: 40, height: 40 },
      colorThreshold: 0.1,
      changeRatioLimit: 0.01,
      png,
    });
    const filesAfterSave = readdirSync(dir).sort();
    compareVisual(png, store.load('fixture-page') as VisualBaseline);
    expect(readdirSync(dir).sort()).toEqual(filesAfterSave);

    const defect = drawDefect(png, 5, [200, 30, 30]);
    store.save({
      label: 'fixture-page',
      viewport: { width: 40, height: 40 },
      colorThreshold: 0.1,
      changeRatioLimit: 0.01,
      png: defect,
    });
    const versions = store.versions('fixture-page');
    expect(versions.map((entry) => entry.version)).toEqual([1, 2]);
    const latest = store.load('fixture-page') as VisualBaseline;
    expect(compareVisual(defect, latest).verdict).toBe('match');
  });

  it('gate 5: a dimension change is an explicit re-baseline result, not a crash', () => {
    const baselinePng = solidPng(40, 40, [20, 40, 60]);
    const other = solidPng(80, 20, [20, 40, 60]);
    const result = compareVisual(other, baselineFor(baselinePng));
    expect(result.verdict).toBe('dimension-change');
    expect(result.rebaselineRequired).toBe(true);
  });

  it('gate 6: non-PNG input is a typed error with a code', () => {
    try {
      compareVisual(
        Buffer.from('<html>not a png</html>'),
        baselineFor(solidPng(40, 40, [0, 0, 0]))
      );
      expect.unreachable('must throw');
    } catch (error) {
      expect(error).toBeInstanceOf(VisualAuditError);
      expect((error as VisualAuditError).code).toBe('INVALID_PNG');
    }
  });

  it('gate 6b: save refuses malformed PNGs instead of persisting them', () => {
    const dir = mkdtempSync(join(tmpdir(), 'audit-store-'));
    cleanup.push(dir);
    const store = new BaselineStore({ directory: dir });
    expect(() =>
      store.save({
        label: 'fixture-page',
        viewport: { width: 40, height: 40 },
        colorThreshold: 0.1,
        changeRatioLimit: 0.01,
        png: Buffer.from('not a png'),
      })
    ).toThrowError(VisualAuditError);
    expect(store.load('fixture-page')).toBeUndefined();
  });

  it('gate 7: the audit package stays out of the default dependency closures', () => {
    const packageDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'packages');
    for (const consumer of ['cli', 'mcp-server', 'api']) {
      const manifest = JSON.parse(
        readFileSync(join(packageDir, consumer, 'package.json'), 'utf8')
      ) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
      const all = { ...manifest.dependencies, ...manifest.devDependencies };
      expect(all['@agentbrowser/audit']).toBeUndefined();
    }
  });
});
