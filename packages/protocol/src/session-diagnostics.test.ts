import { describe, expect, it } from 'vitest';
import {
  attachmentHintFromHostname,
  attachmentIdentityKind,
  captureAttachmentHint,
  captureAttachmentIdentity,
  captureSessionDiagnostics,
  SessionAttachmentIdentitySchema,
  SessionCloseCauseSchema,
  SessionTerminalViewSchema,
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

describe('self-identifying attachment identity (ADR-034)', () => {
  it('captures bounded host/profile hints and freezes the snapshot', () => {
    const captured = captureAttachmentIdentity('cdp_attach', 'ops-macbook', 'Operator');
    expect(captured).toEqual({
      kind: 'cdp_attach',
      hostHint: 'ops-macbook',
      profileHint: 'Operator',
    });
    expect(Object.isFrozen(captured)).toBe(true);
    expect(captureAttachmentIdentity('spawned', 'ops-macbook', 'Operator')).toEqual({
      kind: 'spawned',
      hostHint: 'ops-macbook',
    });
    expect(captureAttachmentIdentity('spawned', 'ops-macbook')).toEqual({
      kind: 'spawned',
      hostHint: 'ops-macbook',
    });
  });

  it.each([
    '/Users/op/agentbrowser-operator-profile',
    '/etc/passwd',
    'a/b',
    'a\\b',
    '.hidden',
    '',
    `${'a'.repeat(129)}`,
    42,
    undefined,
    null,
  ])('refuses path-like, oversized or non-string host hints %#', (hostHint) => {
    expect(captureAttachmentIdentity('spawned', hostHint)).toBeUndefined();
  });

  it.each(['/Users/op/agentbrowser-operator-profile', 'a/b', '.hidden', '', 42, undefined])(
    'refuses path-like or oversized profile hints %#',
    (profileHint) => {
      expect(captureAttachmentIdentity('cdp_attach', 'ops-macbook', profileHint)).toEqual({
        kind: 'cdp_attach',
        hostHint: 'ops-macbook',
      });
      expect(
        captureAttachmentIdentity('cdp_attach', 'ops-macbook', profileHint)
      ).not.toHaveProperty('profileHint');
    }
  );

  it('reduces a hostname to its first label', () => {
    expect(attachmentHintFromHostname('ops-macbook.local')).toBe('ops-macbook');
    expect(attachmentHintFromHostname('daemon.example.com')).toBe('daemon');
    expect(attachmentHintFromHostname('plain')).toBe('plain');
    expect(attachmentHintFromHostname('')).toBeUndefined();
  });

  it('captures hints through the same bounded shape', () => {
    expect(captureAttachmentHint('Operator')).toBe('Operator');
    expect(captureAttachmentHint('/private/var')).toBeUndefined();
    expect(captureAttachmentHint(7)).toBeUndefined();
  });

  it('derives the honest kind: operator attach, own launches, and refusals', () => {
    expect(attachmentIdentityKind(undefined, true)).toBe('cdp_attach');
    expect(attachmentIdentityKind('cdp_attach', true)).toBe('cdp_attach');
    expect(attachmentIdentityKind('local_launch', false)).toBe('spawned');
    // No engine diagnostics (embedded fakes) still allows the spawned claim.
    expect(attachmentIdentityKind(undefined, false)).toBe('spawned');
    // The cdp_attach claim comes only from the service's own admission record;
    // engine diagnostics alone never mint it.
    expect(attachmentIdentityKind('cdp_attach', false)).toBeUndefined();
    // A remote CDP browser lives on another machine: no host identity is honest.
    expect(attachmentIdentityKind('remote_cdp', false)).toBeUndefined();
    // The service's own admission record is authoritative over engine
    // diagnostics: an admitted attach is on the daemon host by topology.
    expect(attachmentIdentityKind('remote_cdp', true)).toBe('cdp_attach');
    expect(attachmentIdentityKind('unknown', false)).toBeUndefined();
  });

  it('validates the schema shape on the session view', async () => {
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
    expect(
      Value.Check(SessionViewSchema, {
        ...view,
        attachment: { kind: 'cdp_attach', hostHint: 'ops-macbook', profileHint: 'Operator' },
      })
    ).toBe(true);
    expect(
      Value.Check(SessionViewSchema, { ...view, attachment: { kind: 'spawned', hostHint: 'd' } })
    ).toBe(true);
    for (const attachment of [
      { kind: 'remote_cdp', hostHint: 'd' },
      { kind: 'spawned', hostHint: '/etc' },
      { kind: 'spawned', hostHint: 'd', extra: true },
      { kind: 'cdp_attach', hostHint: 'd', profileHint: 5 },
      {},
    ]) {
      expect(Value.Check(SessionViewSchema, { ...view, attachment })).toBe(false);
    }
    expect(Value.Check(SessionAttachmentIdentitySchema, { kind: 'spawned', hostHint: 'd' })).toBe(
      true
    );
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
    const disconnected = {
      ...terminal,
      closeCause: 'engine_disconnected',
      state: 'engine_disconnected',
    };
    expect(Value.Check(SessionTerminalViewSchema, disconnected)).toBe(true);
    expect(sessionTerminalFailureDetail({ details: { sessionTerminal: disconnected } })).toEqual(
      disconnected
    );
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
