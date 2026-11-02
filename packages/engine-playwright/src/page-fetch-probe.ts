import { createHash } from 'node:crypto';
import {
  type CoordinateAuthority,
  type EngineAction,
  EngineError,
  type PreparedCoordinateAction,
} from '@agentbrowser/engine';
import {
  boundFetchResult,
  type FetchResult,
  type ProbeHeader,
  parseFetchAction,
  type ValidatedFetchAction,
} from '@agentbrowser/protocol';
import type { CDPSession, Page } from 'playwright';
import { type PageFetchLane, PROBE_NONCE_HEADER, type ProbeClaim } from './page-fetch-lane.js';
import { PageOperationLifetime } from './page-operation-lifetime.js';

const digest = (data: string) => createHash('sha256').update(data).digest('hex');

const PREPARE_MS = 15_000;
/** Whole-probe bound: approval waits happen before perform; this bounds dispatch + reads. */
const PROBE_MS = 30_000;

/**
 * ADR-030: the fixed browser fetch executed in an isolated world of the live
 * page. mode/credentials same-origin (the page origin's cookie jar applies;
 * CSRF-style headers are supplied explicitly), cache no-store, and never
 * grantUniveralAccess. The nonce header is the only engine-added field and is
 * stripped at the choke point on both lanes.
 */
const PROBE_FETCH_FUNCTION = `function (probe) {
  var headers = {};
  for (var i = 0; i < probe.headers.length; i++) headers[probe.headers[i].name] = probe.headers[i].value;
  headers[${JSON.stringify(PROBE_NONCE_HEADER)}] = probe.nonce;
  return fetch(probe.url, {
    method: probe.method,
    headers: headers,
    body: probe.body === null ? undefined : probe.body,
    credentials: 'same-origin',
    mode: 'same-origin',
    cache: 'no-store',
    redirect: 'follow'
  }).then(function (response) {
    return { dispatched: true, status: response.status };
  }).catch(function (error) {
    return { dispatched: false, error: String((error && error.message) || error) };
  });
}`;

interface DocumentPin {
  frameId: string;
  loaderId: string;
  origin: string;
}

interface ProbePlan {
  readonly token: object;
  readonly identity: string;
  readonly probe: ValidatedFetchAction;
  readonly pin: DocumentPin;
  readonly deadline: number;
  used: boolean;
  disposed: boolean;
  readonly timer: ReturnType<typeof setTimeout>;
}

const pinOf = async (cdp: CDPSession, page: Page): Promise<DocumentPin> => {
  const url = page.url();
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new EngineError(
      'INVALID_REQUEST',
      'The page has no document origin to probe from',
      false
    );
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new EngineError(
      'ENGINE_UNSUPPORTED',
      `A ${parsed.protocol.replace(':', '') || 'opaque'} document origin cannot issue probes`,
      false
    );
  }
  const tree = (await cdp.send('Page.getFrameTree')) as {
    frameTree?: { frame?: { id?: string; loaderId?: string } };
  };
  const frame = tree.frameTree?.frame;
  if (frame?.id === undefined || frame.loaderId === undefined)
    throw new EngineError('ENGINE_UNSUPPORTED', 'The live document cannot be pinned', false);
  return { frameId: frame.id, loaderId: frame.loaderId, origin: parsed.origin };
};

/**
 * One exclusive prepared probe per page: preparation pins the document (frame,
 * loader, origin) and binds the canonical request to it; the opaque token
 * conveys no wire authority and is consumed exactly once by the matching act
 * dispatch, which refuses a replaced document.
 */
export class PageFetchController {
  private plan: ProbePlan | undefined;
  private inFlight: ProbeClaim | undefined;
  private readonly pageLife = new AbortController();
  private documentLife = new AbortController();

  constructor(
    private readonly page: Page,
    private readonly getCdp: () => Promise<CDPSession | undefined>,
    private readonly lane: PageFetchLane
  ) {}

