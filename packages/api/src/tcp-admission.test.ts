import { describe, expect, it } from 'vitest';
import { ConnectionBudget } from './connection-authority.js';

describe('session-owned joint TCP admission', () => {
  it('rejects admission even if an earlier listener suppresses the abort notification', () => {
    const runtime = new ConnectionBudget();
    const controller = new AbortController();
    controller.signal.addEventListener('abort', (event) => event.stopImmediatePropagation());
    const scope = runtime.createSessionScope(8, controller.signal);
    controller.abort();
    expect(() => scope.reserve()).toThrowError(
      expect.objectContaining({ code: 'SESSION_NOT_FOUND' })
    );
    expect(runtime.inUse).toBe(0);
    scope.closeAdmission();
  });
  it('binds session closure to its original cancellation signal without releasing pending charges', () => {
    const runtime = new ConnectionBudget();
    const controller = new AbortController();
    const scope = runtime.createSessionScope(8, controller.signal);
    const release = scope.reserve();
    controller.abort();
    expect(() => scope.reserve()).toThrowError(
      expect.objectContaining({ code: 'SESSION_NOT_FOUND' })
    );
    expect(scope.inUse).toBe(1);
    release();
    expect(runtime.inUse).toBe(0);
    const preAborted = runtime.createSessionScope(8, AbortSignal.abort());
    expect(() => preAborted.reserve()).toThrowError(
      expect.objectContaining({ code: 'SESSION_NOT_FOUND' })
    );
  });
  it('shares eight session slots and 32 runtime slots with no queue', () => {
    const runtime = new ConnectionBudget();
    const sessions = Array.from({ length: 5 }, () => runtime.createSessionScope());
    const releases: Array<() => void> = [];
    for (const scope of sessions.slice(0, 4)) {
      for (let i = 0; i < 8; i++) releases.push(scope.reserve());
      expect(scope.inUse).toBe(8);
      expect(() => scope.reserve()).toThrowError(
        expect.objectContaining({ code: 'QUOTA_EXCEEDED' })
      );
    }
    expect(runtime.inUse).toBe(32);
    const exhausted = sessions[4];
    if (!exhausted) throw new Error('Missing fifth session');
    expect(() => exhausted.reserve()).toThrowError(
      expect.objectContaining({ code: 'QUOTA_EXCEEDED' })
    );
    expect(exhausted.inUse).toBe(0);
    for (const release of releases) {
      release();
      release();
    }
    expect(runtime.inUse).toBe(0);
    expect(sessions.every((s) => s.inUse === 0)).toBe(true);
  });

  it('closes new admission without forgetting outstanding ownership or harming another session', () => {
    const runtime = new ConnectionBudget(2);
    const a = runtime.createSessionScope();
    const b = runtime.createSessionScope();
    const release = a.reserve();
    a.closeAdmission();
    a.closeAdmission();
    expect(a.inUse).toBe(1);
    expect(() => a.reserve()).toThrowError(expect.objectContaining({ code: 'SESSION_NOT_FOUND' }));
    const releaseB = b.reserve();
    expect(runtime.inUse).toBe(2);
    release();
    releaseB();
    expect(runtime.inUse).toBe(0);
  });

  it('restores local capacity when runtime admission fails', () => {
    const runtime = new ConnectionBudget(1);
    const a = runtime.createSessionScope(1);
    const b = runtime.createSessionScope(1);
    const releaseA = a.reserve();
    expect(() => b.reserve()).toThrow();
    expect(b.inUse).toBe(0);
    releaseA();
    b.reserve()();
    expect(runtime.inUse).toBe(0);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 9])(
    'rejects invalid session ceiling %s',
    (limit) => {
      expect(() => new ConnectionBudget().createSessionScope(limit)).toThrowError(
        expect.objectContaining({ code: 'INVALID_REQUEST' })
      );
    }
  );
});
