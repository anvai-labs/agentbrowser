/**
 * Regression test for a production bug found during the 2026-09-05
 * hygiene-tail cycle: the real Playwright/Safari engines' screenshot()/pdf()
 * implementations returned a bare ArtifactRef with no byte payload, while
 * service.ts read a `bytesBase64` field off that same result to build the
 * stored artifact. `Buffer.from(undefined ?? '', 'base64')` silently
 * produced an empty buffer, so every real screenshot/PDF capture in
 * production was a 0-byte artifact - uncaught by any existing test, because
 * the service-level screenshot/pdf suites all ran against FakeEngine, whose
 * `Promise<any>`-typed methods happened to already include the field.
 *
 * This exercises the SERVICE's screenshot()/pdf() (not just the engine's
 * own return value) against a real Chromium instance, and asserts the
 * stored artifact's bytes actually decode to a valid PNG/PDF.
 */

import { type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PlaywrightChromiumEngine } from '@agentbrowser/engine-playwright';
import { NetworkPolicy } from '@agentbrowser/policy';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentBrowserService } from './service';

describe('screenshot/pdf against real Chromium (production byte-loss regression)', () => {
  let httpServer: Server;
  let baseUrl: string;
  let service: AgentBrowserService;
  let sessionId: string;
  let pageId: string;

  beforeEach(async () => {
    httpServer = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<!DOCTYPE html><html><body><h1>hello</h1></body></html>');
    });
    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    const { port } = httpServer.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}/`;

    service = new AgentBrowserService({
      engine: new PlaywrightChromiumEngine(),
      networkPolicy: new NetworkPolicy({ blockLoopback: false, blockPrivateIPs: false }),
    });
    const session = await service.createSession({ tenantId: 't1' });
    sessionId = session.sessionId;
    const page = await service.createPage(sessionId);
    pageId = page.pageId;
    await service.navigate(sessionId, pageId, { url: baseUrl });
  });

  afterEach(async () => {
    await service.shutdown();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  });

  it('produces a nonzero-size screenshot artifact with decodable PNG bytes', async () => {
    const metadata = await service.screenshot(sessionId, pageId, {});
    expect(metadata.sizeBytes).toBeGreaterThan(0);

    const stored = service.getArtifact(sessionId, metadata.artifactId);
    expect(stored).toBeDefined();
    const bytes = stored!.bytes;
    expect(bytes.length).toBe(metadata.sizeBytes);
    // PNG signature: 89 50 4E 47 0D 0A 1A 0A
    expect(Array.from(bytes.slice(0, 8))).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  }, 30_000);

  it('produces a nonzero-size PDF artifact with decodable PDF bytes', async () => {
    const metadata = await service.pdf(sessionId, pageId, {});
    expect(metadata.sizeBytes).toBeGreaterThan(0);

    const stored = service.getArtifact(sessionId, metadata.artifactId);
    expect(stored).toBeDefined();
    const bytes = stored!.bytes;
    expect(bytes.length).toBe(metadata.sizeBytes);
    // PDF signature: "%PDF-"
    expect(Buffer.from(bytes.slice(0, 5)).toString('ascii')).toBe('%PDF-');
  }, 30_000);
});
