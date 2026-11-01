// ADR-031: public service actions only; the receiver independently verifies the write.
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PlaywrightChromiumEngine } from '@agentbrowser/engine-playwright';
import { NetworkPolicy } from '@agentbrowser/policy';
import { expect, it, vi } from 'vitest';
import { AgentBrowserService, type ServiceActRequest } from './service.js';

it('searches/selects a VRT option, attaches verified bytes and submits one closed-shadow form through approved public actions', async () => {
  const submissions: string[] = [];
  const deniedHits: string[] = [];
  const html = `<!doctype html><link rel=icon href="data:,"><closed-draft></closed-draft><script>
 const root=document.querySelector('closed-draft').attachShadow({mode:'closed'});
 root.innerHTML=\`<style>button,input{position:absolute;left:20px;width:260px;height:32px;box-sizing:border-box}#change{top:20px}#search{top:70px}#choose{top:120px}#file{top:170px}#submit{top:220px}#deny{top:270px}#host{top:320px}</style>
 <form><button id=change type=button>Change VRT</button><input hidden id=search name=search><button hidden id=choose type=button>Authorization</button><input id=file name=proof type=file><input name=category type=hidden><button id=submit>Submit</button><button id=deny type=button>Blocked method</button><button id=host type=button>Blocked host</button></form>\`;
 const q=s=>root.querySelector(s);
 q('#change').onclick=()=>{q('#search').hidden=false};
 q('#search').oninput=()=>{q('#choose').hidden=q('#search').value!=='authorization'};
 q('#choose').onclick=()=>{q('[name=category]').value='authorization';q('#choose').textContent='Selected Authorization'};
 q('#deny').onclick=()=>fetch('/denied',{method:'PUT'}).catch(()=>{});
 q('#host').onclick=()=>fetch(location.href.replace('127.0.0.1','localhost')+'denied').catch(()=>{});
 q('form').onsubmit=async e=>{e.preventDefault();await fetch('/submit',{method:'POST',body:new FormData(q('form'))});q('#submit').textContent='Submitted'};
 </script>`;
  const fixture = createServer((req, res) => {
    if (req.url === '/submit' && req.method === 'POST') {
      const chunks: Buffer[] = [];
      req.on('data', (b) => chunks.push(b));
      req.on('end', () => {
        submissions.push(Buffer.concat(chunks).toString());
        res.end('saved');
      });
      return;
    }
    if (req.url?.includes('denied')) deniedHits.push(req.method ?? '');
    res.setHeader('content-type', 'text/html');
    res.end(html);
  });
  await new Promise<void>((ok, bad) => {
    fixture.once('error', bad);
    fixture.listen(0, '127.0.0.1', ok);
  });
  const port = (fixture.address() as { port: number }).port;
  const directory = await mkdtemp(join(tmpdir(), 'coordinate-flow-'));
  const proof = Buffer.from('owned-coordinate-proof-8ad7');
  const file = join(directory, 'proof.txt');
  await writeFile(file, proof, { mode: 0o600 });
  const service = new AgentBrowserService({
    engine: new PlaywrightChromiumEngine(),
    networkPolicy: new NetworkPolicy({ blockLoopback: false }),
    engagement: { directory },
    approvalPolicy: { unknownRisk: 'allow' },
  });
  try {
    const session = await service.createSession({
      tenantId: 'coordinate-owner',
      scope: {
        allowedHosts: ['127.0.0.1'],
        allowedMethods: ['GET', 'HEAD', 'POST'],
        requestBudget: 100,
        ledger: true,
      },
    });
    const { sessionId } = session;
    const { pageId } = await service.createPage(sessionId);
    await service.navigate(sessionId, pageId, { url: `http://127.0.0.1:${port}/` });
    const observation = await service.observe(sessionId, pageId, {});
    expect(observation.interactionHint).toContain('Closed shadow roots');
    expect((await service.getSnapshot(sessionId, pageId)).interactionHint).toContain(
      'Closed shadow roots'
    );
    async function approved(request: ServiceActRequest) {
      const refused = await service.act(sessionId, pageId, request).catch((error) => error);
      expect(refused).toMatchObject({ code: 'APPROVAL_REQUIRED' });
      return service.act(sessionId, pageId, { ...request, approvalToken: refused.details.tokenId });
    }
    async function click(x: number, y: number) {
      const image = await service.screenshot(sessionId, pageId, {});
      const c = image.coordinates!;
      expect(c.kind).toBe('viewport-png');
      const at = {
        unit: 'image' as const,
        x: (x * c.rasterWidth) / c.cssWidth,
        y: (y * c.rasterHeight) / c.cssHeight,
        captureId: c.captureId,
        rasterWidth: c.rasterWidth,
        rasterHeight: c.rasterHeight,
      };
      return approved({ action: 'clickAt', at });
    }
    await click(50, 35);
    await click(50, 85);
    await service.act(sessionId, pageId, { action: 'typeText', value: 'authorization' });
    await click(50, 135);
    const selected = await service.screenshot(sessionId, pageId, {});
    expect(selected.sizeBytes).toBeGreaterThan(0);
    const upload = await approved({
      action: 'uploadAt',
      at: { unit: 'css', x: 50, y: 185 },
      paths: [file],
      sha256: createHash('sha256').update(proof).digest('hex'),
    });
    expect((upload as { result?: unknown }).result).toMatchObject({ inputBackendVerified: true });
    await click(50, 235);
    await vi.waitFor(() => expect(submissions).toHaveLength(1), { timeout: 5000 });
    expect(submissions[0]).toContain('authorization');
    expect(submissions[0]).toContain('filename="proof.txt"');
    expect(submissions[0]).toContain(proof.toString());
    await click(50, 285);
    await click(50, 335);
    await vi.waitFor(() =>
      expect(service.getScopeStatus(sessionId).denials).toMatchObject({
        SCOPE_METHOD_DENIED: 1,
        SCOPE_HOST_DENIED: 1,
      })
    );
    expect(deniedHits).toHaveLength(0);
    expect(submissions).toHaveLength(1);
    const engagementId = session.engagementId!;
    await service.closeSession(sessionId);
    const exported = await service.engagementLedgerFile('coordinate-owner', engagementId);
    const ledger = await readFile(exported.path, 'utf8');
    expect(ledger).toContain('SCOPE_METHOD_DENIED');
    expect(ledger).toContain('SCOPE_HOST_DENIED');
  } finally {
    await service.shutdown();
    await new Promise<void>((ok) => fixture.close(() => ok()));
    await rm(directory, { recursive: true, force: true });
  }
}, 90000);

