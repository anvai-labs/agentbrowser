import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { FirefoxBiDiEngine } from './index.js';

it('advertises the qualified subset and refuses policy-bearing sessions before launching', async () => {
  const launch = vi.fn();
  const engine = new FirefoxBiDiEngine({ executablePath: '/missing/firefox', launch });
  expect(await engine.capabilities()).toMatchObject({
    supportsCdp: false,
    supportsPdf: false,
    supportsAccessibilityTree: false,
    supportsDownloads: false,
    supportsUploads: false,
    supportedObservationModes: ['interactive', 'content'],
  });
  await expect(
    engine.createSession({ requestPolicy: { checkRequest: async () => {} } })
  ).rejects.toMatchObject({
    code: 'ENGINE_UNSUPPORTED',
    details: { reason: 'EGRESS_UNSUPPORTED' },
  });
  expect(launch).not.toHaveBeenCalled();
  await engine.close();
  await expect(engine.createSession({})).rejects.toMatchObject({ code: 'ENGINE_CRASHED' });
});

it('forces Firefox and BiDi, and closes a launch that finishes after engine shutdown', async () => {
  let finish!: (value: unknown) => void;
  const close = vi.fn().mockResolvedValue(undefined);
  const launch = vi.fn(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      })
  );
  const engine = new FirefoxBiDiEngine({
    executablePath: '/owned/firefox',
    launch: launch as never,
  });
  const pending = engine.createSession({});
  const rejected = expect(pending).rejects.toMatchObject({ code: 'ENGINE_CRASHED' });
  const closing = engine.close();
  finish({ close });
  await Promise.all([rejected, closing]);
  expect(close).toHaveBeenCalledOnce();
  expect(launch).toHaveBeenCalledWith(
    expect.objectContaining({
      browser: 'firefox',
      protocol: 'webDriverBiDi',
      executablePath: '/owned/firefox',
      headless: true,
    })
  );
  expect(launch.mock.calls[0]?.[0]).not.toHaveProperty('userDataDir');
});

