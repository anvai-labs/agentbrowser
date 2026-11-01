import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EngineError } from '@agentbrowser/engine';
import type { CDPSession, Page } from 'playwright';
import { expect, it, vi } from 'vitest';
import { CoordinateController } from './coordinate-input.js';

function fixture() {
  const state = {
    scroll: 0,
    loaderId: 'loader',
    url: 'https://fixture.test/',
    width: 800,
    zoom: 1,
    scale: 1,
    offsetX: 0,
  };
  const png = Buffer.alloc(25);
  png.write('PNG', 1);
  png.writeUInt32BE(1600, 16);
  png.writeUInt32BE(1200, 20);
  const send = vi.fn(async (method: string, params?: Record<string, unknown>) => {
    if (method === 'Page.getFrameTree')
      return { frameTree: { frame: { id: 'frame', loaderId: state.loaderId, url: state.url } } };
    if (method === 'Page.getLayoutMetrics')
      return {
        cssLayoutViewport: {
          clientWidth: state.width,
          clientHeight: 600,
          pageX: 0,
          pageY: state.scroll,
        },
        cssVisualViewport: {
          clientWidth: state.width,
          clientHeight: 600,
          offsetX: state.offsetX,
          offsetY: 0,
          scale: state.scale,
          zoom: state.zoom,
        },
      };
    if (method === 'Page.createIsolatedWorld') return { executionContextId: 1 };
    if (method === 'Runtime.evaluate')
      return { result: { value: { devicePixelRatio: 2, width: state.width, height: 600 } } };
    if (method === 'DOM.getNodeForLocation') return { frameId: 'frame', backendNodeId: 10 };
    if (method === 'DOM.describeNode')
      return { node: { nodeName: 'INPUT', backendNodeId: 10, attributes: ['type', 'file'] } };
    if (method === 'DOM.resolveNode')
      return { object: { objectId: `node-${params?.backendNodeId}` } };
    if (method === 'Runtime.callFunctionOn') return { result: { value: { applied: true } } };
    return {};
  });
  const cdpEvents = Object.assign(new EventEmitter(), { send });
  const cdp = cdpEvents as unknown as CDPSession;
  const mouse = { click: vi.fn(async () => {}) };
  const pageEvents = new EventEmitter();
  const page = Object.assign(pageEvents, {
    screenshot: vi.fn(async () => png),
    mouse,
    viewportSize: vi.fn(() => ({ width: state.width, height: 600 })),
    isClosed: () => false,
  }) as unknown as Page;
  return {
    controller: new CoordinateController(page, async () => cdp),
    page,
    pageEvents,
    cdpEvents,
    send,
    mouse,
    state,
    png,
    scroll: () => {
      state.scroll++;
    },
  };
}
it('refuses foreign/expired capture IDs and changed scroll before any mouse input', async () => {
  const f = fixture();
  try {
    await expect(
      f.controller.prepare({
        type: 'clickAt',
        at: {
          unit: 'image',
          x: 20,
          y: 20,
          captureId: 'foreign',
          rasterWidth: 1600,
          rasterHeight: 1200,
        },
      })
    ).rejects.toMatchObject({ code: 'STALE_TARGET' });
    const capture = await f.controller.capture();
    f.scroll();
    await expect(
      f.controller.prepare({
        type: 'clickAt',
        at: {
          unit: 'image',
          x: 20,
          y: 20,
          captureId: capture.coordinates.captureId,
          rasterWidth: 1600,
          rasterHeight: 1200,
        },
      })
    ).rejects.toMatchObject({ code: 'STALE_TARGET' });
    expect(f.mouse.click).not.toHaveBeenCalled();
  } finally {
    f.controller.close();
  }
});
it('holds one page preparation and refuses revoked input without replay', async () => {
  const f = fixture();
  try {
    const prepared = await f.controller.prepare({
      type: 'clickAt',
      at: { unit: 'css', x: 10, y: 10 },
    });
    await expect(
      f.controller.prepare({ type: 'clickAt', at: { unit: 'css', x: 10, y: 10 } })
    ).rejects.toBeDefined();
    await expect(
      f.controller.perform(
        prepared.token,
        () => {
          throw new Error('revoked');
        },
        async () => {}
      )
    ).rejects.toThrow('revoked');
    expect(f.mouse.click).not.toHaveBeenCalled();
    prepared.dispose();
    const next = await f.controller.prepare({ type: 'clickAt', at: { unit: 'css', x: 10, y: 10 } });
    next.dispose();
  } finally {
    f.controller.close();
  }
});
it.each(['loaderId', 'url', 'width', 'pixels'])(
  'refuses capture evidence after %s changes',
  async (field) => {
    const f = fixture();
    try {
      const capture = await f.controller.capture();
      if (field === 'loaderId') f.state.loaderId = 'same-url-reloaded';
      if (field === 'url') f.state.url = 'https://fixture.test/second';
      if (field === 'width') f.state.width = 700;
      if (field === 'pixels') f.png[24] = 1;
      await expect(
        f.controller.prepare({
          type: 'clickAt',
          at: {
            unit: 'image',
            x: 20,
            y: 20,
            captureId: capture.coordinates.captureId,
            rasterWidth: 1600,
            rasterHeight: 1200,
          },
        })
      ).rejects.toMatchObject({ code: 'STALE_TARGET' });
      expect(f.mouse.click).not.toHaveBeenCalled();
    } finally {
      f.controller.close();
    }
  }
);
it('expires capture authority using monotonic time', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  const f = fixture();
  try {
    const capture = await f.controller.capture();
    await vi.advanceTimersByTimeAsync(60001);
    await expect(
      f.controller.prepare({
        type: 'clickAt',
        at: {
          unit: 'image',
          x: 20,
          y: 20,
          captureId: capture.coordinates.captureId,
          rasterWidth: 1600,
          rasterHeight: 1200,
        },
      })
    ).rejects.toMatchObject({ code: 'STALE_TARGET' });
    expect(f.mouse.click).not.toHaveBeenCalled();
  } finally {
    f.controller.close();
    vi.useRealTimers();
  }
});
it('evicts the oldest capture after four retained images', async () => {
  const f = fixture();
  try {
    const first = await f.controller.capture();
    for (let i = 0; i < 4; i++) await f.controller.capture();
    await expect(
      f.controller.prepare({
        type: 'clickAt',
        at: {
          unit: 'image',
          x: 20,
          y: 20,
          captureId: first.coordinates.captureId,
          rasterWidth: 1600,
          rasterHeight: 1200,
        },
      })
    ).rejects.toMatchObject({ code: 'STALE_TARGET' });
    expect(f.mouse.click).not.toHaveBeenCalled();
  } finally {
    f.controller.close();
  }
});
it.each(['zoom', 'scale', 'offsetX'])('refuses unqualified %s before input', async (field) => {
  const f = fixture();
  try {
    f.state[field as 'zoom' | 'scale' | 'offsetX'] = 1.25;
    await expect(
      f.controller.prepare({ type: 'clickAt', at: { unit: 'css', x: 10, y: 10 } })
    ).rejects.toMatchObject({ code: 'ENGINE_UNSUPPORTED' });
    expect(f.mouse.click).not.toHaveBeenCalled();
  } finally {
    f.controller.close();
  }
});
it('refuses a native viewport that disagrees with the configured screenshot clip', async () => {
  const f = fixture();
  try {
    vi.spyOn(f.page, 'viewportSize').mockReturnValue({ width: 801, height: 600 });
    await expect(f.controller.capture()).rejects.toMatchObject({ code: 'ENGINE_UNSUPPORTED' });
    await expect(
      f.controller.prepare({ type: 'clickAt', at: { unit: 'css', x: 10, y: 10 } })
    ).rejects.toMatchObject({ code: 'ENGINE_UNSUPPORTED' });
    expect(f.mouse.click).not.toHaveBeenCalled();
  } finally {
    f.controller.close();
  }
});
it('checks authority again after asynchronous approval, before the sole mouse dispatch', async () => {
  const f = fixture();
  let current = true;
  let commit!: () => void;
  const pending = new Promise<void>((resolve) => {
    commit = resolve;
  });
  const beforeDispatch = vi.fn(() => pending);
  const prepared = await f.controller.prepare({
    type: 'clickAt',
    at: { unit: 'css', x: 10, y: 10 },
  });
  const operation = f.controller.perform(
    prepared.token,
    () => {
      if (!current) throw new Error('revoked during approval');
    },
    beforeDispatch
  );
  await vi.waitFor(() => expect(beforeDispatch).toHaveBeenCalledOnce());
  expect(f.mouse.click).not.toHaveBeenCalled();
  current = false;
  commit();
  await expect(operation).rejects.toThrow('revoked during approval');
  expect(f.mouse.click).not.toHaveBeenCalled();
  f.controller.close();
});
it.each(['approval', 'cdp'])(
  'cancels an unresolved %s read when the prepared owner aborts',
  async (stage) => {
    const f = fixture();
    const owner = new AbortController();
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const assertCurrent = () => {
      if (owner.signal.aborted) throw new Error('owner revoked');
    };
    try {
      const prepared = await f.controller.prepare(
        { type: 'clickAt', at: { unit: 'css', x: 10, y: 10 } },
        { signal: owner.signal, assertCurrent }
      );
      const originalSend = f.send.getMockImplementation()!;
      const blockedRead = vi.fn();
      if (stage === 'cdp') {
        f.send.mockImplementation(async (method, params) => {
          if (method === 'Page.getFrameTree') {
            blockedRead();
            await pending;
          }
          return originalSend(method, params);
        });
      }
      const beforeDispatch = vi.fn(() => pending);
      const outcome = f.controller
        .perform(prepared.token, assertCurrent, beforeDispatch)
        .catch((e) => e);
      if (stage === 'approval')
        await vi.waitFor(() => expect(beforeDispatch).toHaveBeenCalledOnce());
      else await vi.waitFor(() => expect(blockedRead).toHaveBeenCalledOnce());
      owner.abort();
      await vi.waitFor(() => expect(f.controller.busy).toBe(false), { timeout: 500 });
      await expect(outcome).resolves.toMatchObject({ message: 'owner revoked' });
      expect(f.controller.busy).toBe(false);
      finish();
      await Promise.resolve();
      expect(f.mouse.click).not.toHaveBeenCalled();
    } finally {
      finish();
      f.controller.close();
    }
  }
);
it('keeps an invalidated in-flight gesture exclusive until it settles and never dispatches late', async () => {
  const f = fixture();
  let commit!: () => void;
  const pending = new Promise<void>((resolve) => {
    commit = resolve;
  });
  const beforeDispatch = vi.fn(() => pending);
  const prepared = await f.controller.prepare({
    type: 'clickAt',
    at: { unit: 'css', x: 10, y: 10 },
  });
  const operation = f.controller.perform(prepared.token, () => {}, beforeDispatch);
  await vi.waitFor(() => expect(beforeDispatch).toHaveBeenCalledOnce());
  prepared.dispose();
  expect(f.controller.busy).toBe(true);
  await expect(
    f.controller.prepare({ type: 'clickAt', at: { unit: 'css', x: 20, y: 20 } })
  ).rejects.toMatchObject({ code: 'SESSION_BUSY' });
  commit();
  await expect(operation).rejects.toMatchObject({ code: 'STALE_TARGET' });
  expect(f.mouse.click).not.toHaveBeenCalled();
  expect(f.controller.busy).toBe(false);
  f.controller.close();
});
it('refuses a viewport that changed during approval before sending input', async () => {
  const f = fixture();
  try {
    const prepared = await f.controller.prepare({
      type: 'clickAt',
      at: { unit: 'css', x: 10, y: 10 },
    });
    await expect(
      f.controller.perform(
        prepared.token,
        () => {},
        async () => {
          f.scroll();
        }
      )
    ).rejects.toMatchObject({ code: 'STALE_TARGET' });
    expect(f.mouse.click).not.toHaveBeenCalled();
  } finally {
    f.controller.close();
  }
});

