// T10 M5: wire qualification, local fixtures only.
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyEngagementLedger } from '@agentbrowser/core';
import { PlaywrightChromiumEngine } from '@agentbrowser/engine-playwright';
import { NetworkPolicy } from '@agentbrowser/policy';
import { expect, it, vi } from 'vitest';
import { AgentBrowserService } from './service.js';

it.each([307, 303])(
  'injects every matching request, strips GET/POST %s redirect markers and records evidence plus UA',
  async (redirectStatus) => {
    const hits: Array<{
      path: string;
      host?: string;
      marker?: string;
      ua?: string;
      cookie?: string;
      authorization?: string;
    }> = [];
    let port = 0;
    const fixture = createServer((req, res) => {
      const path = req.url ?? '/';
      hits.push({
        path,
        host: req.headers.host,
        marker: req.headers['x-hackerone-research'] as string,
        ua: req.headers['user-agent'],
        cookie: req.headers.cookie,
        authorization: req.headers.authorization,
      });
      res.setHeader('access-control-allow-origin', '*');
      if (path === '/round-hop' || path === '/round-mid') {
        res.writeHead(redirectStatus, {
          location:
            path === '/round-hop'
              ? `http://localhost:${port}/round-mid`
              : `http://127.0.0.1:${port}/round-terminal`,
        });
        res.end();
        return;
      }
      if (path.endsWith('-hop')) {
        const target = path.includes('-back-') ? '127.0.0.1' : 'localhost';
        res.writeHead(redirectStatus, {
          location: `http://${target}:${port}${path.replace('-hop', '-terminal')}`,
        });
        res.end();
        return;
      }
      if (path === '/post-driver' || path === '/post-back-driver') {
        res.setHeader('content-type', 'text/html');
        res.end(
          `<form id=post method=post action=${path === '/post-driver' ? '/post-hop' : '/post-back-hop'}><input name=data value=test></form><script>document.getElementById("post").submit()</script>`
        );
        return;
      }
      if (path === '/driver') {
        res.setHeader('content-type', 'text/html');
        res.end(`<link rel="icon" href="data:,"><script src="/chunk.js"></script><iframe src="/frame"></iframe><script>
        fetch('/get-hop', { headers: { Authorization: 'Bearer source-only' } }).catch(()=>{});
        fetch('/round-hop', { headers: { Authorization: 'Bearer source-only' } }).catch(()=>{});
      </script>`);
        return;
      }
      res.end(path === '/chunk.js' ? 'window.loaded = true;' : 'ok');
    });
    await new Promise<void>((resolve, reject) => {
      fixture.once('error', reject);
      fixture.listen(0, '127.0.0.1', resolve);
    });
    port = (fixture.address() as { port: number }).port;
    const directory = await mkdtemp(join(tmpdir(), 'research-identity-'));
    const engine = new PlaywrightChromiumEngine();
    const service = new AgentBrowserService({
      engine,
      networkPolicy: new NetworkPolicy({ blockLoopback: false }),
      engagement: { directory },
    });
    try {
      const session = await service.createSession({
        tenantId: 'research',
        userAgent: 'ResearchBrowser researcher',
        cookies: [
          { name: 'private', value: 'source-only', domain: '127.0.0.1', path: '/' },
          { name: 'destination', value: 'destination-only', domain: 'localhost', path: '/' },
        ],
        scope: {
          allowedHosts: ['127.0.0.1', 'localhost'],
          ledger: true,
          requestHeaders: [
            { header: 'X-HackerOne-Research', value: 'researcher', hostSuffix: '127.0.0.1' },
          ],
          identityBindings: [
            { header: 'X-HackerOne-Research', value: 'researcher', allowedHosts: ['127.0.0.1'] },
          ],
        },
      });
      expect(service.getSession(session.sessionId)?.userAgent).toBe('ResearchBrowser researcher');
      const page = await service.createPage(session.sessionId);
      expect(
        (
          await service.navigate(session.sessionId, page.pageId, {
            url: `http://127.0.0.1:${port}/driver`,
          })
        ).status
      ).toBe('success');
      const postPage = await service.createPage(session.sessionId);
      await service
        .navigate(session.sessionId, postPage.pageId, {
          url: `http://127.0.0.1:${port}/post-driver`,
        })
        .catch(() => {});
      const backPage = await service.createPage(session.sessionId);
      await service
        .navigate(session.sessionId, backPage.pageId, {
          url: `http://localhost:${port}/post-back-driver`,
        })
        .catch(() => {});
      await vi.waitFor(
        () => {
          for (const path of [
            '/driver',
            '/chunk.js',
            '/frame',
            '/get-hop',
            '/post-hop',
            '/get-terminal',
            '/post-terminal',
            '/post-back-terminal',
            '/round-terminal',
          ])
            expect(
              hits.map((hit) => `${hit.host}${hit.path}`),
              `missing ${path}`
            ).toEqual(expect.arrayContaining([expect.stringContaining(path)]));
        },
        { timeout: 10_000 }
      );
      for (const hit of hits) {
        expect(hit.marker).toBe(hit.host?.startsWith('127.0.0.1:') ? 'researcher' : undefined);
        expect(hit.ua).toBe('ResearchBrowser researcher');
      }
      const firstHop = hits.find((hit) => hit.path === '/get-hop')!;
      expect(firstHop.cookie).toContain('private=source-only');
      expect(firstHop.authorization).toBe('Bearer source-only');
      const crossHost = hits.find((hit) => hit.path === '/get-terminal')!;
      expect(crossHost.cookie).toBe('destination=destination-only');
      expect(crossHost.authorization).toBeUndefined();
      const returned = hits.find((hit) => hit.path === '/round-terminal')!;
      expect(returned.cookie).toBe('private=source-only');
      expect(returned.authorization).toBeUndefined();
      const config = service.getScopeStatus(session.sessionId).requestHeaders;
      expect(config).toEqual([
        {
          header: 'x-hackerone-research',
          hostSuffix: '127.0.0.1',
          valueSha256: createHash('sha256').update('researcher').digest('hex'),
        },
      ]);
      await service.closeSession(session.sessionId);
      const file = await service.engagementLedgerFile('research', session.engagementId!);
      const ledger = await readFile(file.path, 'utf8');
      expect(verifyEngagementLedger(ledger)).toMatchObject({ ok: true, closed: true });
      const records = ledger
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(records[0].data).toMatchObject({
        userAgent: 'ResearchBrowser researcher',
        scope: { requestHeaders: config },
      });
      const injections = records.filter((record) => record.type === 'request.headersInjected');
      expect(injections.length).toBeGreaterThanOrEqual(5);
      expect(injections.every((record) => record.data.hostname === '127.0.0.1')).toBe(true);
      expect(injections[0].data.headers).toEqual(['x-hackerone-research']);
      expect(JSON.stringify(injections)).not.toContain('"researcher"');
    } finally {
      await service.shutdown();
      await engine.close();
      fixture.closeAllConnections();
      await new Promise<void>((resolve) => fixture.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  },
  30_000
);
