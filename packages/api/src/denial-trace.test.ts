import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SecretManager } from '@agentbrowser/core';
import { FakeEngine } from '@agentbrowser/testkit';
import { expect, it, vi } from 'vitest';
import { AgentBrowserService } from './service.js';

it('defaults bounty scopes to live denials while preserving policy refusal and ledger evidence', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'denial-trace-'));
  const engine = new FakeEngine();
  const create = vi.spyOn(engine, 'createSession');
  const lines: string[] = [];
  const service = new AgentBrowserService({
    engine,
    traceSink: (line) => lines.push(line),
    engagement: { directory },
  });
  try {
    const session = await service.createSession({
      tenantId: 'one',
      mode: 'bounty',
      scope: { allowedHosts: ['vinted.com'], allowedMethods: ['GET'], ledger: true },
    });
    expect(session.trace).toBe('denials');
    const events: unknown[] = [];
    service.subscribe(session.sessionId, (event) => events.push(event));
    const options = create.mock.calls[0]![0]!;
    await expect(
      options.requestPolicy!.checkRequest({
        hostname: 'vinted.com',
        url: 'https://vinted.com/api/verify',
        method: 'PUT',
      })
    ).rejects.toMatchObject({ details: { scope: 'SCOPE_METHOD_DENIED' } });
    options.requestRecorder!({
      type: 'request.failed',
      timestamp: new Date().toISOString(),
      data: {
        method: 'PUT',
        url: 'https://vinted.com/api/verify?code=private',
        scope: 'SCOPE_METHOD_DENIED',
      },
    });
    expect(lines.join('\n')).toContain('SCOPE_METHOD_DENIED PUT https://vinted.com/api/verify');
    expect(lines.join('\n')).not.toContain('private');
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'scope.denied',
        data: expect.objectContaining({ method: 'PUT', scope: 'SCOPE_METHOD_DENIED' }),
      })
    );
    await service.closeSession(session.sessionId);
    const files = await readdir(directory, { recursive: true });
    const ledgerFile = files.find((file) => file.endsWith('.jsonl'))!;
    const ledger = await readFile(join(directory, ledgerFile), 'utf8');
    expect(ledger).toContain('SCOPE_METHOD_DENIED');
  } finally {
    await service.shutdown();
    await rm(directory, { recursive: true, force: true });
  }
});

it('redacts session-registered cookie values before trace correlation, stderr and publication', async () => {
  const secrets = new SecretManager();
  const engine = new FakeEngine();
  const create = vi.spyOn(engine, 'createSession');
  const lines: string[] = [];
  const service = new AgentBrowserService({
    engine,
    secretManager: secrets,
    traceSink: (line) => {
      lines.push(line);
    },
  });
  try {
    const session = await service.createSession({
      tenantId: 'one',
      mode: 'bounty',
      scope: { allowedHosts: ['vinted.com'] },
    });
    secrets.registerSessionSecret(session.sessionId, 'private-token-1234');
    const events: unknown[] = [];
    service.subscribe(session.sessionId, (event) => events.push(event));
    create.mock.calls[0]![0]!.requestRecorder!({
      type: 'request.failed',
      timestamp: new Date().toISOString(),
      data: {
        method: 'PUT',
        url: 'https://vinted.com/private-token-1234',
        scope: 'SCOPE_METHOD_DENIED',
      },
    });
    expect(lines).toHaveLength(1);
    expect(JSON.stringify({ lines, events })).not.toContain('private-token-1234');
    expect(events).toContainEqual(expect.objectContaining({ type: 'scope.denied' }));
  } finally {
    await service.shutdown();
  }
});

it('honors opt-out, refuses unsupported traces and keeps trace write failures outside enforcement', async () => {
  const engine = new FakeEngine();
  const create = vi.spyOn(engine, 'createSession');
  const service = new AgentBrowserService({
    engine,
    traceSink: () => {
      throw new Error('output failed');
    },
  });
  try {
    const plain = await service.createSession({ tenantId: 'one' });
    expect(plain.trace).toBeUndefined();
    const off = await service.createSession({
      mode: 'bounty',
      trace: 'off',
      scope: { allowedHosts: ['vinted.com'] },
    });
    expect(off.trace).toBe('off');
    await expect(service.createSession({ trace: 'denials' })).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    });
    await expect(service.createSession({ trace: 'unknown' as never })).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    });
    const session = await service.createSession({
      mode: 'bounty',
      scope: { allowedHosts: ['vinted.com'], allowedMethods: ['GET'], requestBudget: 1 },
    });
    const options = create.mock.calls.at(-1)![0]!;
    options.requestRecorder!({
      type: 'request.failed',
      timestamp: new Date().toISOString(),
      data: { method: 'PUT', url: 'https://vinted.com/api', scope: 'SCOPE_METHOD_DENIED' },
    });
    expect(service.getSession(session.sessionId)).toMatchObject({ traceDropped: 1 });
    await expect(
      options.requestPolicy!.checkRequest({
        hostname: 'vinted.com',
        url: 'https://vinted.com/api',
        method: 'PUT',
      })
    ).rejects.toMatchObject({ details: { scope: 'SCOPE_METHOD_DENIED' } });
    const caps = await engine.capabilities();
    vi.spyOn(engine, 'capabilities').mockResolvedValue({ ...caps, requestRecording: false });
    await expect(
      service.createSession({ mode: 'bounty', scope: { allowedHosts: ['vinted.com'] } })
    ).rejects.toMatchObject({ code: 'ENGINE_UNSUPPORTED' });
  } finally {
    await service.shutdown();
  }
});

it('advises after a failed interaction near related denials without authorizing that host', async () => {
  const engine = new FakeEngine();
  const create = vi.spyOn(engine, 'createSession');
  const lines: string[] = [];
  const service = new AgentBrowserService({
    engine,
    traceSink: (line) => {
      lines.push(line);
    },
  });
  try {
    const session = await service.createSession({
      mode: 'bounty',
      scope: { allowedHosts: ['vinted.com'] },
    });
    const page = await service.createPage(session.sessionId);
    const recorder = create.mock.calls[0]![0]!.requestRecorder!;
    for (let i = 0; i < 3; i++)
      recorder({
        type: 'request.failed',
        timestamp: new Date().toISOString(),
        data: { method: 'GET', url: 'https://dd.vinted.lt/tag', scope: 'SCOPE_HOST_DENIED' },
      });
    await expect(
      service.navigate(session.sessionId, page.pageId, { url: 'https://dd.vinted.lt/tag' })
    ).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    expect(lines.join('\n')).toContain('functional dependency may be starved: dd.vinted.lt');
    expect(
      service.checkScope(session.sessionId, { url: 'https://dd.vinted.lt/tag' })
    ).toMatchObject({ allowed: false, scope: 'SCOPE_HOST_DENIED' });
  } finally {
    await service.shutdown();
  }
});
