import { expect, it, vi } from 'vitest';
import { backingPage } from './test-support/backing-page.js';
import { withPage } from './test-support/engine-page.js';

it.each(['action', 'navigation'])(
  'counts overlapping ordinary %s inputs before their first await, excluding coordinates until all settle',
  async (kind) => {
    await withPage('<button>Ready</button>', async (page) => {
      const native = backingPage(page);
      const finishes: Array<() => void> = [];
      const hold = () =>
        new Promise<void>((resolve) => {
          finishes.push(resolve);
        });
      const entered = vi.fn();
      const spy =
        kind === 'action'
          ? vi.spyOn(native.keyboard, 'press').mockImplementation(async () => {
              entered();
              await hold();
            })
          : vi.spyOn(native, 'goto').mockImplementation(async () => {
              entered();
              await hold();
              return null;
            });
      const operation =
        kind === 'action'
          ? page.act({ type: 'press', key: 'Escape' })
          : page.navigate({ url: 'data:text/html,second' });
      let second: Promise<unknown> | undefined;
      try {
        await vi.waitFor(() => expect(entered).toHaveBeenCalledOnce());
        second =
          kind === 'action'
            ? page.act({ type: 'press', key: 'Escape' })
            : page.navigate({ url: 'data:text/html,third' });
        await vi.waitFor(() => expect(entered).toHaveBeenCalledTimes(2));
        await expect(
          page.prepareCoordinate!({ type: 'clickAt', at: { unit: 'css', x: 10, y: 10 } })
        ).rejects.toMatchObject({ code: 'SESSION_BUSY' });
        finishes[0]!();
        await operation;
        await expect(
          page.prepareCoordinate!({ type: 'clickAt', at: { unit: 'css', x: 10, y: 10 } })
        ).rejects.toMatchObject({ code: 'SESSION_BUSY' });
      } finally {
        for (const finish of finishes) finish();
        await operation;
        await second;
        spy.mockRestore();
      }
      const prepared = await page.prepareCoordinate!({
        type: 'clickAt',
        at: { unit: 'css', x: 10, y: 10 },
      });
      try {
        await expect(page.act({ type: 'press', key: 'Escape' })).rejects.toMatchObject({
          code: 'SESSION_BUSY',
        });
        await expect(page.navigate({ url: 'data:text/html,conflict' })).rejects.toMatchObject({
          code: 'SESSION_BUSY',
        });
      } finally {
        prepared.dispose();
      }
    });
  },
  30000
);

it('recovers coordinate capture and preparation after disclosure CDP reset, while invalidating old evidence', async () => {
  await withPage('<button>Ready</button>', async (page) => {
    const first = await page.screenshot({});
    expect(first.coordinates?.captureId).toBeTruthy();
    // Exercise the same recoverable reset used after a disclosure CDP scan error.
    (page as unknown as { closeDisclosureCdp(): void }).closeDisclosureCdp();
    const second = await page.screenshot({});
    expect(second.coordinates?.captureId).toBeTruthy();
    expect(second.coordinates?.captureId).not.toBe(first.coordinates?.captureId);
    await expect(
      page.prepareCoordinate!({
        type: 'clickAt',
        at: {
          unit: 'image',
          x: 10,
          y: 10,
          captureId: first.coordinates!.captureId,
          rasterWidth: first.coordinates!.rasterWidth,
          rasterHeight: first.coordinates!.rasterHeight,
        },
      })
    ).rejects.toMatchObject({ code: 'STALE_TARGET' });
    const prepared = await page.prepareCoordinate!({
      type: 'clickAt',
      at: { unit: 'css', x: 10, y: 10 },
    });
    prepared.dispose();
  });
}, 30000);