  get busy(): boolean {
    return this.plan !== undefined || this.inFlight !== undefined;
  }

  owns(token: unknown): boolean {
    return token === this.plan?.token;
  }

  /** A navigation invalidates any prepared probe: its document is gone. */
  invalidate(): void {
    this.documentLife.abort();
    this.documentLife = new AbortController();
    this.release();
  }

  close(): void {
    // Aborting the lifetime signal bounds every pending read; no flag needed.
    this.pageLife.abort();
    this.release();
  }

  private release(): void {
    const plan = this.plan;
    if (plan === undefined) return;
    plan.disposed = true;
    clearTimeout(plan.timer);
    this.plan = undefined;
  }

  private async cdp(): Promise<CDPSession> {
    const client = await this.getCdp();
    if (client === undefined)
      throw new EngineError('ENGINE_UNSUPPORTED', 'Probe transport requires a CDP session', false);
    return client;
  }

  async prepare(
    action: EngineAction,
    authority?: CoordinateAuthority
  ): Promise<PreparedCoordinateAction> {
    if (this.busy)
      throw new EngineError('SESSION_BUSY', 'Another prepared probe owns this page', false);
    const signals = [this.pageLife.signal, this.documentLife.signal];
    if (authority?.signal) signals.push(authority.signal);
    const lifetime = new PageOperationLifetime(
      AbortSignal.any(signals),
      () => authority?.assertCurrent(),
      PREPARE_MS,
      'Fetch'
    );
    try {
      lifetime.assert('fetch_prepare');
      if (action.type !== 'fetch')
        throw new EngineError('INVALID_REQUEST', 'Not a fetch action', false);
      const probe = parseFetchAction(action);
      if (!probe.ok)
        throw new EngineError(
          'INVALID_REQUEST',
          probe.issues.map((issue) => `${issue.path}: ${issue.message}`).join('; '),
          false,
          { issues: probe.issues }
        );
      const cdp = await lifetime.read('fetch_prepare_pin', () => this.cdp());
      const pin = await lifetime.read('fetch_prepare_document', () => pinOf(cdp, this.page));
      const url = new URL(probe.value.url);
      if (url.origin !== pin.origin) {
        throw new EngineError(
          'INVALID_REQUEST',
          `Probe URL ${url.origin} is not the live document origin ${pin.origin}`,
          false,
          { origin: pin.origin }
        );
      }
      const token = {};
      const timer = setTimeout(
        () => this.release(),
        Math.max(1, lifetime.deadline - performance.now())
      );
      timer.unref();
      this.plan = {
        token,
        identity: digest(
          JSON.stringify({
            probe: probe.value,
            pin: { frameId: pin.frameId, loaderId: pin.loaderId },
          })
        ),
        probe: probe.value,
        pin,
        deadline: lifetime.deadline,
        used: false,
        disposed: false,
        timer,
      };
      return { identity: this.plan.identity, token, dispose: () => this.release() };
    } finally {
      lifetime.finish();
    }
  }

