import { createHash } from 'node:crypto';
import { FakeEngine } from '@agentbrowser/testkit';
import { expect, it, vi } from 'vitest';
import { buildServer, type ServerOptions } from './server.js';

const key = (value: string) => createHash('sha256').update(value).digest('hex');

/**
 * ADR-034: the session view's self-identifying `attachment` line — an agent
 * verifies which Chrome it is driving before navigating.
 */

it('names the daemon host on an ordinary spawned session, without a profile hint', async () => {
  const app = await buildServer({
    engine: new FakeEngine(),
    attachmentIdentity: { hostHint: 'daemon-host', profileHint: 'Operator' },
  });
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/sessions',
      payload: { tenantId: 'one' },
    });
    expect(response.statusCode).toBe(201);
    // The profile hint is cdp_attach-only: a spawned browser has no operator profile.
    expect(response.json().attachment).toEqual({ kind: 'spawned', hostHint: 'daemon-host' });
    const status = await app.inject({
      method: 'GET',
      url: `/v1/sessions/${response.json().sessionId}`,
    });
    expect(status.statusCode).toBe(200);
    expect(status.json().attachment).toEqual({ kind: 'spawned', hostHint: 'daemon-host' });
  } finally {
    await app.close();
  }
});

it('names the daemon host and operator profile on an attached session', async () => {
  const engine = new FakeEngine();
  const caps = await engine.capabilities();
  vi.spyOn(engine, 'capabilities').mockResolvedValue({ ...caps, supportsCdpAttach: true });
  const app = await buildServer({
    engine,
    apiKeys: new Map([[key('a'), 'one']]),
    operatorCdp: { allowUnenforcedEgress: true },
    attachmentIdentity: { hostHint: 'daemon-host', profileHint: 'Operator' },
  } as ServerOptions);
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: { authorization: 'Bearer a' },
      payload: { tenantId: 'one', cdpAttach: true },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().attachment).toEqual({
      kind: 'cdp_attach',
      hostHint: 'daemon-host',
      profileHint: 'Operator',
    });
    const status = await app.inject({
      method: 'GET',
      url: `/v1/sessions/${response.json().sessionId}`,
      headers: { authorization: 'Bearer a' },
    });
    expect(status.json().attachment).toEqual({
      kind: 'cdp_attach',
      hostHint: 'daemon-host',
      profileHint: 'Operator',
    });
  } finally {
    vi.restoreAllMocks();
    await app.close();
  }
});

it('omits the attachment identity when no valid host hint exists', async () => {
  const app = await buildServer({
    engine: new FakeEngine(),
    // A path-like hint fails the bounded capture: no identity is shipped.
    attachmentIdentity: { hostHint: '/etc/passwd' },
  });
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/sessions',
      payload: { tenantId: 'one' },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().attachment).toBeUndefined();
  } finally {
    await app.close();
  }
});

it('defaults the host hint to this machine, never a credential', async () => {
  const { hostname } = await import('node:os');
  const expected = hostname().split('.')[0];
  const app = await buildServer({ engine: new FakeEngine() });
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/sessions',
      payload: { tenantId: 'one' },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().attachment).toEqual({ kind: 'spawned', hostHint: expected });
  } finally {
    await app.close();
  }
});
