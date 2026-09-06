import { SafaridriverEngine } from '@agentbrowser/engine-safari';
import { FakeEngine } from '@agentbrowser/testkit';
import { expect, it, vi } from 'vitest';
import { buildServer } from './server.js';

it('reports guarded Safari creation as an unsupported capability, not an internal error', async () => {
  const startDriver = vi.fn(async () => {
    throw new Error('Policy refusal must precede driver startup');
  });
  const server = await buildServer({
    engine: new FakeEngine(),
    engines: { safari: new SafaridriverEngine({ startDriver }) },
  });
  try {
    const response = await server.inject({
      method: 'POST',
      url: '/v1/sessions',
      payload: { tenantId: 'local', engine: 'safari', headless: false },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({
      error: { code: 'ENGINE_UNSUPPORTED', details: { reason: 'EGRESS_UNSUPPORTED' } },
    });
    expect(startDriver).not.toHaveBeenCalled();
  } finally {
    await server.close();
  }
});
