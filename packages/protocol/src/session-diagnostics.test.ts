import { describe, expect, it } from 'vitest';
import {
  SessionCloseCauseSchema,
  SessionTerminalViewSchema,
  captureSessionDiagnostics,
  sessionLeaseRemainingMs,
  sessionTerminalFailureDetail,
} from './session-diagnostics.js';

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
  it('captures the bounded operator attachment shape without endpoint material', () => {
    const captured = captureSessionDiagnostics({
      attachment: 'cdp_attach',
      browserFamily: 'chromium',
      browserVersion: '135.0.1',
      executableSelection: 'not_applicable',
      launchMode: 'unknown',
      resourceModel: 'operator_owned_browser',
      endpointClass: 'loopback_http',
      egress: 'navigation_preflight_only',
      context: {
        isolation: 'existing_default_context',
        viewport: { mode: 'unknown' },
        initScript: 'not_registered',
      },
    });
    expect(captured).toEqual({
      attachment: 'cdp_attach',
      browserFamily: 'chromium',
      browserVersion: '135.0.1',
      executableSelection: 'not_applicable',
      launchMode: 'unknown',
      resourceModel: 'operator_owned_browser',
      endpointClass: 'loopback_http',
      egress: 'navigation_preflight_only',
      context: {
        isolation: 'existing_default_context',
        viewport: { mode: 'unknown' },
        initScript: 'not_registered',
      },
    });
    expect(Object.isFrozen(captured)).toBe(true);
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
    expect(
      Value.Check(SessionViewSchema, {
        ...view,
        lease,
        leaseRemainingMs: 80,
      })
    ).toBe(true);
    for (const invalid of [
      { ...lease, expiresAt: -1 },
      { ...lease, sampledAt: 1.5 },
      { ...lease, idleExpiresAt: Number.POSITIVE_INFINITY },
      { ...lease, lastActivityAt: Number.MAX_SAFE_INTEGER + 1 },
      { ...lease, secret: 'private' },
      {},
    ]) {
      expect(Value.Check(SessionViewSchema, { ...view, lease: invalid })).toBe(false);
    }
    expect(Value.Check(SessionViewSchema, { ...view, leaseRemainingMs: -1 })).toBe(false);
  });
});

describe('terminal session wire compatibility', () => {
  it('accepts only bounded allowlisted causes and terminal facts', async () => {
    const { Value } = await import('@sinclair/typebox/value');
    for (const closeCause of [
      'ttl_expired',
      'idle_expired',
      'explicit_close',
      'policy_terminated',
      'engine_disconnected',
      'engine_crash',
      'unknown',
    ]) {
      expect(Value.Check(SessionCloseCauseSchema, closeCause)).toBe(true);
    }
    expect(Value.Check(SessionCloseCauseSchema, 'operator_window_closed')).toBe(false);

    const terminal = {
      closeCause: 'explicit_close',
      endedAt: 1050,
      state: 'closed',
      leaseRemainingMs: 0,
      lease: {
        sampledAt: 1050,
        expiresAt: 2000,
        lastActivityAt: 1000,
        idleExpiresAt: 1500,
      },
    };
    expect(Value.Check(SessionTerminalViewSchema, terminal)).toBe(true);
    expect(sessionLeaseRemainingMs(terminal.lease)).toBe(450);
    expect(sessionLeaseRemainingMs({ ...terminal.lease, sampledAt: 1600 })).toBe(0);
    expect(Value.Check(SessionTerminalViewSchema, { ...terminal, leaseRemainingMs: 1 })).toBe(
      false
    );
    expect(Value.Check(SessionTerminalViewSchema, { ...terminal, tenantId: 'private' })).toBe(
      false
    );
    expect(Value.Check(SessionTerminalViewSchema, { ...terminal, endedAt: 1.5 })).toBe(false);
    expect(
      Value.Check(SessionTerminalViewSchema, {
        ...terminal,
        closeCause: 'operator_window_closed',
      })
    ).toBe(false);
  });

  it('projects only a canonical terminal detail from an error', () => {
    const terminal = {
      closeCause: 'idle_expired',
      endedAt: 1050,
      state: 'expired',
      leaseRemainingMs: 0,
      lease: {
        sampledAt: 1050,
        expiresAt: 2000,
        lastActivityAt: 1000,
        idleExpiresAt: 1049,
      },
    };
    const projected = sessionTerminalFailureDetail({
      details: { sessionTerminal: terminal, privateReason: 'secret' },
    });
    expect(projected).toEqual(terminal);
    expect(projected).not.toHaveProperty('privateReason');
    expect(Object.isFrozen(projected)).toBe(true);
    expect(Object.isFrozen(projected?.lease)).toBe(true);
    expect(
      sessionTerminalFailureDetail({
        details: { sessionTerminal: { ...terminal, privateReason: 'secret' } },
      })
    ).toBeUndefined();
  });
});
