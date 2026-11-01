import { createServer } from 'node:http';
import { PlaywrightChromiumEngine } from '@agentbrowser/engine-playwright';
import { NetworkPolicy } from '@agentbrowser/policy';
import type { Page } from 'playwright';
import { expect, it, vi } from 'vitest';
import { journalConfigFromEnvironment, openServiceJournal } from './journal-config.js';
import { AgentBrowserService } from './service.js';
import { journalTree } from './test-support/journal-fixture.js';

it('seals a revoked coordinate dispatch as unknown and refuses replay after a new grant', async () => {
  const fixture = createServer((_req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end(
      '<link rel=icon href="data:,"><button style="position:absolute;left:10px;top:10px;width:100px;height:40px" onclick="document.title=String(Number(document.title||0)+1);this.style.background=\'red\'">Submit</button>'
    );
  });
  await new Promise<void>((resolve, reject) => {
    fixture.once('error', reject);
    fixture.listen(0, '127.0.0.1', resolve);
  });
  const port = (fixture.address() as { port: number }).port;
  const tree = journalTree('coordinate-control-', 'a1');
  const config = await journalConfigFromEnvironment(tree.env);
  if (!config) throw new Error('Expected journal configuration');
  const opened = await openServiceJournal(config);
  const service = new AgentBrowserService({
    engine: new PlaywrightChromiumEngine(),
    networkPolicy: new NetworkPolicy({ blockLoopback: false }),
    operationJournal: opened.journal,
    approvalPolicy: { unknownRisk: 'allow' },
  });
  let finish: (() => void) | undefined;
  try {
    const { sessionId } = await service.createSession({
      tenantId: 'owner',
      controlMode: 'delegated',
    });
    const operator = <T>(work: () => Promise<T>) =>
      service.authority.run(sessionId, { actor: 'operator', tenant: 'owner' }, {}, work);
    const { pageId } = await operator(() => service.createPage(sessionId));
    await operator(() =>
      service.navigate(sessionId, pageId, {
        url: `http://127.0.0.1:${port}/`,
      })
    );
    const native = await operator(async () =>
      (
        service as unknown as {
          requirePage(s: string, p: string): { enginePage: { backingPage(): Page } };
        }
      )
        .requirePage(sessionId, pageId)
        .enginePage.backingPage()
    );
    const delegate = () => {
      const review = service.authority.get(sessionId)!.prepareResume();
      const grant = service.authority.delegate(sessionId, review.epoch, 'qa');
      return service.authority.authenticate(grant.token)!;
    };
    let agent = delegate();
    const run = <T>(id: string, work: () => Promise<T>, durable = false) =>
      service.authority.run(
        sessionId,
        agent,
        {
          id,
          fingerprint: `coordinate-${id}`,
          ...(durable
            ? {
                journal: {
                  version: 1 as const,
                  application: {
                    adapterId: 'browser',
                    resourceId: 'act',
                    bindingGeneration: pageId,
                  },
                  durable: true,
                  browser: true,
                },
              }
            : {}),
        },
        work
      );
    const request = { action: 'clickAt', at: { unit: 'css', x: 50, y: 30 } } as const;
    const refused = await run('approval', () => service.act(sessionId, pageId, request)).catch(
      (e) => e
    );
    expect(refused).toMatchObject({ code: 'APPROVAL_REQUIRED' });
    const approved = { ...request, approvalToken: refused.details.tokenId };
    const click = native.mouse.click.bind(native.mouse);
    const entered = vi.fn();
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const spy = vi.spyOn(native.mouse, 'click').mockImplementation(async (x, y, options) => {
      await click(x, y, options);
      entered();
      await pending;
    });
    const operation = run(
      'submit-once',
      () => service.act(sessionId, pageId, approved),
      true
    ).catch((e) => e);
    await vi.waitFor(() => expect(entered).toHaveBeenCalledOnce(), { timeout: 5000 });
    service.authority.takeover(sessionId);
    expect(await operation).toMatchObject({ code: 'CONTROL_REVOKED' });
    expect(await native.title()).toBe('1');
    const found = await opened.journal.findByOperation({
      tenantId: 'owner',
      operationId: 'submit-once',
      limit: 8,
    });
    expect(found.kind).toBe('found');
    if (found.kind === 'found') {
      expect(found.records).toHaveLength(1);
      expect(found.records[0]).toMatchObject({
        dispatched: true,
        terminal: { status: 'outcome_unknown' },
      });
    }
    finish!();
    spy.mockRestore();
    agent = delegate();
    await run('submit-once', () => service.act(sessionId, pageId, approved), true).catch(
      () => undefined
    );
    // The completed receiver mutation remains exactly once across takeover/regrant/retry.
    expect(await native.title()).toBe('1');
    await expect(
      run('old-approval', () => service.act(sessionId, pageId, approved))
    ).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' });
    expect(await native.title()).toBe('1');
  } finally {
    finish?.();
    await service.shutdown();
    await opened.close();
    fixture.closeAllConnections();
    await new Promise<void>((resolve) => fixture.close(() => resolve()));
    tree.dispose();
  }
}, 60000);
