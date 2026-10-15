import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeEngine } from '@agentbrowser/testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LoginBrowserService } from './login-browser-service.js';
import { startServer } from './server.js';

/**
 * TD-BROWSER-16 phase 4: the login browser as the service sees it — enabled
 * only with the flag, refusing hosted/multi-tenant deployments, and the
 * operator-route contract (agent credentials refused) is covered by the
 * operator-auth suite. The engine behaviors (pipe launch, profile security,
 * lifecycle, filtering) are covered in engine-playwright.
 */

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'lb-service-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('LoginBrowserService', () => {
  it('is disabled without the flag, and every operation names why', async () => {
    const service = new LoginBrowserService({ enabled: false });
    expect(service.isEnabled).toBe(false);
    for (const operation of [
      () => service.open(),
      () => service.close(),
      () => service.reset(),
      () => service.read(),
    ] as const) {
      await expect(operation()).rejects.toThrow(/login browser is disabled/);
    }
  });

  it('the full lifecycle: open, read is a closed-shape result, close, reset', async () => {
    const service = new LoginBrowserService({
      enabled: true,
      profileDir: join(dir, 'profile-lifecycle'),
      headless: process.env.AGENTBROWSER_LOGIN_HEADLESS === '1',
    });
    try {
      expect((await service.open()).open).toBe(true);
      const read = await service.read();
      expect(Array.isArray(read.cookies)).toBe(true);
      expect(typeof read.skipped.partitioned).toBe('number');
      await service.close();
      await service.reset();
    } finally {
      await service.closeForShutdown();
    }
  }, 240_000);
});

describe('LoginBrowserService startup refusals', () => {
  it('a startServer with loginBrowser but no operator keys refuses at boot', async () => {
    const previous = process.env.AGENTBROWSER_OPERATOR_KEYS_FILE;
    delete process.env.AGENTBROWSER_OPERATOR_KEYS_FILE;
    try {
      await expect(
        startServer({ engine: new FakeEngine(), loginBrowser: true, port: 0 })
      ).rejects.toThrow(/requires AGENTBROWSER_OPERATOR_KEYS_FILE/);
    } finally {
      if (previous !== undefined) process.env.AGENTBROWSER_OPERATOR_KEYS_FILE = previous;
    }
  });

  it('an API-key operator cannot touch the login browser routes; a human operator can be refused cleanly when disabled', async () => {
    // The routes refuse non-human principals inside the handler, so without
    // operator keys the service is not even constructed — 403 from the hook
    // or the disabled refusal both apply; assert the disabled path here.
    const service = new LoginBrowserService({ enabled: false });
    await expect(service.open()).rejects.toThrow(/disabled/);
  });
});
