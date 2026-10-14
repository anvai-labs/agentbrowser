import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeEngine } from '@agentbrowser/testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer } from './server.js';

/**
 * TD-BROWSER-16 phase 1: operator keys authenticate a human operator on
 * operator-flagged routes ONLY; everywhere else they are refused, and they can
 * never create sessions or act.
 */

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'operator-auth-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const OPERATOR_KEY = 'operator-key-aaaaaaaaaa';
const sha = (key: string) => createHash('sha256').update(key).digest('hex');

const previous: Record<string, string | undefined> = {};
const start = async (overrides: Record<string, string | undefined> = {}) => {
  const path = join(dir, 'keys');
  await writeFile(path, `${OPERATOR_KEY}:acme\n`);
  const wanted = {
    AGENTBROWSER_API_KEYS: 'api-key-aaaaaaaaaaaa:acme',
    AGENTBROWSER_OPERATOR_KEYS_FILE: path,
    ...overrides,
  };
  for (const [key, value] of Object.entries(wanted)) previous[key] = process.env[key];
  try {
    for (const [key, value] of Object.entries(wanted)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    return await startServer({ engine: new FakeEngine(), port: 0 });
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};

describe('operator keys', () => {
  it('are refused on non-operator routes (session creation)', async () => {
    const app = await start();
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/sessions',
        headers: { authorization: `Bearer ${OPERATOR_KEY}` },
        payload: {},
      });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ error: { code: 'FORBIDDEN' } });
    } finally {
      await app.close();
    }
  });

  it('cannot act either: a full agent surface route refuses them', async () => {
    const app = await start();
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/v1/sessions/ses_none/pages',
        headers: { authorization: `Bearer ${OPERATOR_KEY}` },
      });
      expect([401, 403]).toContain(response.statusCode);
      if (response.statusCode === 403) {
        expect(response.json()).toMatchObject({ error: { code: 'FORBIDDEN' } });
      }
    } finally {
      await app.close();
    }
  });

  it('an API key is not a human operator: both authenticate differently', async () => {
    const app = await start();
    try {
      // The API key works on ordinary routes (it is an operator principal).
      const asOperator = await app.inject({
        method: 'POST',
        url: '/v1/sessions',
        headers: { authorization: 'Bearer api-key-aaaaaaaaaaaa' },
        payload: {},
      });
      expect(asOperator.statusCode).toBeLessThan(500);
    } finally {
      await app.close();
    }
  });

  it('startup refuses a key present in both credential sets', async () => {
    const shared = 'shared-key-aaaaaaaaaaaa';
    const path = join(dir, 'overlap');
    await writeFile(path, `${shared}:acme\n`);
    await expect(
      start({
        AGENTBROWSER_API_KEYS: `${shared}:acme`,
        AGENTBROWSER_OPERATOR_KEYS_FILE: path,
      })
    ).rejects.toThrow(/one credential, one identity/);
  });
});

describe('non-act approval kinds: the separate path (TD-BROWSER-16 phase 1)', () => {
  it('an API key is refused on view and decide; an operator key can view and decide', async () => {
    const app = await start();
    try {
      // Mint a cookie.handoff approval through the app's own service.
      const own = (app as unknown as { service: import('./service.js').AgentBrowserService })
        .service;
      const session = await own.createSession({ tenantId: 'acme' });
      const token = await own.approvalGate.generateApprovalToken({
        sessionId: session.sessionId,
        action: { type: 'cookie.handoff' },
        kind: 'cookie.handoff',
        domains: ['example.com'],
        counts: { 'example.com': 3 },
      });
      const view = async (key: string) =>
        (
          await app.inject({
            method: 'GET',
            url: `/v1/sessions/${session.sessionId}/approvals/${token.tokenId}`,
            headers: { authorization: `Bearer ${key}` },
          })
        ).json() as {
          kind?: string;
          domains?: string[];
          counts?: Record<string, number>;
          error?: { code: string };
        };
      // An API key (plain operator) is refused for the non-act kind.
      const asApiKey = await view('api-key-aaaaaaaaaaaa');
      expect(asApiKey).toMatchObject({ error: { code: 'FORBIDDEN' } });
      // The human operator views the bound evidence verbatim.
      const asOperator = await view(OPERATOR_KEY);
      expect(asOperator).toMatchObject({
        kind: 'cookie.handoff',
        domains: ['example.com'],
        counts: { 'example.com': 3 },
      });
      // And decides: single-use.
      const decided = await app.inject({
        method: 'POST',
        url: `/v1/sessions/${session.sessionId}/approvals/${token.tokenId}`,
        headers: { authorization: `Bearer ${OPERATOR_KEY}` },
        payload: { decision: 'approve' },
      });
      expect(decided.json()).toMatchObject({ kind: 'cookie.handoff', status: 'approved' });
      const again = await app.inject({
        method: 'POST',
        url: `/v1/sessions/${session.sessionId}/approvals/${token.tokenId}`,
        headers: { authorization: `Bearer ${OPERATOR_KEY}` },
        payload: { decision: 'approve' },
      });
      expect(again.statusCode).toBeGreaterThanOrEqual(400);
      await own.closeSession(session.sessionId);
    } finally {
      await app.close();
    }
  });

  it('an act-kind token keeps its existing path (no kind on the token)', async () => {
    const { AgentBrowserService } = await import('./service.js');
    const own = new AgentBrowserService({ engine: new FakeEngine() });
    const session = await own.createSession({ tenantId: 'acme' });
    const token = await own.approvalGate.generateApprovalToken({
      sessionId: session.sessionId,
      action: { type: 'click', ref: 'e1_1' },
    });
    expect(token.kind).toBeUndefined();
    expect(await own.getApprovalKind(session.sessionId, token.tokenId)).toBeUndefined();
    await own.shutdown();
  });
});
