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
    expect(result.body).toContain('<select id="mode"');
    expect(result.body).toContain('<option value="audit">audit</option>');
    expect(result.body).toContain('Delegation decision');
    expect(result.body).toContain('Profile-permitted capabilities');
    expect(result.body).toContain('service policy may narrow them');
    expect(result.body).toContain("{ epoch: review.epoch, mode: byId('mode').value }");
    expect(result.body).toContain('aria-live="polite"');
    expect(result.body).not.toContain('localStorage');
    expect(result.body).not.toContain('ArrowLeft');
  } finally {
    await server.close();
  }
});
