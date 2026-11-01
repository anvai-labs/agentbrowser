import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import {
  type CoordinateAuthority,
  type EngineAction,
  EngineError,
  normalizeEngineError,
  type PreparedCoordinateAction,
  readVerifiedUpload,
  type VerifiedUpload,
} from '@agentbrowser/engine';
import {
  type CoordinatePoint,
  mapScreenshotPoint,
  parseCoordinatePoint,
  type ViewportCapture,
} from '@agentbrowser/protocol';
import type { CDPSession, FileChooser, Page } from 'playwright';
import { CoordinateLifetime } from './coordinate-lifetime.js';

type State = {
  frameId: string;
  loaderId: string;
  documentUrl: string;
  cssWidth: number;
  cssHeight: number;
  visualWidth: number;
  visualHeight: number;
  layoutWidth: number;
  layoutHeight: number;
  devicePixelRatio: number;
  visualScale: number;
  visualOffsetX: number;
  visualOffsetY: number;
  scrollX: number;
  scrollY: number;
  pageZoom?: number;
};
type Capture = { coordinates: ViewportCapture; state: string; sha256: string; expiresAt: number };
type Plan = {
  ownerSignal?: AbortSignal;
  token: object;
  identity: string;
  state: string;
  point: { x: number; y: number };
  deadline: number;
  used: boolean;
  performing: boolean;
  disposed: boolean;
  type: 'clickAt' | 'uploadAt';
  imageHash?: string;
  upload?: VerifiedUpload | undefined;
  pendingWrites: number;
  dispatchStage?: string;
  backendNodeId?: number;
  frameId: string;
  timer: ReturnType<typeof setTimeout>;
};
const rawSession = Symbol('coordinate raw CDP session');
type CoordinateCdp = CDPSession & { [rawSession]: CDPSession };
const digest = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');
const same = (state: State) => JSON.stringify(state);
const stale = (changed?: string[]) =>
  new EngineError(
    'STALE_TARGET',
    'Coordinate capture or document changed; capture again before input',
    false,
    changed ? { changed } : undefined
  );