// An explicit qualification command/CI sets this. Missing configured binaries fail, never skip.
describe.skipIf(!process.env.AGENTBROWSER_FIREFOX_EXECUTABLE)('native Firefox', () => {
  const effects: unknown[] = [];
  const fixture = createServer((req, res) => {
    if (req.url === '/effect') {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        effects.push(JSON.parse(body));
        res.end('ok');
      });
    } else {
      res.setHeader('Content-Type', 'text/html');
      res.end(`<!doctype html><title>Independent engine</title>
        <label>Note <input id="note"></label><label>Color <select id="color"><option>red</option><option>blue</option></select></label>
        <button id="save">Save</button><button id="replace">Replace Save</button>
        <script>save.onclick = e => fetch('/effect', {method:'POST',body:JSON.stringify({trusted:e.isTrusted,note:note.value,color:color.value})});
        replace.onclick = () => save.replaceWith(save.cloneNode(true));</script>`);
    }
  });
  const engine = new FirefoxBiDiEngine({
    executablePath: process.env.AGENTBROWSER_FIREFOX_EXECUTABLE!,
  });
  let url: string;
  beforeAll(async () => {
    await new Promise<void>((resolve) => fixture.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(fixture.address() as AddressInfo).port}/`;
  });
  afterAll(async () => {
    await engine.close();
    await new Promise<void>((resolve) => fixture.close(() => resolve()));
  });

  it('uses native input, observes semantic limits, preserves refs on URL reads and captures real PNG bytes', async () => {
    const session = await engine.createSession({});
    try {
      const page = await session.newPage();
      await page.navigate({ url });
      const initial = await page.observe({ mode: 'interactive' });
      expect(initial).toMatchObject({ degraded: true, degradedReason: 'dom-semantic-subset' });
      const note = initial.elements.find((e) => e.name === 'Note')!;
      expect(note.role).toBe('textbox');
      await page.getUrl!();
      await page.act({ type: 'fill', target: { ref: note.ref! }, value: 'from Firefox' });
      const after = await page.observe({ mode: 'interactive' });
      expect(after.elements.find((e) => e.name === 'Note')?.value).toBe('from Firefox');
      const color = after.elements.find((e) => e.name === 'Color')!;
      await page.act({ type: 'select', target: { ref: color.ref! }, values: ['blue'] });
      const fresh = await page.observe({ mode: 'interactive' });
      const save = fresh.elements.find((e) => e.name === 'Save')!;
      await page.act({ type: 'click', target: { ref: save.ref! } });
      await vi.waitFor(() =>
        expect(effects).toEqual([{ trusted: true, note: 'from Firefox', color: 'blue' }])
      );
      const shot = await page.screenshot({ maskSensitive: false });
      expect(Buffer.from(shot.bytesBase64, 'base64').subarray(0, 8).toString('hex')).toBe(
        '89504e470d0a1a0a'
      );
      await expect(page.act({ type: 'evaluate', expression: '1' })).rejects.toMatchObject({
        code: 'ENGINE_UNSUPPORTED',
      });
      await expect(page.observe({ mode: 'accessibility' })).rejects.toMatchObject({
        code: 'ENGINE_UNSUPPORTED',
      });
    } finally {
      await session.close();
    }
  });

  it('rejects replaced nodes and previous-document refs, and terminates event readers on close', async () => {
    const session = await engine.createSession({});
    const page = await session.newPage();
    await page.navigate({ url });
    const state = await page.observe({ mode: 'interactive' });
    const save = state.elements.find((e) => e.name === 'Save')!;
    const replace = state.elements.find((e) => e.name === 'Replace Save')!;
    await page.act({ type: 'click', target: { ref: replace.ref! } });
    await expect(page.act({ type: 'click', target: { ref: save.ref! } })).rejects.toMatchObject({
      code: 'STALE_TARGET',
    });
    await page.navigate({ url });
    await expect(page.resolve({ ref: replace.ref! })).rejects.toMatchObject({
      code: 'STALE_TARGET',
    });
    const events = page.events()[Symbol.asyncIterator]();
    await session.close();
    let next = await events.next();
    while (!next.done) next = await events.next();
    expect(next.done).toBe(true);
    expect(await session.pages()).toEqual([]);
  });

  it('does not let clipped evidence or hidden password values conceal a changed target', async () => {
    const session = await engine.createSession({});
    try {
      const page = await session.newPage();
      await page.navigate({ url });
      const native = (page as unknown as { page: import('puppeteer-core').Page }).page;
      await native.evaluate(() => {
        const input = document.querySelector('input')!;
        input.value = 'x'.repeat(2100);
      });
      const state = await page.observe({});
      const input = state.elements.find((e) => e.role === 'textbox')!;
      await native.evaluate(() => {
        document.querySelector('input')!.value += 'changed tail';
      });
      await expect(
        page.act({ type: 'fill', target: { ref: input.ref! }, value: 'overwrite' })
      ).rejects.toMatchObject({ code: 'STALE_TARGET' });
      await native.evaluate(() => {
        document.querySelector('input')!.type = 'password';
      });
      const password = (await page.observe({})).elements.find((e) => e.role === 'textbox')!;
      expect(password.value).toBeUndefined();
      await native.evaluate(() => {
        document.querySelector('input')!.value = 'human-secret';
      });
      await expect(
        page.act({ type: 'fill', target: { ref: password.ref! }, value: 'overwrite' })
      ).rejects.toMatchObject({ code: 'STALE_TARGET' });
      await expect(page.screenshot({})).rejects.toMatchObject({ code: 'ENGINE_UNSUPPORTED' });
    } finally {
      await session.close();
    }
  });

  it('round-trips seeded cookies and supports targeted keyboard input', async () => {
    const session = await engine.createSession({
      cookies: [
        {
          name: 'fixture',
          value: 'owned',
          domain: '127.0.0.1',
          path: '/',
          secure: false,
          httpOnly: true,
          sameSite: 'Lax',
        },
      ],
    });
    try {
      expect(await session.cookies()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'fixture', value: 'owned', httpOnly: true }),
        ])
      );
      const page = await session.newPage();
      await page.navigate({ url });
      const input = (await page.observe({})).elements.find((e) => e.role === 'textbox')!;
      await page.act({ type: 'press', target: { ref: input.ref! }, key: 'a' });
      expect((await page.observe({})).elements.find((e) => e.role === 'textbox')?.value).toBe('a');
    } finally {
      await session.close();
    }
  });
});