it('ends hung preparation on its deadline and on close without a late gesture', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  try {
    for (const mode of ['deadline', 'close']) {
      const f = fixture();
      f.send.mockImplementation(async (method) => {
        if (method === 'Page.getFrameTree') return new Promise(() => {});
        return {};
      });
      const outcome = f.controller
        .prepare({ type: 'clickAt', at: { unit: 'css', x: 10, y: 10 } })
        .catch((e) => e);
      await vi.waitFor(() =>
        expect(f.send.mock.calls.some((c) => c[0] === 'Page.getFrameTree')).toBe(true)
      );
      if (mode === 'close') f.controller.close();
      else await vi.advanceTimersByTimeAsync(15001);
      expect(await outcome).toMatchObject({
        code: mode === 'close' ? 'PAGE_NOT_FOUND' : 'ACTION_TIMEOUT',
      });
      expect(f.controller.busy).toBe(false);
      expect(f.mouse.click).not.toHaveBeenCalled();
      f.controller.close();
    }
  } finally {
    vi.useRealTimers();
  }
});
it.each(['timeout', 'close', 'revoke', 'transport'])(
  'reports %s during submitted input as uncertain and holds exclusion until it settles',
  async (mode) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const f = fixture();
    const owner = new AbortController();
    let finish!: () => void;
    let reject!: (reason: unknown) => void;
    try {
      f.mouse.click.mockImplementation(
        () =>
          new Promise<void>((resolve, bad) => {
            finish = resolve;
            reject = bad;
          })
      );
      const authority = () => {
        if (owner.signal.aborted) throw new EngineError('CONTROL_REVOKED', 'Owner revoked', false);
      };
      const prepared = await f.controller.prepare(
        {
          type: 'clickAt',
          at: { unit: 'css', x: 10, y: 10 },
        },
        { signal: owner.signal, assertCurrent: authority }
      );
      const outcome = f.controller
        .perform(prepared.token, authority, async () => {})
        .catch((e) => e);
      await vi.waitFor(() => expect(f.mouse.click).toHaveBeenCalledOnce());
      if (mode === 'timeout') await vi.advanceTimersByTimeAsync(15001);
      if (mode === 'close') f.controller.close();
      if (mode === 'revoke') owner.abort();
      if (mode === 'transport') reject(new Error('Browser connection closed'));
      expect(await outcome).toMatchObject({
        code:
          mode === 'timeout'
            ? 'ACTION_TIMEOUT'
            : mode === 'close'
              ? 'PAGE_NOT_FOUND'
              : mode === 'revoke'
                ? 'CONTROL_REVOKED'
                : 'ENGINE_CRASHED',
        details: { dispatch: 'uncertain', stage: 'mouse-click' },
      });
      if (mode === 'transport') {
        expect(f.controller.busy).toBe(false);
        return;
      }
      expect(f.controller.busy).toBe(true);
      await expect(
        f.controller.prepare({ type: 'clickAt', at: { unit: 'css', x: 10, y: 10 } })
      ).rejects.toMatchObject({ code: mode === 'close' ? 'PAGE_NOT_FOUND' : 'SESSION_BUSY' });
      finish();
      await vi.waitFor(() => expect(f.controller.busy).toBe(false));
      expect(f.mouse.click).toHaveBeenCalledOnce();
    } finally {
      f.controller.close();
      vi.useRealTimers();
    }
  }
);
it.each(['complete', 'close', 'revoke', 'transport'])(
  'pins attachment bytes to the approved backend, including %s during the file write',
  async (mode) => {
    const f = fixture();
    const directory = await mkdtemp(join(tmpdir(), 'coordinate-owned-'));
    const bytes = Buffer.from('approved-owned-bytes');
    const file = join(directory, 'proof.txt');
    await writeFile(file, bytes, { mode: 0o600 });
    const wrongSetFiles = vi.fn();
    const owner = new AbortController();
    let finish!: () => void;
    let reject!: (error: unknown) => void;
    const pending = new Promise<void>((resolve, bad) => {
      finish = resolve;
      reject = bad;
    });
    const authority = () => {
      if (owner.signal.aborted) throw new EngineError('CONTROL_REVOKED', 'Owner revoked', false);
    };
    try {
      f.mouse.click.mockImplementation(async () => {
        f.cdpEvents.emit('Page.fileChooserOpened', { frameId: 'frame', backendNodeId: 10 });
        f.pageEvents.emit('filechooser', {
          element: () => ({ backendNodeId: 20 }),
          setFiles: wrongSetFiles,
        });
      });
      const prepared = await f.controller.prepare(
        {
          type: 'uploadAt',
          at: { unit: 'css', x: 10, y: 10 },
          paths: [file],
          sha256: createHash('sha256').update(bytes).digest('hex'),
        },
        { signal: owner.signal, assertCurrent: authority }
      );
      // Consent binds the detached bytes; dispatch never reopens the mutable path.
      await writeFile(file, 'path-replaced-after-preparation');
      if (mode !== 'complete') {
        const original = f.send.getMockImplementation()!;
        f.send.mockImplementation(async (method, params) => {
          if (method === 'Runtime.callFunctionOn') await pending;
          return original(method, params);
        });
      }
      const operation = f.controller
        .perform(prepared.token, authority, async () => {})
        .catch((error) => error);
      if (mode === 'complete')
        expect(await operation).toMatchObject({ inputBackendVerified: true });
      else {
        await vi.waitFor(() =>
          expect(f.send.mock.calls.some((c) => c[0] === 'Runtime.callFunctionOn')).toBe(true)
        );
        if (mode === 'close') f.controller.close();
        if (mode === 'revoke') owner.abort();
        if (mode === 'transport') reject(new Error('Browser connection closed'));
        expect(await operation).toMatchObject({
          code:
            mode === 'close'
              ? 'PAGE_NOT_FOUND'
              : mode === 'revoke'
                ? 'CONTROL_REVOKED'
                : 'ENGINE_CRASHED',
          details: { dispatch: 'uncertain', stage: 'file-attachment' },
        });
        if (mode !== 'transport') expect(f.controller.busy).toBe(true);
        finish();
        await vi.waitFor(() => expect(f.controller.busy).toBe(false));
      }
      expect(wrongSetFiles).not.toHaveBeenCalled();
      const mutation = f.send.mock.calls.find((c) => c[0] === 'Runtime.callFunctionOn');
      expect(mutation?.[1]).toMatchObject({
        objectId: 'node-10',
        arguments: [
          { value: bytes.toString('base64') },
          { value: 'proof.txt' },
          { value: 'application/octet-stream' },
        ],
      });
    } finally {
      finish();
      f.controller.close();
      await rm(directory, { recursive: true, force: true });
    }
  }
);
it.each(['competing', 'competing-during-resolution', 'wrong-input', 'late', 'owner-abort'])(
  'never delivers file bytes for a %s chooser and removes listeners',
  async (mode) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const f = fixture();
    const directory = await mkdtemp(join(tmpdir(), 'coordinate-chooser-'));
    const bytes = Buffer.from('never-delivered-sentinel');
    const file = join(directory, 'proof.txt');
    const owner = new AbortController();
    const emit = () => {
      f.cdpEvents.emit('Page.fileChooserOpened', {
        frameId: 'frame',
        backendNodeId: mode === 'wrong-input' ? 20 : 10,
      });
      f.pageEvents.emit('filechooser', {});
    };
    try {
      await writeFile(file, bytes, { mode: 0o600 });
      if (mode === 'competing')
        f.mouse.click.mockImplementation(async () => {
          emit();
          emit();
        });
      if (mode === 'wrong-input' || mode === 'competing-during-resolution')
        f.mouse.click.mockImplementation(async () => {
          emit();
        });
      const prepared = await f.controller.prepare(
        {
          type: 'uploadAt',
          at: { unit: 'css', x: 10, y: 10 },
          paths: [file],
          sha256: createHash('sha256').update(bytes).digest('hex'),
        },
        { signal: owner.signal, assertCurrent: () => {} }
      );
      if (mode === 'competing-during-resolution') {
        const original = f.send.getMockImplementation()!;
        f.send.mockImplementation(async (method, params) => {
          if (method === 'DOM.resolveNode') {
            await Promise.resolve();
            emit();
          }
          return original(method, params);
        });
      }
      const outcome = f.controller
        .perform(
          prepared.token,
          () => {},
          async () => {}
        )
        .catch((e) => e);
      await vi.waitFor(() => expect(f.mouse.click).toHaveBeenCalledOnce());
      if (mode === 'late') await vi.advanceTimersByTimeAsync(5001);
      if (mode === 'owner-abort') owner.abort();
      expect(await outcome).toMatchObject({
        code:
          mode === 'competing' || mode === 'competing-during-resolution' || mode === 'wrong-input'
            ? 'TARGET_AMBIGUOUS'
            : mode === 'late'
              ? 'ACTION_TIMEOUT'
              : 'PAGE_NOT_FOUND',
      });
      expect(f.pageEvents.listenerCount('filechooser')).toBe(0);
      expect(f.cdpEvents.listenerCount('Page.fileChooserOpened')).toBe(0);
      emit();
      expect(f.send.mock.calls.some((c) => c[0] === 'Runtime.callFunctionOn')).toBe(false);
      expect(f.mouse.click).toHaveBeenCalledOnce();
    } finally {
      f.controller.close();
      vi.useRealTimers();
      await rm(directory, { recursive: true, force: true });
    }
  }
);
it('rejects a changed upload path on the approval retry, retaining the original digest requirement', async () => {
  const f = fixture();
  const directory = await mkdtemp(join(tmpdir(), 'coordinate-file-change-'));
  const file = join(directory, 'proof.txt');
  const bytes = Buffer.from('original-proof');
  try {
    await writeFile(file, bytes, { mode: 0o600 });
    const action = {
      type: 'uploadAt' as const,
      at: { unit: 'css' as const, x: 10, y: 10 },
      paths: [file],
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
    const first = await f.controller.prepare(action);
    first.dispose();
    await writeFile(file, 'replaced-proof');
    await expect(f.controller.prepare(action)).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    expect(f.mouse.click).not.toHaveBeenCalled();
  } finally {
    f.controller.close();
    await rm(directory, { recursive: true, force: true });
  }
});