  /**
   * The single dispatch. Consent commits here (beforeDispatch) at the last
   * boundary; the browser fetch runs once and its outcome is never retried.
   */
  async perform(
    token: object,
    assertCurrent: () => void,
    beforeDispatch: () => Promise<void>
  ): Promise<FetchResult> {
    const plan = this.plan;
    if (plan === undefined || plan.token !== token || plan.used || plan.disposed)
      throw new EngineError('INVALID_REQUEST', 'Fetch requires a live prepared probe', false);
    plan.used = true;
    const signals = [this.pageLife.signal, this.documentLife.signal];
    const lifetime = new PageOperationLifetime(
      AbortSignal.any(signals),
      assertCurrent,
      PROBE_MS,
      'Fetch'
    );
    let dispatched = false;
    let claim: ProbeClaim | undefined;
    try {
      lifetime.assert('fetch_dispatch');
      const cdp = await lifetime.read('fetch_dispatch_cdp', () => this.cdp());
      // Revalidate the pinned document after every asynchronous gap (approval,
      // journal): a replaced document must not inherit the pending call.
      const live = await lifetime.read('fetch_dispatch_document', () => pinOf(cdp, this.page));
      if (live.loaderId !== plan.pin.loaderId || live.frameId !== plan.pin.frameId)
        throw new EngineError(
          'STALE_TARGET',
          'The document changed; prepare the probe again',
          false
        );
      claim = this.lane.register({
        method: plan.probe.method,
        url: plan.probe.url,
        origin: plan.pin.origin,
      });
      this.inFlight = claim;
      this.release(); // consumed exactly once
      await beforeDispatch();
      lifetime.assert('fetch_dispatch');
      dispatched = true;
      const liveClaim: ProbeClaim = claim;

      const world = await lifetime.read('fetch_world', () =>
        cdp.send('Page.createIsolatedWorld', {
          frameId: plan.pin.frameId,
          grantUniveralAccess: false,
        })
      );
      const headers: ProbeHeader[] = plan.probe.headers ?? [];
      const evaluation = lifetime.read(
        'fetch_evaluate',
        () =>
          cdp.send('Runtime.callFunctionOn', {
            functionDeclaration: PROBE_FETCH_FUNCTION,
            executionContextId: (world as { executionContextId: number }).executionContextId,
            arguments: [
              {
                value: {
                  url: plan.probe.url,
                  method: plan.probe.method,
                  headers,
                  body: plan.probe.body ?? null,
                  nonce: claim?.nonce,
                },
              },
            ],
            awaitPromise: true,
            returnByValue: true,
          }),
        undefined,
        true
      );
      const settled = await lifetime.read(
        'fetch_outcome',
        () => liveClaim.done,
        undefined,
        dispatched
      );
      // The page-side promise is confirmation, not authority: the admitted
      // transport witness settles the result. Await it bounded; a rejection
      // after admission means the fulfilled bytes never reached the page.
      const pageOutcome = (await evaluation.catch(() => undefined)) as
        | { result?: { value?: { dispatched?: boolean; status?: number; error?: string } } }
        | undefined;
      const value = pageOutcome?.result?.value;
      if (settled.kind === 'denied') {
        throw new EngineError(
          'POLICY_DENIED',
          `The engagement scope denied this probe (${settled.reason})`,
          false,
          {
            ...(settled.scope !== undefined ? { scope: settled.scope } : {}),
            method: plan.probe.method,
            url: plan.probe.url,
          }
        );
      }
      if (settled.kind === 'failed') {
        throw new EngineError('INTERNAL', `The probe did not complete (${settled.detail})`, false, {
          method: plan.probe.method,
          url: plan.probe.url,
          dispatch: 'uncertain',
        });
      }
      if (value !== undefined && value.dispatched === false) {
        throw new EngineError(
          'INTERNAL',
          `The browser refused the probe (${value.error ?? 'fetch rejected'})`,
          false,
          { method: plan.probe.method, url: plan.probe.url }
        );
      }
      return boundFetchResult({
        status: settled.status,
        outcome: settled.outcome,
        headers: settled.headers,
        body: (settled.body ?? Buffer.alloc(0)).toString('utf8'),
        bodyBytes: settled.body?.length ?? 0,
      });
    } catch (error) {
      // A submitted probe is never retried here; an unresolved claim settles
      // as failed so a late admission cannot leak into a later action.
      if (claim !== undefined && !claim.settled) {
        this.lane.settle(claim, {
          kind: 'failed',
          detail: error instanceof Error ? error.message : String(error),
        });
      }
      throw error;
    } finally {
      this.inFlight = undefined;
      if (claim !== undefined) this.lane.forget(claim);
      lifetime.finish();
      if (this.plan?.token === token) this.release();
    }
  }
}
