import { expect, it, vi } from 'vitest';
import { PlaywrightChromiumEngine } from './index.js';
import { backingPage } from './test-support/backing-page.js';

it('preserves ordinary observe/capture with no new coordinate CDP work when an adapter opts out', async () => {
  const engine = new PlaywrightChromiumEngine({ coordinateInput: false });
  try {
    const page = await (await engine.createSession({ headless: true })).newPage();
    const native = backingPage(page);
    await native.setContent('<title>Opt-out</title><button>Ready</button>');
    const context = native.context();
    const attach = context.newCDPSession.bind(context);
    const commands: string[] = [];
    vi.spyOn(context, 'newCDPSession').mockImplementation(async (target) => {
      const session = await attach(target);
      const send = session.send.bind(session);
      vi.spyOn(session, 'send').mockImplementation((method, params) => {
        commands.push(method);
        return send(method, params);
      });
      return session;
    });
    const click = vi.spyOn(native.mouse, 'click');
    const view = await page.observe({});
    expect(view.title).toBe('Opt-out');
    expect(view.interactionHint).toBeUndefined();
    const image = await page.screenshot({ format: 'png' });
    expect(image.sizeBytes).toBeGreaterThan(0);
    expect(image.bytesBase64).toBeTruthy();
    expect(image.coordinates).toBeUndefined();
    for (const method of ['Page.getFrameTree', 'Page.getLayoutMetrics', 'Page.createIsolatedWorld'])
      expect(commands).not.toContain(method);
    const before = commands.length;
    const action = { type: 'clickAt' as const, at: { unit: 'css', x: 10, y: 10 } };
    await expect(page.prepareCoordinate!(action)).rejects.toMatchObject({
      code: 'ENGINE_UNSUPPORTED',
    });
    await expect(page.act(action)).rejects.toMatchObject({ code: 'ENGINE_UNSUPPORTED' });
    expect(click).not.toHaveBeenCalled();
    expect(commands).toHaveLength(before);
  } finally {
    await engine.close();
  }
}, 30000);
