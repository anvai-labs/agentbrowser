/**
 * F3: /act batch - a `steps` envelope runs a short sequence through the
 * same bounded self-heal as /plan, with per-step in-band results and the
 * top-level wait / observe applied once at the end.
 */
import { FakeEngine } from '@agentbrowser/testkit';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from './server';
import { AgentBrowserService } from './service';

async function serviceSetup() {
  const engine = new FakeEngine();
  const service = new AgentBrowserService({ engine });
  const session = await service.createSession({ tenantId: 't1' });
  const pageId = (await service.createPage(session.sessionId)).pageId;
  await service.navigate(session.sessionId, pageId, { url: 'https://example.com/' });
  const observation = await service.observe(session.sessionId, pageId, { mode: 'interactive' });
  return { service, session, pageId, observation };
}

describe('act steps batch (service)', () => {
  it('runs a sequence and reports per-step results', async () => {
    const { service, session, pageId, observation } = await serviceSetup();
    const button = observation.elements[0]?.ref;
    const textbox = observation.elements[1]?.ref;
    if (!button || !textbox) throw new Error('fixture elements missing');

    const result = await service.act(session.sessionId, pageId, {
      steps: [
        { action: 'click', target: { ref: button } },
        { action: 'fill', target: { ref: textbox }, value: 'hello' },
      ],
    });

    expect(result.status).toBe('success');
    expect(result.completed).toBe(2);
    expect(result.results).toHaveLength(2);
    expect(result.results[0]).toMatchObject({ step: 0, ok: true });
    expect(result.results[1]).toMatchObject({ step: 1, ok: true });
    expect(result.oldRevision).toBe(observation.revision);
    expect(result.newRevision).toBeGreaterThan(observation.revision);
  });

  it('stops on the first failed step and reports it in-band', async () => {
    const { service, session, pageId, observation } = await serviceSetup();
    const button = observation.elements[0]?.ref;
    if (!button) throw new Error('fixture elements missing');

    const result = await service.act(session.sessionId, pageId, {
      steps: [
        { action: 'click', target: { ref: button } },
        { action: 'click', target: { ref: 'e9_9' } },
        { action: 'click', target: { ref: button } },
      ],
    });

    expect(result.status).toBe('failed');
    expect(result.completed).toBe(1);
    expect(result.results).toHaveLength(2);
    expect(result.results[0]?.ok).toBe(true);
    expect(result.results[1]?.ok).toBe(false);
    expect(result.results[1]?.error).toBeTruthy();
    expect(result.error?.code).toBe('PLAN_STEP_FAILED');
  });

  it('applies the top-level wait and observe once, at the end', async () => {
    const { service, session, pageId, observation } = await serviceSetup();
    const button = observation.elements[0]?.ref;
    if (!button) throw new Error('fixture elements missing');

    const result = await service.act(session.sessionId, pageId, {
      steps: [{ action: 'click', target: { ref: button } }],
      wait: { until: 'minElements', count: 1 },
      observe: 'after',
    });

    expect(result.status).toBe('success');
    expect(result.waitReason).toBe('minElements');
    expect(result.observation?.revision).toBe(result.newRevision);
  });

  it('rejects an out-of-range steps array', async () => {
    const { service, session, pageId } = await serviceSetup();

    const error = await service
      .act(session.sessionId, pageId, { steps: [] })
      .catch((e: unknown) => e as { code: string });
    expect(error.code).toBe('INVALID_REQUEST');

    const tooMany = Array.from({ length: 21 }, () => ({
      action: 'click',
      target: { ref: 'e2_0' },
    }));
    const error2 = await service
      .act(session.sessionId, pageId, { steps: tooMany })
      .catch((e: unknown) => e as { code: string });
    expect(error2.code).toBe('INVALID_REQUEST');
  });
});

describe('act steps batch (wire)', () => {
  let server: FastifyInstance;
  let baseUrl: string;

  beforeAll(async () => {
    server = await buildServer();
    baseUrl = await server.listen({ port: 0, host: '127.0.0.1' });
  });
  afterAll(async () => {
    await server.close();
  });

  async function freshPage() {
    const sessionResponse = await fetch(`${baseUrl}/v1/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tenantId: 'batch' }),
    });
    const { sessionId } = (await sessionResponse.json()) as { sessionId: string };
    const pageResponse = await fetch(`${baseUrl}/v1/sessions/${sessionId}/pages`, {
      method: 'POST',
    });
    const { pageId } = (await pageResponse.json()) as { pageId: string };
    await fetch(`${baseUrl}/v1/sessions/${sessionId}/pages/${pageId}/navigate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com/' }),
    });
    const observationResponse = await fetch(
      `${baseUrl}/v1/sessions/${sessionId}/pages/${pageId}/observe`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }
    );
    const observation = (await observationResponse.json()) as {
      elements: Array<{ ref: string }>;
      revision: number;
    };
    return { sessionId, pageId, ref: observation.elements[0]?.ref as string };
  }

  it('accepts a steps envelope and returns per-step results', async () => {
    const { sessionId, pageId, ref } = await freshPage();
    const response = await fetch(`${baseUrl}/v1/sessions/${sessionId}/pages/${pageId}/act`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        steps: [
          { action: 'click', target: { ref } },
          { action: 'click', target: { ref } },
        ],
      }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      status: string;
      completed: number;
      results: Array<{ ok: boolean }>;
    };
    expect(body.status).toBe('success');
    expect(body.completed).toBe(2);
    expect(body.results).toHaveLength(2);
  });

  it('rejects malformed batch envelopes with 400', async () => {
    const { sessionId, pageId, ref } = await freshPage();
    const post = (body: unknown) =>
      fetch(`${baseUrl}/v1/sessions/${sessionId}/pages/${pageId}/act`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

    const empty = await post({ steps: [] });
    expect(empty.status).toBe(400);
    expect(((await empty.json()) as { error: { code: string } }).error.code).toBe(
      'INVALID_REQUEST'
    );

    const mixed = await post({ action: 'click', target: { ref }, steps: [] });
    expect(mixed.status).toBe(400);

    const badStep = await post({ steps: [{ action: 'teleport' }] });
    expect(badStep.status).toBe(400);
    const badStepBody = (await badStep.json()) as { error: { details?: { issues?: unknown[] } } };
    expect(badStepBody.error.details?.issues).toBeTruthy();
  });
});