/** Page-owned, bounded visual evidence and one exclusive prepared gesture. */
export class CoordinateController {
  private readonly captures = new Map<string, Capture>();
  private plan: Plan | undefined;
  private preparing = false;
  private closed = false;
  private generation = 0;
  private readonly operations = new AsyncLocalStorage<CoordinateLifetime>();
  private documentLife = new AbortController();
  private readonly pageLife = new AbortController();
  constructor(
    private readonly page: Page,
    private readonly getCdp: () => Promise<CDPSession | undefined>
  ) {}
  private async operate<T>(
    job: () => Promise<T>,
    authority?: CoordinateAuthority,
    timeoutMs = 15000
  ): Promise<T> {
    const signals = [this.pageLife.signal, this.documentLife.signal];
    if (authority?.signal) signals.push(authority.signal);
    const scope = new CoordinateLifetime(
      AbortSignal.any(signals),
      () => {
        this.live();
        authority?.assertCurrent();
      },
      timeoutMs
    );
    try {
      scope.assert();
      return await this.operations.run(scope, job);
    } finally {
      scope.finish();
    }
  }
  private scope(): CoordinateLifetime {
    const scope = this.operations.getStore();
    if (!scope) throw new EngineError('INTERNAL', 'Coordinate operation has no lifetime', false);
    return scope;
  }
  private async cdp(): Promise<CoordinateCdp | undefined> {
    const scope = this.scope();
    const client = await scope.read('cdp-attach', this.getCdp);
    if (!client) return undefined;
    return new Proxy(client, {
      get(target, key) {
        if (key === rawSession) return target;
        if (key === 'send')
          return (method: string, params?: object) =>
            scope.read(
              method,
              () => target.send(method as never, params as never),
              (late: unknown) => {
                const data = late as {
                  object?: { objectId?: string };
                  result?: { objectId?: string };
                };
                const objectId = data?.object?.objectId ?? data?.result?.objectId;
                if (objectId)
                  void target.send('Runtime.releaseObject', { objectId }).catch(() => {});
                const group = (params as Record<string, unknown> | undefined)?.objectGroup;
                if (typeof group === 'string')
                  void target
                    .send('Runtime.releaseObjectGroup', { objectGroup: group })
                    .catch(() => {});
              }
            );
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as CoordinateCdp;
  }
  private async write<T>(plan: Plan, stage: string, submit: () => Promise<T>): Promise<T> {
    return this.scope().read(
      stage,
      () => {
        plan.pendingWrites++;
        plan.dispatchStage = stage;
        let pending: Promise<T>;
        try {
          pending = submit();
        } catch (error) {
          plan.pendingWrites--;
          throw error;
        }
        return pending.finally(() => {
          plan.pendingWrites--;
          if (plan.disposed && !plan.performing) this.release(plan.token);
        });
      },
      undefined,
      true
    );
  }
  get busy(): boolean {
    return this.preparing || this.plan !== undefined;
  }
  owns(token: unknown): boolean {
    return this.plan?.token === token;
  }
  private live(deadline = Number.POSITIVE_INFINITY): void {
    if (this.closed || this.page.isClosed())
      throw new EngineError('PAGE_NOT_FOUND', 'Coordinate page closed', false);
    if (performance.now() >= deadline)
      throw new EngineError(
        'ACTION_TIMEOUT',
        'Coordinate preparation expired; no late input will dispatch',
        false
      );
  }
  private async state(): Promise<State> {
    this.live();
    const cdp = await this.cdp();
    if (!cdp)
      throw new EngineError('ENGINE_UNSUPPORTED', 'Coordinate metrics require Chromium', false);
    const tree = await cdp.send('Page.getFrameTree');
    const metrics = await cdp.send('Page.getLayoutMetrics');
    const world = await cdp.send('Page.createIsolatedWorld', {
      frameId: tree.frameTree.frame.id,
      worldName: 'agentbrowser-coordinate-metrics',
    });
    const nativeViewport = await cdp.send('Runtime.evaluate', {
      expression: '({devicePixelRatio, width:innerWidth, height:innerHeight})',
      contextId: world.executionContextId,
      returnByValue: true,
    });
    const confirmed = await cdp.send('Page.getFrameTree');
    if (
      confirmed.frameTree.frame.id !== tree.frameTree.frame.id ||
      confirmed.frameTree.frame.loaderId !== tree.frameTree.frame.loaderId ||
      confirmed.frameTree.frame.url !== tree.frameTree.frame.url
    )
      throw stale();
    this.live();
    const v = metrics.cssVisualViewport;
    const l = metrics.cssLayoutViewport;
    const native = nativeViewport.result.value as
      | { devicePixelRatio?: unknown; width?: unknown; height?: unknown }
      | undefined;
    const value = {
      frameId: tree.frameTree.frame.id,
      loaderId: tree.frameTree.frame.loaderId,
      documentUrl: digest(tree.frameTree.frame.url ?? ''),
      // PNG covers the complete viewport, including classic scrollbars. CDP's
      // client extents exclude them and would shrink the image-to-mouse mapping.
      cssWidth: Number(native?.width),
      cssHeight: Number(native?.height),
      visualWidth: v.clientWidth,
      visualHeight: v.clientHeight,
      layoutWidth: l.clientWidth,
      layoutHeight: l.clientHeight,
      devicePixelRatio: Number(native?.devicePixelRatio),
      visualScale: v.scale,
      visualOffsetX: v.offsetX,
      visualOffsetY: v.offsetY,
      scrollX: l.pageX,
      scrollY: l.pageY,
      ...(v.zoom === undefined ? {} : { pageZoom: v.zoom }),
    };
    const clip = this.page.viewportSize();
    if (clip && (clip.width !== value.cssWidth || clip.height !== value.cssHeight))
      throw new EngineError(
        'ENGINE_UNSUPPORTED',
        'Screenshot clip disagrees with the native viewport; capture transform is unqualified',
        false
      );
    if (
      !Object.values(value).every((item) => typeof item === 'string' || Number.isFinite(item)) ||
      [
        value.cssWidth,
        value.cssHeight,
        value.visualWidth,
        value.visualHeight,
        value.layoutWidth,
        value.layoutHeight,
        value.devicePixelRatio,
      ].some((item) => item <= 0)
    )
      throw new EngineError('ENGINE_UNSUPPORTED', 'Coordinate metrics unavailable', false);
    this.live();
    return value;
  }
  private qualified(state: State): void {
    if (
      state.pageZoom !== 1 ||
      state.visualScale !== 1 ||
      state.visualOffsetX !== 0 ||
      state.visualOffsetY !== 0
    )
      throw new EngineError(
        'ENGINE_UNSUPPORTED',
        'Unknown or non-unit page zoom, pinch zoom or visual viewport offset is not qualified for coordinate input',
        false
      );
  }
  private async png(timeout = 5000): Promise<Buffer> {
    const bytes = await this.scope().read('viewport-png', () =>
      this.page.screenshot({
        type: 'png',
        scale: 'device',
        caret: 'hide',
        animations: 'allow',
        timeout: Math.max(1, timeout),
      })
    );
    if (bytes.length > 10 * 1024 * 1024)
      throw new EngineError('INVALID_REQUEST', 'Viewport verification image exceeds 10 MiB', false);
    return bytes;
  }
  capture(): Promise<{ bytes: Buffer; coordinates: ViewportCapture }> {
    return this.operate(() => this.captureInternal());
  }
  private async captureInternal(): Promise<{ bytes: Buffer; coordinates: ViewportCapture }> {
    const before = await this.state();
    const bytes = await this.png();
    const after = await this.state();
    if (same(before) !== same(after))
      throw stale(
        (Object.keys(before) as Array<keyof State>).filter((key) => before[key] !== after[key])
      );
    if (bytes.length < 24 || bytes.toString('ascii', 1, 4) !== 'PNG')
      throw new EngineError('INTERNAL', 'Invalid viewport PNG', false);
    const coordinates: ViewportCapture = {
      captureId: `cap_${randomUUID()}`,
      createdAt: Date.now(),
      kind: 'viewport-png',
      cssWidth: before.cssWidth,
      cssHeight: before.cssHeight,
      rasterWidth: bytes.readUInt32BE(16),
      rasterHeight: bytes.readUInt32BE(20),
      devicePixelRatio: before.devicePixelRatio,
      ...(before.pageZoom === undefined ? {} : { pageZoom: before.pageZoom }),
      visualScale: before.visualScale,
      visualOffsetX: before.visualOffsetX,
      visualOffsetY: before.visualOffsetY,
      scrollX: before.scrollX,
      scrollY: before.scrollY,
    };
    for (const [id, capture] of this.captures)
      if (performance.now() >= capture.expiresAt) this.captures.delete(id);
    while (this.captures.size >= 4) {
      const id = this.captures.keys().next().value;
      if (id) this.captures.delete(id);
    }
    this.captures.set(coordinates.captureId, {
      coordinates,
      state: same(before),
      sha256: digest(bytes),
      expiresAt: performance.now() + 60000,
    });
    return { bytes, coordinates };
  }
  private point(
    at: CoordinatePoint,
    state: State
  ): { point: { x: number; y: number }; imageHash?: string } {
    this.qualified(state);
    let point: { x: number; y: number };
    let imageHash: string | undefined;
    if (at.unit === 'image') {
      const capture = this.captures.get(at.captureId);
      if (
        !capture ||
        performance.now() >= capture.expiresAt ||
        capture.state !== same(state) ||
        at.rasterWidth !== capture.coordinates.rasterWidth ||
        at.rasterHeight !== capture.coordinates.rasterHeight
      )
        throw stale();
      point = mapScreenshotPoint(capture.coordinates, at.x, at.y);
      imageHash = capture.sha256;
    } else point = { x: at.x, y: at.y };
    if (point.x < 0 || point.y < 0 || point.x >= state.cssWidth || point.y >= state.cssHeight)
      throw new EngineError('INVALID_REQUEST', 'Coordinate point is outside the viewport', false);
    return { point, ...(imageHash ? { imageHash } : {}) };
  }
  private async fileInput(point: { x: number; y: number }, frameId: string): Promise<number> {
    if (!Number.isInteger(point.x) || !Number.isInteger(point.y))
      throw new EngineError(
        'INVALID_REQUEST',
        'Coordinate upload requires integral CSS coordinates',
        false
      );
    const cdp = await this.cdp();
    if (!cdp) throw new EngineError('ENGINE_UNSUPPORTED', 'Chooser identity unavailable', false);
    const hit = await cdp.send('DOM.getNodeForLocation', {
      x: point.x,
      y: point.y,
      includeUserAgentShadowDOM: false,
    });
    if (hit.frameId !== frameId)
      throw new EngineError(
        'ENGINE_UNSUPPORTED',
        'Coordinate upload requires a main-frame native file input',
        false
      );
    let node = (await cdp.send('DOM.describeNode', { backendNodeId: hit.backendNodeId, depth: 0 }))
      .node;
    if (node.nodeName === 'LABEL') {
      const world = await cdp.send('Page.createIsolatedWorld', {
        frameId,
        worldName: 'agentbrowser-coordinate-metrics',
      });
      const resolved = await cdp.send('DOM.resolveNode', {
        backendNodeId: node.backendNodeId,
        executionContextId: world.executionContextId,
      });
      if (!resolved.object.objectId) throw stale();
      let control: string | undefined;
      try {
        const result = await cdp.send('Runtime.callFunctionOn', {
          objectId: resolved.object.objectId,
          functionDeclaration:
            'function(){return Object.getOwnPropertyDescriptor(HTMLLabelElement.prototype,"control").get.call(this)}',
        });
        control = result.result.objectId;
        if (!control)
          throw new EngineError(
            'ENGINE_UNSUPPORTED',
            'Native label has no unique file control',
            false
          );
        node = (await cdp.send('DOM.describeNode', { objectId: control, depth: 0 })).node;
      } finally {
        if (control)
          void cdp[rawSession].send('Runtime.releaseObject', { objectId: control }).catch(() => {});
        void cdp[rawSession]
          .send('Runtime.releaseObject', { objectId: resolved.object.objectId })
          .catch(() => {});
      }
    }
    const attrs = node.attributes ?? [];
    const attributes: Record<string, string> = {};
    for (let i = 0; i < attrs.length; i += 2) attributes[attrs[i] ?? ''] = attrs[i + 1] ?? '';
    if (
      node.nodeName !== 'INPUT' ||
      attributes.type?.toLowerCase() !== 'file' ||
      'disabled' in attributes ||
      'webkitdirectory' in attributes ||
      'directory' in attributes
    )
      throw new EngineError(
        'ENGINE_UNSUPPORTED',
        'Coordinate upload requires a native file input or its label; custom chooser callbacks are unqualified',
        false
      );
    return node.backendNodeId;
  }
  /** Positive, bounded closed-root evidence; an empty tree alone proves nothing. */
  hasClosedShadowRoot(): Promise<boolean> {
    return this.operate(() => this.closedRootInternal(), undefined, 1000);
  }
  private async closedRootInternal(): Promise<boolean> {
    const cdp = await this.cdp();
    if (!cdp) return false;
    const state = await this.state();
    const world = await cdp.send('Page.createIsolatedWorld', {
      frameId: state.frameId,
      worldName: 'agentbrowser-coordinate-metrics',
    });
    const objectGroup = `coordinate-shadow-${randomUUID()}`;
    try {
      const result = await cdp.send('Runtime.evaluate', {
        contextId: world.executionContextId,
        objectGroup,
        expression: `(() => {
          const candidates = [];
          const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_ELEMENT);
          let node;
          for (let scanned = 0; scanned < 128 && candidates.length < 16 && (node = walker.nextNode()); scanned++) {
            if (node.localName.includes('-') || node.childElementCount === 0) candidates.push(node);
          }
          return candidates;
        })()`,
      });
      if (!result.result.objectId) return false;
      const properties = await cdp.send('Runtime.getProperties', {
        objectId: result.result.objectId,
        ownProperties: true,
      });
      for (const property of properties.result.slice(0, 17)) {
        if (!/^\d+$/.test(property.name) || !property.value?.objectId) continue;
        const described = await cdp.send('DOM.describeNode', {
          objectId: property.value.objectId,
          depth: 0,
          pierce: true,
        });
        if (
          described.node.shadowRoots?.some(
            (root: { shadowRootType?: string }) => root.shadowRootType === 'closed'
          )
        ) {
          if (same(await this.state()) !== same(state)) return false;
          return true;
        }
      }
      return false;
    } finally {
      void cdp[rawSession].send('Runtime.releaseObjectGroup', { objectGroup }).catch(() => {});
    }
  }
  prepare(
    action: EngineAction,
    authority?: CoordinateAuthority
  ): Promise<PreparedCoordinateAction> {
    return this.operate(() => this.prepareInternal(action, authority?.signal), authority);
  }
  private async prepareInternal(
    action: EngineAction,
    ownerSignal?: AbortSignal
  ): Promise<PreparedCoordinateAction> {
    if (this.busy)
      throw new EngineError(
        'SESSION_BUSY',
        'Another prepared coordinate gesture owns this page',
        false
      );
    this.preparing = true;
    const generation = this.generation;
    const assertPreparation = () => {
      this.live(deadline);
      if (this.generation !== generation) throw stale();
    };
    const deadline = this.scope().deadline;
    let upload: VerifiedUpload | undefined;
    try {
      assertPreparation();
      const at = parseCoordinatePoint(action.at);
      if (action.type !== 'clickAt' && action.type !== 'uploadAt')
        throw new EngineError('INVALID_REQUEST', 'Not a coordinate action', false);
      if (action.type === 'uploadAt') {
        const paths = action.paths as string[];
        const expectedDigest = action.sha256;
        if (!Array.isArray(paths) || paths.length !== 1 || typeof expectedDigest !== 'string')
          throw new EngineError(
            'INVALID_REQUEST',
            'Coordinate upload requires one verified file',
            false
          );
        upload = await this.scope().read(
          'verified-file',
          () =>
            readVerifiedUpload(
              paths[0] ?? '',
              expectedDigest,
              typeof action.mimeType === 'string' ? action.mimeType : undefined
            ),
          (value) => value.buffer.fill(0)
        );
      }
      assertPreparation();
      const state = await this.state();
      this.live(deadline);
      const mapped = this.point(at, state);
      const backendNodeId = upload ? await this.fileInput(mapped.point, state.frameId) : undefined;
      assertPreparation();
      const visualHash = digest(await this.png());
      assertPreparation();
      if (mapped.imageHash && mapped.imageHash !== visualHash) throw stale();
      if (same(await this.state()) !== same(state)) throw stale();
      assertPreparation();
      const identity = digest(
        JSON.stringify({
          state,
          visualHash,
          at,
          point: mapped.point,
          type: action.type,
          file: upload
            ? {
                sha256: upload.sha256,
                name: upload.name,
                mimeType: upload.mimeType,
                size: upload.buffer.length,
              }
            : undefined,
          backendNodeId,
        })
      );
      const token = {};
      const timer = setTimeout(
        () => this.release(token),
        Math.max(1, deadline - performance.now())
      );
      timer.unref();
      this.plan = {
        ...(ownerSignal ? { ownerSignal } : {}),
        token,
        identity,
        state: same(state),
        point: mapped.point,
        deadline,
        used: false,
        performing: false,
        pendingWrites: 0,
        disposed: false,
        type: action.type,
        frameId: state.frameId,
        timer,
        imageHash: visualHash,
        ...(upload ? { upload } : {}),
        ...(backendNodeId !== undefined ? { backendNodeId } : {}),
      };
      return { identity, token, dispose: () => this.release(token) };
    } catch (error) {
      upload?.buffer.fill(0);
      throw error;
    } finally {
      this.preparing = false;
    }
  }
  private release(token: object): void {
    if (this.plan?.token !== token) return;
    this.plan.disposed = true;
    clearTimeout(this.plan.timer);
    // A pending browser serialization still owns the detached bytes and page lock.
    // Invalidation refuses later dispatch; cleanup waits for the operation to settle.
    if (this.closed) {
      this.plan.upload?.buffer.fill(0);
      this.plan.upload = undefined;
    }
    if (this.plan.performing || this.plan.pendingWrites > 0) return;
    this.plan.upload?.buffer.fill(0);
    this.plan = undefined;
  }
  private async visual(
    before: Buffer
  ): Promise<{ visibleEffect: 'observed' | 'none' | 'unavailable'; warning?: string }> {
    const deadline = performance.now() + 1000;
    try {
      do {
        const after = await this.png(deadline - performance.now());
        if (digest(before) !== digest(after)) return { visibleEffect: 'observed' };
      } while (performance.now() < deadline);
      return {
        visibleEffect: 'none',
        warning:
          'No visible effect — click may be swallowed. Input was dispatched; inspect current state before any retry.',
      };
    } catch {
      return {
        visibleEffect: 'unavailable',
        warning:
          'Input was dispatched; visual verification is unavailable. Inspect current state before any retry.',
      };
    }
  }
  private async recheck(plan: Plan, live: () => void): Promise<Buffer> {
    live();
    if (same(await this.state()) !== plan.state) throw stale();
    live();
    const image = await this.png(Math.min(5000, Math.max(1, plan.deadline - performance.now())));
    live();
    if (plan.imageHash && digest(image) !== plan.imageHash) throw stale();
    if (
      plan.backendNodeId !== undefined &&
      (await this.fileInput(plan.point, plan.frameId)) !== plan.backendNodeId
    )
      throw stale();
    if (same(await this.state()) !== plan.state) throw stale();
    live();
    return image;
  }
  perform(
    token: object,
    assertCurrent: () => void,
    beforeDispatch: () => Promise<void>
  ): Promise<unknown> {
    const plan = this.plan;
    if (!plan || plan.token !== token || plan.used || plan.disposed) return Promise.reject(stale());
    return this.operate(
      () => this.performInternal(token, assertCurrent, beforeDispatch),
      { assertCurrent, ...(plan.ownerSignal ? { signal: plan.ownerSignal } : {}) },
      Math.max(1, plan.deadline - performance.now())
    );
  }
  private async performInternal(
    token: object,
    assertCurrent: () => void,
    beforeDispatch: () => Promise<void>
  ): Promise<unknown> {
    const plan = this.plan;
    if (!plan || plan.token !== token || plan.used || plan.disposed) throw stale();
    if (typeof beforeDispatch !== 'function')
      throw new EngineError(
        'INVALID_REQUEST',
        'Coordinate dispatch requires an approval commit',
        false
      );
    plan.used = true;
    plan.performing = true;
    const live = () => {
      this.live(plan.deadline);
      if (this.plan !== plan || plan.disposed) throw stale();
      assertCurrent();
    };
    try {
      await this.recheck(plan, live);
      if (plan.upload) return await this.attach(plan, live, beforeDispatch);
      await this.scope().read('approval-commit', beforeDispatch);
      const before = await this.recheck(plan, live);
      await this.write(plan, 'mouse-click', () =>
        this.page.mouse.click(plan.point.x, plan.point.y)
      );
      return { dispatched: true, ...(await this.visual(before)) };
    } catch (error) {
      if (!plan.dispatchStage) throw error;
      const failure = normalizeEngineError(error);
      throw new EngineError(failure.code, failure.message, false, {
        ...failure.details,
        stage: plan.dispatchStage,
        dispatch: 'uncertain',
      });
    } finally {
      plan.performing = false;
      this.release(token);
    }
  }
  private async attach(
    plan: Plan,
    live: () => void,
    beforeDispatch: () => Promise<void>
  ): Promise<unknown> {
    const upload = plan.upload;
    const backendNodeId = plan.backendNodeId;
    if (!upload || backendNodeId === undefined) throw stale();
    const cdp = await this.cdp();
    if (!cdp) throw stale();
    await cdp.send('Page.enable', { enableFileChooserOpenedEvent: true });
    live();
    const choosers: FileChooser[] = [];
    const opened: Array<{ frameId: string; backendNodeId?: number }> = [];
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const ready = new Promise<void>((ok, bad) => {
      resolve = ok;
      reject = bad;
    });
    void ready.catch(() => {});
    let gestureStarted = false;
    const changed = () => {
      if (!gestureStarted || choosers.length > 1 || opened.length > 1)
        reject(
          new EngineError(
            'TARGET_AMBIGUOUS',
            'Competing file chooser; no file bytes attached',
            false
          )
        );
      else if (choosers.length === 1 && opened.length === 1) resolve();
    };
    const chooser = (value: FileChooser) => {
      if (choosers.length < 2) choosers.push(value);
      changed();
    };
    const event = (value: { frameId: string; backendNodeId?: number }) => {
      if (opened.length < 2) opened.push(value);
      changed();
    };
    this.page.on('filechooser', chooser);
    cdp.on('Page.fileChooserOpened', event);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      live();
      await this.scope().read('approval-commit', beforeDispatch);
      await this.recheck(plan, live);
      if (choosers.length + opened.length > 0)
        throw new EngineError(
          'TARGET_AMBIGUOUS',
          'Unrelated chooser arrived before the approved gesture',
          false
        );
      timer = setTimeout(
        () =>
          reject(
            new EngineError(
              'ACTION_TIMEOUT',
              'Chooser did not arrive; click may have executed. Never replay automatically.',
              false,
              { chooserCount: choosers.length, nativeEventCount: opened.length }
            )
          ),
        Math.min(5000, Math.max(1, plan.deadline - performance.now()))
      );
      timer.unref();
      live();
      gestureStarted = true;
      await this.write(plan, 'mouse-click', () =>
        this.page.mouse.click(plan.point.x, plan.point.y)
      );
      await this.scope().read('file-chooser', () => ready);
      live();
      if (
        choosers.length !== 1 ||
        opened.length !== 1 ||
        opened[0]?.frameId !== plan.frameId ||
        opened[0]?.backendNodeId !== backendNodeId ||
        same(await this.state()) !== plan.state
      )
        throw new EngineError(
          'TARGET_AMBIGUOUS',
          'Chooser does not identify the approved native input; no file bytes attached',
          false
        );
      const world = await cdp.send('Page.createIsolatedWorld', {
        frameId: plan.frameId,
        worldName: 'agentbrowser-coordinate-attachment',
      });
      live();
      const resolved = await cdp.send('DOM.resolveNode', {
        backendNodeId,
        executionContextId: world.executionContextId,
      });
      const objectId = resolved.object.objectId;
      if (!objectId) throw stale();
      try {
        live();
        if (same(await this.state()) !== plan.state) throw stale();
        live();
        if (choosers.length !== 1 || opened.length !== 1)
          throw new EngineError(
            'TARGET_AMBIGUOUS',
            'Competing chooser before attachment; no bytes delivered',
            false
          );
        // The observer's PW handle is not the attachment authority. Both streams can
        // reorder; the byte target is the browser-resolved approved backend node.
        const payload = upload.buffer.toString('base64');
        const outcome = await this.write(plan, 'file-attachment', () =>
          cdp[rawSession].send('Runtime.callFunctionOn', {
            objectId,
            functionDeclaration: `function(bytes,name,mime) {
            const get = (prototype,key) => Object.getOwnPropertyDescriptor(prototype,key).get.call(this);
            if (!(this instanceof HTMLInputElement) || !get(Node.prototype,'isConnected') ||
                get(Node.prototype,'ownerDocument') !== document || get(HTMLInputElement.prototype,'type') !== 'file' ||
                Element.prototype.matches.call(this,':disabled') ||
                Element.prototype.hasAttribute.call(this,'webkitdirectory') || Element.prototype.hasAttribute.call(this,'directory'))
              return {applied:false};
            const data = Uint8Array.from(atob(bytes), c => c.charCodeAt(0));
            const transfer = new DataTransfer();
            transfer.items.add(new File([data],name,{type:mime}));
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'files').set.call(this,transfer.files);
            EventTarget.prototype.dispatchEvent.call(this,new Event('input',{bubbles:true,composed:true}));
            EventTarget.prototype.dispatchEvent.call(this,new Event('change',{bubbles:true}));
            return {applied:true};
          }`,
            arguments: [{ value: payload }, { value: upload.name }, { value: upload.mimeType }],
            returnByValue: true,
          })
        );
        live();
        if (outcome.exceptionDetails || outcome.result.value?.applied !== true)
          throw new EngineError(
            'STALE_TARGET',
            'Native file attachment could not be verified; inspect before retrying',
            false,
            { dispatch: 'uncertain' }
          );
      } finally {
        void cdp[rawSession].send('Runtime.releaseObject', { objectId }).catch(() => {});
      }
      return {
        dispatched: true,
        inputBackendVerified: true,
        files: [{ name: upload.name, size: upload.buffer.length, sha256: upload.sha256 }],
      };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      this.page.off('filechooser', chooser);
      cdp.off('Page.fileChooserOpened', event);
    }
  }
  invalidate(): void {
    this.documentLife.abort(stale());
    this.documentLife = new AbortController();
    this.generation++;
    this.captures.clear();
    if (this.plan) this.release(this.plan.token);
  }
  close(): void {
    this.closed = true;
    this.pageLife.abort(new EngineError('PAGE_NOT_FOUND', 'Coordinate page closed', false));
    this.invalidate();
  }
}