it.each(['budget', 'rate'])(
  'keeps %s denials enforced and sealed in the ledger after approved coordinate input',
  async (limit) => {
    let hits = 0;
    const fixture = createServer((req, res) => {
      if (req.url === '/probe') hits++;
      res.setHeader('content-type', 'text/html');
      res.end(
        '<link rel=icon href="data:,"><button style="position:absolute;left:10px;top:10px;width:100px;height:40px" onclick="fetch(\'/probe\').catch(()=>{});this.textContent=\'Dispatched\'">Probe</button>'
      );
    });
    await new Promise<void>((ok, bad) => {
      fixture.once('error', bad);
      fixture.listen(0, '127.0.0.1', ok);
    });
    const port = (fixture.address() as { port: number }).port;
    const directory = await mkdtemp(join(tmpdir(), 'coordinate-denials-'));
    const service = new AgentBrowserService({
      engine: new PlaywrightChromiumEngine(),
      networkPolicy: new NetworkPolicy({ blockLoopback: false }),
      engagement: { directory },
      approvalPolicy: { unknownRisk: 'allow' },
    });
    try {
      const session = await service.createSession({
        tenantId: 'owner',
        scope: {
          allowedHosts: ['127.0.0.1'],
          requestBudget: limit === 'budget' ? 1 : 100,
          ...(limit === 'rate' ? { rateLimit: { requests: 1, perSeconds: 60 } } : {}),
          ledger: true,
        },
      });
      const { sessionId } = session;
      const { pageId } = await service.createPage(sessionId);
      await service.navigate(sessionId, pageId, { url: `http://127.0.0.1:${port}/` });
      const action = { action: 'clickAt', at: { unit: 'css', x: 50, y: 30 } } as const;
      const refused = await service.act(sessionId, pageId, action).catch((e) => e);
      expect(refused).toMatchObject({ code: 'APPROVAL_REQUIRED' });
      await service.act(sessionId, pageId, { ...action, approvalToken: refused.details.tokenId });
      const code = limit === 'budget' ? 'SCOPE_BUDGET_EXHAUSTED' : 'SCOPE_RATE_LIMITED';
      await vi.waitFor(() => expect(service.getScopeStatus(sessionId).denials[code]).toBe(1));
      expect(hits).toBe(0);
      await service.closeSession(sessionId);
      const exported = await service.engagementLedgerFile('owner', session.engagementId!);
      expect(await readFile(exported.path, 'utf8')).toContain(code);
    } finally {
      await service.shutdown();
      fixture.closeAllConnections();
      await new Promise<void>((ok) => fixture.close(() => ok()));
      await rm(directory, { recursive: true, force: true });
    }
  },
  30000
);
