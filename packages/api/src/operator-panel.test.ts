import { FakeEngine } from '@agentbrowser/testkit';
import { expect, it } from 'vitest';
import { buildServer } from './server.js';
it('serves a same-origin operator panel with no embedded credentials or third-party scripts', async () => {
  const server = await buildServer({ engine: new FakeEngine() });
  try {
    const result = await server.inject({ url: '/operator' });
    expect(result.statusCode).toBe(200);
    expect(result.headers['content-security-policy']).toContain("connect-src 'self'");
    expect(result.headers['cache-control']).toBe('no-store');
    expect(result.body).toContain('Take over');
    expect(result.body).toContain('type="password"');
    expect(result.body).not.toContain('localStorage');
  } finally {
    await server.close();
  }
});
