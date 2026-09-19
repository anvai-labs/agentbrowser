import { describe, expect, it, vi } from 'vitest';
import { TrustedEvidenceSourceRegistry, defineEvidenceSource } from './outcome-runner.js';

const descriptor = { id: 'source', capability: 'receipt', authorization: 'required' as const };
const verifier = { id: 'equals', version: '1', input: 2 };
const permission = () => ({ generation: 1, currentGeneration: () => 1 });
const signal = new AbortController().signal;

describe('per-preparation authorized evidence access', () => {
  it('isolates opaque access across prepared and direct reads without widening public context', async () => {
    const requests: unknown[] = [];
    const cleanup = vi.fn();
    const source = defineEvidenceSource<{ id: string }, string, { key: string }>({
      descriptor,
      authorize(request) {
        requests.push(request);
        return {
          kind: 'authorized_access_v1',
          permission: permission(),
          access: { key: request.context.id },
        };
      },
      read(_context, _signal, _correlation, access) {
        return { status: 'ready', evidence: access!.key, evidenceRefIds: [] };
      },
      cleanup,
    });
    const registry = new TrustedEvidenceSourceRegistry([source]);
    const a = registry.prepareRead('source', 'receipt', { id: 'a' }, undefined, verifier)!;
    const b = registry.prepareRead('source', 'receipt', { id: 'b' }, undefined, verifier)!;
    expect(a).not.toHaveProperty('access');
    expect(b).not.toHaveProperty('access');
    expect(JSON.stringify(requests)).not.toContain('access');
    expect(await a(signal)).toMatchObject({ evidence: 'a' });
    expect(await b(signal)).toMatchObject({ evidence: 'b' });
    expect(
      await registry.read('source', 'receipt', { id: 'c' }, signal, undefined, verifier)
    ).toMatchObject({ evidence: 'c' });
    registry.cleanup('source', 'receipt', { id: 'a' })!(signal);
    expect(cleanup).toHaveBeenCalledWith({ id: 'a' }, signal);
  });

  it('preserves exact legacy three-argument callback behavior alongside typed access sources', async () => {
    const read = vi.fn(function (this: unknown) {
      expect(this).toBeUndefined();
      return { status: 'ready' as const, evidence: 2, evidenceRefIds: [] };
    });
    const registry = new TrustedEvidenceSourceRegistry([
      { descriptor, authorize: permission, read },
    ]);
    await registry.read('source', 'receipt', {}, signal, undefined, verifier);
    expect(read).toHaveBeenCalledWith({}, signal, undefined);
    expect(read.mock.calls[0]).toHaveLength(3);
  });

  it.each(['extra', 'missing', 'tag', 'accessor', 'promise', 'permission'] as const)(
    'rejects malformed %s envelope without fallback or read',
    (kind) => {
      const read = vi.fn();
      const getter = vi.fn(() => ({}));
      const registry = new TrustedEvidenceSourceRegistry([
        {
          descriptor,
          authorize() {
            const result: Record<string, unknown> = {
              kind: 'authorized_access_v1',
              permission: permission(),
              access: {},
            };
            if (kind === 'extra') result.extra = true;
            if (kind === 'missing') Reflect.deleteProperty(result, 'access');
            if (kind === 'tag') result.kind = 'other';
            if (kind === 'accessor') Object.defineProperty(result, 'access', { get: getter });
            if (kind === 'promise') return Promise.reject(new Error('private')) as never;
            if (kind === 'permission') result.permission = { generation: 1 };
            return result as never;
          },
          read,
        },
      ]);
      expect(() => registry.prepareRead('source', 'receipt', {}, undefined, verifier)).toThrow(
        'Evidence authorization unavailable'
      );
      expect(read).not.toHaveBeenCalled();
      expect(getter).not.toHaveBeenCalled();
    }
  );

  it('withholds late access reads and permanently fences observed revoke/regrant', async () => {
    let generation = 1;
    const registry = new TrustedEvidenceSourceRegistry([
      {
        descriptor,
        authorize: () => ({
          kind: 'authorized_access_v1' as const,
          permission: { generation, currentGeneration: () => generation },
          access: 'private',
        }),
        async read(
          _context: unknown,
          _signal: AbortSignal,
          _correlation?: string,
          access?: string
        ) {
          generation++;
          return { status: 'ready' as const, evidence: access, evidenceRefIds: [] };
        },
      },
    ]);
    const read = registry.prepareRead('source', 'receipt', {}, undefined, verifier)!;
    await expect(read(signal)).rejects.toThrow();
    generation = 1;
    expect(read.assertAuthorized).toThrow();
    expect(() => read(signal)).toThrow();
  });
});
