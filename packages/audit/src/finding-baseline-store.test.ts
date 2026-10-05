import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AccessibilityBaseline } from './accessibility-audit.js';
import { FindingBaselineStore } from './finding-baseline-store.js';
import { VisualAuditError } from './visual-audit.js';

const cleanup: Array<string> = [];
afterEach(() => {
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('finding baseline store (shared by the finding adapters)', () => {
  it('gate 1: accessibility-shaped baselines round-trip per label', () => {
    const dir = mkdtempSync(join(tmpdir(), 'finding-store-'));
    cleanup.push(dir);
    const store = new FindingBaselineStore<AccessibilityBaseline>({ directory: dir });
    expect(store.load('page-a11y')).toBeUndefined();

    const document = {
      formatVersion: 1,
      violations: [{ ruleId: 'image-alt', targets: [['img']] }],
      capturedAt: '2026-10-03T00:00:00.000Z',
    };
    store.save('page-a11y', document);
    expect(store.load('page-a11y')).toEqual(document);
  });

  it('gate 2: saves append versions and never overwrite; the latest is loaded', () => {
    const dir = mkdtempSync(join(tmpdir(), 'finding-store-'));
    cleanup.push(dir);
    const store = new FindingBaselineStore<AccessibilityBaseline>({ directory: dir });
    const first = { formatVersion: 1, findings: [], capturedAt: 'c1' };
    const second = {
      formatVersion: 1,
      findings: [{ pluginId: 40012, url: 'http://x/', parameter: 'name' }],
      capturedAt: 'c2',
    };
    store.save('target-scan', first, 'c1');
    store.save('target-scan', second, 'c2');

    expect(store.load('target-scan')).toEqual(second);
    expect(store.versions('target-scan').map((entry) => entry.version)).toEqual([1, 2]);
    expect(store.versions('target-scan').map((entry) => entry.capturedAt)).toEqual(['c1', 'c2']);
  });

  it('gate 3: labels are strict filename components; nothing escapes the directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'finding-store-'));
    cleanup.push(dir);
    const store = new FindingBaselineStore<AccessibilityBaseline>({ directory: dir });
    expect(() => store.save('../escape', { any: true })).toThrowError(/label must match/);
    expect(() => store.load('nested/label')).toThrowError(/label must match/);
    for (const name of readdirSync(dir)) expect(name.startsWith('escape')).toBe(false);
  });

  it('gate 4: a corrupt or future manifest is a typed error, not a crash', () => {
    const dir = mkdtempSync(join(tmpdir(), 'finding-store-'));
    cleanup.push(dir);
    writeFileSync(join(dir, 'finding-baselines.json'), '{ "formatVersion": 999, "labels": {} }');
    const store = new FindingBaselineStore<AccessibilityBaseline>({ directory: dir });
    expect(() => store.load('any')).toThrowError(/formatVersion 999 is not supported/);
  });

  it('gate 5: writes are atomic (temp+rename) — no .pending residue after a save', () => {
    const dir = mkdtempSync(join(tmpdir(), 'finding-store-'));
    cleanup.push(dir);
    const store = new FindingBaselineStore<AccessibilityBaseline>({ directory: dir });
    store.save('page-a11y', { formatVersion: 1, violations: [], capturedAt: 'c1' });
    expect(readdirSync(dir).some((name) => name.includes('.pending'))).toBe(false);
    // The manifest on disk parses and carries the entry.
    const manifest = JSON.parse(readFileSync(join(dir, 'finding-baselines.json'), 'utf8')) as {
      labels: Record<string, { version: number }>;
    };
    expect(manifest.labels['page-a11y'].version).toBe(1);
  });
});
