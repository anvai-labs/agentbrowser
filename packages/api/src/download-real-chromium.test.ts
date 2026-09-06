import { createServer } from 'node:http';
import { PlaywrightChromiumEngine } from '@agentbrowser/engine-playwright';
import { NetworkPolicy } from '@agentbrowser/policy';
import { expect, it, vi } from 'vitest';
import { AgentBrowserService } from './service.js';

it('renders chunked HTML and collects distinct real downloads through the service', async () => {
  const fixture = createServer((request, response) => {
    if (request.url === '/file') {
      response.writeHead(200, {
        'content-disposition': 'attachment; filename="report.csv"',
        'content-type': 'text/csv',
      });
      response.end('a,b\n1,2\n');
    } else {
      response.write('<a href="/file" download>Get report</a>');
      response.end();
    }
  });
  await new Promise<void>((resolve) => fixture.listen(0, '127.0.0.1', resolve));
  const engine = new PlaywrightChromiumEngine();
  const createdSessions = vi.spyOn(engine, 'createSession');
  const service = new AgentBrowserService({
    engine,
    networkPolicy: new NetworkPolicy(),
  });
  try {
    const address = fixture.address();
    if (!address || typeof address === 'string') throw new Error('Missing fixture address');
    const { sessionId } = await service.createSession({ tenantId: 'local', allowDownloads: true });
    const { pageId } = await service.createPage(sessionId);
    await service.navigate(sessionId, pageId, { url: `http://127.0.0.1:${address.port}` });
    const ids: string[] = [];
    service.subscribe(sessionId, (event) => {
      if (event.type === 'download.finished' && typeof event.data?.downloadId === 'string')
        ids.push(event.data.downloadId);
    });
    for (let index = 0; index < 2; index += 1) {
      const ref = (await service.observe(sessionId, pageId, {})).elements.find(
        (element) => element.name === 'Get report'
      )?.ref;
      if (!ref) throw new Error('Chunked HTML did not render its link');
      await service.act(sessionId, pageId, { action: 'click', target: { ref } });
      await expect.poll(() => ids.length).toBe(index + 1);
    }
    expect(new Set(ids).size).toBe(2);
    await expect(service.collectDownload(sessionId, pageId, 'report.csv')).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    });
    const id = ids[0];
    if (!id) throw new Error('Missing download ID');
    const artifact = await service.collectDownload(sessionId, pageId, id);
    expect(artifact.filename).toBe('report.csv');
    expect(
      Buffer.from(service.getArtifact(sessionId, artifact.artifactId)?.bytes ?? []).toString()
    ).toBe('a,b\n1,2\n');
    await expect(service.collectDownload(sessionId, pageId, id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    const engineSession = await createdSessions.mock.results[0]?.value;
    const enginePage = (await engineSession.pages())[0];
    await service.closePage(sessionId, pageId);
    expect(await engineSession.takeDownload(enginePage.id, ids[1])).toBeUndefined();
  } finally {
    await service.shutdown();
    fixture.closeAllConnections();
    await new Promise<void>((resolve) => fixture.close(() => resolve()));
  }
}, 30_000);
