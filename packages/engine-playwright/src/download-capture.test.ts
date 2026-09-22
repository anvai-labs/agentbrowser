import http from 'node:http';
import type { EngineEvent } from '@agentbrowser/engine';
import { describe, expect, it, vi } from 'vitest';
import { PlaywrightChromiumEngine } from './index.js';

/**
 * Attachment fixture: GET /dl/<name>/<bytes> serves an attachment with that
 * suggested filename and exact body size; anything else is a plain page.
 */
function downloadFixtures(): Promise<{
  url(name: string, bytes: number): string;
  stop(): Promise<void>;
}> {
  const server = http.createServer((request, response) => {
    const match = /^\/dl\/([^/]+)\/(\d+)$/.exec(request.url ?? '/');
    if (match === null) {
      response.writeHead(200, { 'content-type': 'text/html' }).end('<body>dl fixture</body>');
      return;
    }
    const payload = Buffer.alloc(Number(match[2]), 0x61);
    response.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': String(payload.length),
      'content-disposition': `attachment; filename="${decodeURIComponent(match[1])}"`,
    });
    response.end(payload);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      resolve({
        url: (name, bytes) => `http://127.0.0.1:${port}/dl/${encodeURIComponent(name)}/${bytes}`,
        stop: () =>
          new Promise((done) => {
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
    });
  });
}

/** Engine page wired to an event collector (download.created/finished/failed). */
async function observedDownloadPage(
  fixtures: { url(name: string, bytes: number): string },
  downloadPolicy: { allow: boolean; maxBytes: number } = { allow: true, maxBytes: 10 * 1024 * 1024 }
) {
  const engine = new PlaywrightChromiumEngine();
  const session = await engine.createSession({ headless: true, downloadPolicy });
  const page = await session.newPage();
  const events: EngineEvent[] = [];
  (async () => {
    for await (const event of page.events()) {
      events.push(event);
    }
  })().catch(() => {});

  /** Navigate to an attachment; the navigation rejects but the download fires. */
  const trigger = async (name: string, bytes: number) => {
    await page.navigate({ url: fixtures.url(name, bytes) }).catch(() => {});
  };
  const waitForDownloads = async (count: number) => {
    await vi.waitFor(() => {
      expect(events.filter((event) => event.type === 'download.finished')).toHaveLength(count);
    });
  };
  const createdId = (filename: string): string => {
    const created = events.find(
      (event) => event.type === 'download.created' && event.data?.filename === filename
    );
    if (!created?.data?.downloadId) throw new Error(`no download.created for ${filename}`);
    return String(created.data.downloadId);
  };

  return { engine, session, page, events, trigger, waitForDownloads, createdId };
}

/**
 * In-page download capture (spec 10): the download policy gates what the
 * engine holds, the hold budget evicts oldest-first, and consumption works
 * by unique id with an unambiguous-filename fallback.
 */
