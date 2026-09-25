import { describe, expect, it } from 'vitest';
import { captureSessionDiagnostics } from './session-diagnostics.js';

const facts = () => ({
  attachment: 'remote_cdp',
  browserFamily: 'chromium',
  browserVersion: '123.0.1',
  executableSelection: 'not_applicable',
  launchMode: 'unknown',
  resourceModel: 'shared_remote_connection',
  context: {
    isolation: 'new_context',
    viewport: { mode: 'fixed', width: 1280, height: 720 },
    initScript: 'registered',
  },
});

describe('bounded diagnostic capture', () => {
  it('makes a detached deeply frozen copy', () => {
    const source = facts();
    const captured = captureSessionDiagnostics(source);
    expect(captured).toEqual(source);
    source.context.viewport.width = 1;
    expect(captured?.context.viewport).toEqual({ mode: 'fixed', width: 1280, height: 720 });
    expect(Object.isFrozen(captured)).toBe(true);
    expect(Object.isFrozen(captured?.context)).toBe(true);
    expect(Object.isFrozen(captured?.context.viewport)).toBe(true);
  });
  it.each([
    undefined,
    null,
    {},
    { ...facts(), browserVersion: 'x'.repeat(129) },
    { ...facts(), browserVersion: '/private/profile' },
    { ...facts(), endpoint: 'http://private-host' },
    { ...facts(), context: { ...facts().context, profile: 'private' } },
    {
      ...facts(),
      context: { ...facts().context, viewport: { mode: 'fixed', width: Number.NaN, height: 720 } },
    },
    { ...facts(), launchMode: 'assumed' },
  ])('omits malformed or private fields %#', (value) => {
    expect(captureSessionDiagnostics(value)).toBeUndefined();
  });
  it('contains getters that throw or change during capture', () => {
    expect(
      captureSessionDiagnostics({
        get attachment() {
          throw new Error('private');
        },
      })
    ).toBeUndefined();
    let reads = 0;
    const source = {
      ...facts(),
      get browserVersion() {
        return ++reads === 1 ? '123' : '/private/profile';
      },
    };
    expect(captureSessionDiagnostics(source)).toBeUndefined();
  });
});

describe('lease wire compatibility', () => {
  it('accepts absent legacy leases and rejects malformed lease facts', async () => {
    const { SessionViewSchema } = await import('./session-diagnostics.js');
    const { Value } = await import('@sinclair/typebox/value');
    const view = {
      sessionId: 's',
      status: 'ready',
      engine: { name: 'fake', version: '1' },
      createdAt: '2026-09-24T00:00:00Z',
      ttlMs: 100,
      idleTimeoutMs: 80,
      pages: 0,
    };
    expect(Value.Check(SessionViewSchema, view)).toBe(true);
    const lease = { sampledAt: 1000, expiresAt: 1100, lastActivityAt: 1000, idleExpiresAt: 1080 };
    expect(Value.Check(SessionViewSchema, { ...view, lease })).toBe(true);
    for (const invalid of [
      { ...lease, expiresAt: -1 },
      { ...lease, sampledAt: 1.5 },
      { ...lease, idleExpiresAt: Infinity },
      { ...lease, lastActivityAt: Number.MAX_SAFE_INTEGER + 1 },
      { ...lease, secret: 'private' },
      {},
    ]) {
      expect(Value.Check(SessionViewSchema, { ...view, lease: invalid })).toBe(false);
    }
  });
});
