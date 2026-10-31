import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PlaywrightChromiumEngine } from '@agentbrowser/engine-playwright';
import { NetworkPolicy } from '@agentbrowser/policy';
import { expect, it } from 'vitest';
import { AgentBrowserService } from './service.js';

it('prints the first SPA PUT denial immediately and retains the same refusal in its sealed ledger', async () => {
  let putHits = 0;
  const fixture = createServer((request, response) => {
    if (request.method === 'PUT') putHits++;
    response
      .writeHead(200, { 'content-type': 'text/html' })
      .end(
        '<link rel="icon" href="data:,"><script>fetch("/verify",{method:"PUT"}).catch(()=>document.body.textContent="Incorrect code")</script><body>Verification</body>'
      );
  });
  const directory = await mkdtemp(join(tmpdir(), 'trace-real-'));
  await new Promise<void>((resolve) => fixture.listen(0, '127.0.0.1', resolve));
  const port = (fixture.address() as { port: number }).port;
  const lines: string[] = [];
  const service = new AgentBrowserService({
    engine: new PlaywrightChromiumEngine(),
    networkPolicy: new NetworkPolicy(),
    engagement: { directory },
    traceSink: (line) => {
      lines.push(line);
    },
  });
  try {
    const session = await service.createSession({
      tenantId: 'fixture',
      mode: 'bounty',
      headless: true,
      scope: { allowedHosts: ['127.0.0.1'], allowedMethods: ['GET'], ledger: true },
    });
    const page = await service.createPage(session.sessionId);
    await service.navigate(session.sessionId, page.pageId, { url: `http://127.0.0.1:${port}/` });
    await expect
      .poll(
        () =>
          lines.some((line) =>
            line.includes(`SCOPE_METHOD_DENIED PUT http://127.0.0.1:${port}/verify`)
          ),
        { timeout: 5000 }
      )
      .toBe(true);
    expect(putHits).toBe(0);
    await service.closeSession(session.sessionId);
    const files = await readdir(directory, { recursive: true });
    const ledger = await readFile(
      join(directory, files.find((file) => file.endsWith('.jsonl'))!),
      'utf8'
    );
    expect(ledger).toContain('SCOPE_METHOD_DENIED');
    expect(ledger).toContain('PUT');
  } finally {
    await service.shutdown();
    fixture.closeAllConnections();
    await new Promise<void>((resolve) => fixture.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
}, 30000);