describe('in-page download policy and hold budget (spec 10)', () => {
  it('cancels a download and reports download.failed when the policy disallows downloads', async () => {
    const fixtures = await downloadFixtures();
    const engine = new PlaywrightChromiumEngine();
    try {
      const session = await engine.createSession({
        headless: true,
        downloadPolicy: { allow: false, maxBytes: 1024 },
      });
      const page = await session.newPage();
      const events: EngineEvent[] = [];
      (async () => {
        for await (const event of page.events()) {
          events.push(event);
        }
      })().catch(() => {});

      await page.navigate({ url: fixtures.url('report.csv', 32) }).catch(() => {});

      await vi.waitFor(() => {
        expect(events.some((event) => event.type === 'download.failed')).toBe(true);
      });
      const failed = events.find((event) => event.type === 'download.failed');
      expect(failed?.data).toMatchObject({ filename: 'report.csv', code: 'DOWNLOAD_BLOCKED' });
      expect(await session.takeDownload?.(page.id, 'report.csv')).toBeUndefined();

      await page.close().catch(() => {});
    } finally {
      await engine.close();
      await fixtures.stop();
    }
  });

  it('refuses to hold a download that exceeds the policy byte limit', async () => {
    const fixtures = await downloadFixtures();
    const engine = new PlaywrightChromiumEngine();
    try {
      const session = await engine.createSession({
        headless: true,
        downloadPolicy: { allow: true, maxBytes: 16 },
      });
      const page = await session.newPage();
      const events: EngineEvent[] = [];
      (async () => {
        for await (const event of page.events()) {
          events.push(event);
        }
      })().catch(() => {});

      await page.navigate({ url: fixtures.url('huge.bin', 4096) }).catch(() => {});

      await vi.waitFor(() => {
        expect(events.some((event) => event.type === 'download.failed')).toBe(true);
      });
      const failed = events.find((event) => event.type === 'download.failed');
      expect(failed?.data).toMatchObject({ filename: 'huge.bin', code: 'DOWNLOAD_BLOCKED' });
      expect(await session.takeDownload?.(page.id, 'huge.bin')).toBeUndefined();

      await page.close().catch(() => {});
    } finally {
      await engine.close();
      await fixtures.stop();
    }
  });

  it('evicts the oldest held download when the byte budget is exceeded', async () => {
    const fixtures = await downloadFixtures();
    const harness = await observedDownloadPage(fixtures, {
      allow: true,
      maxBytes: 30 * 1024 * 1024,
    });
    const { engine, session, page, trigger, waitForDownloads, createdId } = harness;
    try {
      // Each download fits the policy (30 MiB) but two of them exceed the
      // engine's 20 MiB hold budget: the oldest must be evicted, not kept.
      await trigger('big-a.bin', 11 * 1024 * 1024);
      await waitForDownloads(1);
      await trigger('big-b.bin', 11 * 1024 * 1024);
      await waitForDownloads(2);

      const idA = createdId('big-a.bin');
      const idB = createdId('big-b.bin');

      expect(await session.takeDownload?.(page.id, idA)).toBeUndefined();
      const kept = await session.takeDownload?.(page.id, idB);
      expect(kept?.filename).toBe('big-b.bin');
      expect(kept?.downloadId).toBe(idB);
      expect(kept?.bytes.byteLength).toBe(11 * 1024 * 1024);
      expect(Buffer.from(kept?.bytes ?? []).toString('utf8')[0]).toBe('a');
    } finally {
      await page.close().catch(() => {});
      await engine.close();
      await fixtures.stop();
    }
  }, 45_000);

  it('serves a held download by unique id and refuses an ambiguous filename', async () => {
    const fixtures = await downloadFixtures();
    const harness = await observedDownloadPage(fixtures);
    const { engine, session, page, events, trigger, waitForDownloads, createdId } = harness;
    try {
      // Two captures share one suggested filename: consuming by filename is
      // ambiguous and must refuse rather than guess.
      await trigger('same.csv', 16);
      await waitForDownloads(1);
      await trigger('same.csv', 16);
      await waitForDownloads(2);

      await expect(session.takeDownload?.(page.id, 'same.csv')).rejects.toMatchObject({
        code: 'INVALID_REQUEST',
      });

      const idFirst = createdId('same.csv');
      const first = await session.takeDownload?.(page.id, idFirst);
      expect(first?.downloadId).toBe(idFirst);
      expect(first?.filename).toBe('same.csv');
      expect(Buffer.from(first?.bytes ?? []).toString('utf8')).toBe('a'.repeat(16));

      // The second capture is untouched and consumable by its own id.
      const idSecond = events
        .filter((event) => event.type === 'download.created')
        .map((event) => String(event.data?.downloadId))
        .at(-1);
      const second = await session.takeDownload?.(page.id, idSecond ?? '');
      expect(second?.downloadId).toBe(idSecond);
    } finally {
      await page.close().catch(() => {});
      await engine.close();
      await fixtures.stop();
    }
  }, 45_000);
});
