/**
 * Deterministic end-to-end workflows (Phase 1 exit criterion)
 *
 * Ten complete agent workflows against the real service over HTTP, backed by
 * FakeEngine: no network, no sleeps, no live sites. Each workflow is the
 * observe -> decide -> act loop an agent actually runs.
 */

import { FakeEngine } from '@agentbrowser/testkit';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from './server';

describe('deterministic workflows', () => {
  let server: FastifyInstance;
  let baseUrl: string;
  let engine: FakeEngine;

  beforeAll(async () => {
    engine = new FakeEngine();
    server = await buildServer({ engine });
    const address = await server.listen({ port: 0, host: '127.0.0.1' });
    baseUrl = address;
  });

  afterAll(async () => {
    await server.close();
  });

  const api = async (
    method: string,
    path: string,
    body?: unknown
  ): Promise<{ status: number; body: any }> => {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      ...(body !== undefined
        ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
        : {}),
    });
    return { status: response.status, body: await response.json() };
  };

  /** Create a session + page, already navigated to the work URL. */
  const newBrowsingContext = async (url = 'https://app.example.com') => {
    const created = await api('POST', '/v1/sessions', { tenantId: 'wf' });
    const sessionId = created.body.sessionId;
    const page = await api('POST', `/v1/sessions/${sessionId}/pages`);
    const pageId = page.body.pageId;
    await api('POST', `/v1/sessions/${sessionId}/pages/${pageId}/navigate`, { url });
    return { sessionId, pageId };
  };

  const observe = (sessionId: string, pageId: string) =>
    api('POST', `/v1/sessions/${sessionId}/pages/${pageId}/observe`, {});

  const act = (sessionId: string, pageId: string, body: unknown) =>
    api('POST', `/v1/sessions/${sessionId}/pages/${pageId}/act`, body);

  // 1 -----------------------------------------------------------------------
  it('workflow 1: session lifecycle - create, use, close, and lose access', async () => {
    const created = await api('POST', '/v1/sessions', { tenantId: 'wf1' });
    expect(created.status).toBe(201);

    const { sessionId } = created.body;
    const got = await api('GET', `/v1/sessions/${sessionId}`);
    expect(got.status).toBe(200);
    expect(got.body.sessionId).toBe(sessionId);

    const listed = await api('GET', '/v1/sessions');
    expect(listed.body.sessions.some((s: any) => s.sessionId === sessionId)).toBe(true);

    const page = await api('POST', `/v1/sessions/${sessionId}/pages`);
    expect(page.status).toBe(201);

    const closed = await api('DELETE', `/v1/sessions/${sessionId}`);
    expect(closed.body).toMatchObject({ sessionId, status: 'closed' });

    // After close, the session and its pages are gone.
    const gone = await api('GET', `/v1/sessions/${sessionId}`);
    expect(gone.status).toBe(404);
    const pageGone = await api(
      'POST',
      `/sessions/${sessionId}/pages/${page.body.pageId}/observe`,
      {}
    );
    expect(pageGone.status).toBe(404);
  });

  // 2 -----------------------------------------------------------------------
  it('workflow 2: page lifecycle within a session', async () => {
    const { sessionId } = await newBrowsingContext();
    const page = await api('POST', `/v1/sessions/${sessionId}/pages`);
    const pageId = page.body.pageId;

    const got = await api('GET', `/v1/sessions/${sessionId}/pages/${pageId}`);
    expect(got.status).toBe(200);
    expect(got.body.pageId).toBe(pageId);

    await api('POST', `/v1/sessions/${sessionId}/pages/${pageId}/navigate`, {
      url: 'https://second.example.com',
    });
    const observed = await observe(sessionId, pageId);
    expect(observed.body.url).toBe('https://second.example.com');

    const closed = await api('DELETE', `/v1/sessions/${sessionId}/pages/${pageId}`);
    expect(closed.body).toMatchObject({ pageId, status: 'closed' });

    const afterClose = await observe(sessionId, pageId);
    expect(afterClose.status).toBe(404);
  });

  // 3 -----------------------------------------------------------------------
  it('workflow 3: navigation moves the page and invalidates prior refs', async () => {
    const { sessionId, pageId } = await newBrowsingContext('https://first.example.com');

    const before = await observe(sessionId, pageId);
    expect(before.body.url).toBe('https://first.example.com');
    const staleRef = before.body.elements[0].ref;

    await api('POST', `/v1/sessions/${sessionId}/pages/${pageId}/navigate`, {
      url: 'https://second.example.com',
    });

    const after = await observe(sessionId, pageId);
    expect(after.body.url).toBe('https://second.example.com');
    expect(after.body.revision).toBeGreaterThan(before.body.revision);

    // The ref minted before navigation is now stale.
    const denied = await act(sessionId, pageId, {
      action: 'click',
      target: { ref: staleRef },
    });
    expect(denied.status).toBe(400);
    expect(denied.body.error.code).toBe('STALE_TARGET');
  });

  // 4 -----------------------------------------------------------------------
  it('workflow 4: observe - act - re-observe with a post-action observation', async () => {
    const { sessionId, pageId } = await newBrowsingContext();

    const first = await observe(sessionId, pageId);
    const ref = first.body.elements[0].ref;

    const result = await act(sessionId, pageId, {
      action: 'click',
      target: { ref },
      observe: 'after',
    });

    expect(result.status).toBe(200);
    expect(result.body.status).toBe('success');
    expect(result.body.newRevision).toBeGreaterThan(first.body.revision);

    // The attached observation is at the new revision, ready for the next step.
    expect(result.body.observation.revision).toBe(result.body.newRevision);
    const nextRef = result.body.observation.elements[0].ref;
    expect(nextRef).toMatch(new RegExp(`^e${result.body.newRevision}_\\d+$`));

    // And the agent can act on it immediately.
    const next = await act(sessionId, pageId, { action: 'click', target: { ref: nextRef } });
    expect(next.status).toBe(200);
  });

  // 5 -----------------------------------------------------------------------
  it('workflow 5: fill a form and verify the value landed', async () => {
    const { sessionId, pageId } = await newBrowsingContext();

    const page = await observe(sessionId, pageId);
    const email = page.body.elements.find((e: any) => e.role === 'textbox');
    expect(email).toBeDefined();

    const filled = await act(sessionId, pageId, {
      action: 'fill',
      target: { ref: email.ref },
      value: 'agent@example.com',
    });
    expect(filled.status).toBe(200);

    const verified = await observe(sessionId, pageId);
    const observed = verified.body.elements.find((e: any) => e.role === 'textbox');
    expect(observed.value).toBe('agent@example.com');
  });

  // 6 -----------------------------------------------------------------------
  it('workflow 6: staleness enforcement - never act on a moved page', async () => {
    const { sessionId, pageId } = await newBrowsingContext();

    const first = await observe(sessionId, pageId);
    const ref = first.body.elements[0].ref;

    // An out-of-band action moves the page on.
    await act(sessionId, pageId, { action: 'press', key: 'Enter' });

    const stale = await act(sessionId, pageId, { action: 'click', target: { ref } });
    expect(stale.status).toBe(400);
    expect(stale.body.error).toMatchObject({ code: 'STALE_TARGET', retryable: true });

    // The correct agent response: re-observe, act on the fresh ref.
    const fresh = await observe(sessionId, pageId);
    const freshRef = fresh.body.elements[0].ref;
    expect(freshRef).not.toBe(ref);

    const retried = await act(sessionId, pageId, { action: 'click', target: { ref: freshRef } });
    expect(retried.status).toBe(200);
  });

  // 7 -----------------------------------------------------------------------
  it('workflow 7: approval gate - high-risk action needs a single-use token', async () => {
    const { sessionId, pageId } = await newBrowsingContext('https://shop.example.com');

    // A checkout button classified as a transaction risk.
    const engineSessionIds = engine.getSessionIds();
    const enginePage =
      engineSessionIds[engineSessionIds.length - 1] !== undefined
        ? engine.getFakePage(engineSessionIds[engineSessionIds.length - 1]!, pageId)
        : undefined;
    enginePage?.setElements([{ role: 'button', name: 'Pay now', risk: 'transaction' }]);

    const observed = await observe(sessionId, pageId);
    const payRef = observed.body.elements[0].ref;

    const denied = await act(sessionId, pageId, { action: 'click', target: { ref: payRef } });
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('APPROVAL_REQUIRED');
    const { tokenId } = denied.body.error.details;

    const approved = await act(sessionId, pageId, {
      action: 'click',
      target: { ref: payRef },
      approvalToken: tokenId,
    });
    expect(approved.status).toBe(200);

    // The token is burned: a new denial for the (now stale) ref does not
    // accept it again.
    const reobserved = await observe(sessionId, pageId);
    const freshRef = reobserved.body.elements[0].ref;
    const deniedAgain = await act(sessionId, pageId, {
      action: 'click',
      target: { ref: freshRef },
    });
    const replay = await act(sessionId, pageId, {
      action: 'click',
      target: { ref: freshRef },
      approvalToken: tokenId,
    });
    expect(replay.status).toBe(403);
    expect((replay.body.error.details as { tokenId: string }).tokenId).not.toBe(tokenId);
    expect(deniedAgain.status).toBe(403);
  });

  // 8 -----------------------------------------------------------------------
  it('workflow 8: SSRF defense - dangerous navigation targets are refused', async () => {
    const { sessionId, pageId } = await newBrowsingContext();

    const targets = [
      'http://localhost/admin',
      'http://127.0.0.1:8080/',
      'http://192.168.0.10/router',
      'http://169.254.169.254/latest/meta-data/',
      'file:///etc/passwd',
    ];

    for (const url of targets) {
      const denied = await api('POST', `/v1/sessions/${sessionId}/pages/${pageId}/navigate`, {
        url,
      });
      expect(denied.status).toBe(403);
      expect(denied.body.error.code).toBe('POLICY_DENIED');
    }

    // Public https still works.
    const allowed = await api('POST', `/v1/sessions/${sessionId}/pages/${pageId}/navigate`, {
      url: 'https://public.example.com',
    });
    expect(allowed.status).toBe(200);
  });

  // 9 -----------------------------------------------------------------------
  it('workflow 9: session isolation - pages never cross sessions', async () => {
    const a = await newBrowsingContext('https://a.example.com');
    const b = await newBrowsingContext('https://b.example.com');

    // A's page is invisible through B's session id.
    const crossRead = await api('GET', `/v1/sessions/${b.sessionId}/pages/${a.pageId}`);
    expect(crossRead.status).toBe(404);

    const crossAct = await act(b.sessionId, a.pageId, {
      action: 'click',
      target: { ref: 'e1_0' },
    });
    expect(crossAct.status).toBe(404);

    // Closing A leaves B fully functional.
    await api('DELETE', `/v1/sessions/${a.sessionId}`);
    const stillAlive = await observe(b.sessionId, b.pageId);
    expect(stillAlive.status).toBe(200);
    expect(stillAlive.body.url).toBe('https://b.example.com');
  });

  // 10 ----------------------------------------------------------------------
  it('workflow 10: screenshot evidence for an observed state', async () => {
    const { sessionId, pageId } = await newBrowsingContext('https://report.example.com');

    const observed = await observe(sessionId, pageId);
    expect(observed.body.url).toBe('https://report.example.com');

    const png = await api('POST', `/v1/sessions/${sessionId}/pages/${pageId}/screenshot`, {
      format: 'png',
    });
    expect(png.status).toBe(200);
    expect(png.body).toMatchObject({
      type: 'screenshot',
      contentType: 'image/png',
    });
    expect(png.body.sizeBytes).toBeGreaterThan(0);

    const jpeg = await api('POST', `/v1/sessions/${sessionId}/pages/${pageId}/screenshot`, {
      format: 'jpeg',
      fullPage: true,
    });
    expect(jpeg.body.contentType).toBe('image/jpeg');

    const bad = await api('POST', `/v1/sessions/${sessionId}/pages/${pageId}/screenshot`, {
      format: 'bmp',
    });
    expect(bad.status).toBe(400);
  });
});
