import { STATUS_CODES } from 'node:http';
import type { BrowserContext, CDPSession, Frame, Page, Request } from 'playwright';
import { scopedResponseBody } from './scoped-response-body.js';
import { WORKER_DENIAL_CSP } from './worker-document-policy.js';

/**
 * Redirects that follow a body-bearing request (POST/PUT/PATCH) are checked
 * hop by hop in scoped sessions (T10 M1).
 *
 * Those requests go to the browser natively (`route.continue()` keeps upload
 * bodies byte-exact; a Node-side re-issue does not), and Playwright never
 * routes the redirected follow-up. Unchecked, a 307 re-sends the body to any
 * host and a 302/303 sends a GET there.
 *
 * The guard holds its own CDP session per target (each page, and each
 * out-of-process iframe it can attach to) with request- and response-stage
 * `Fetch` interception. Chromium runs that interceptor before Playwright's
 * route handler. Two rules follow:
 *
 * - **Every hop is checked.** Each body-bearing request the guard sees opens a
 *   chain keyed by Chromium's `networkId`, which stays the same across every
 *   redirect of that request (URLs do not: Chromium strips fragments and
 *   re-encodes characters). Each 3xx in the chain gets a fresh policy verdict,
 *   the shared hop cap and loop detection; a denied hop fails the request
 *   before the browser follows it. This does not depend on the route handler.
 * - **Unseen requests are refused.** `track()` reports true only when the
 *   guard on the request's own target saw it at the request stage; otherwise
 *   the caller refuses the request (fail closed).
 *
 * Every request and response in a guarded target pauses once each, so this
 * runs only where a policy requires it (an engagement scope).
 */

export interface RedirectVerdict {
  verdict: 'allow' | 'deny';
  reason?: string;
  /** The engagement-scope sub-code when the scope denied (T10 M2). */
  scope?: string;
}

export interface BodyRedirectGuardOptions {
  /** Scoped contexts disallow workers, including native POST document commits. */
  blockDocumentWorkers?: boolean;
  headersForRequest?(url: string, headers: Record<string, string>): Record<string, string>;
  onInjection?(url: string): void;
  verdictOf(
    hostname: string,
    url: string,
    context: { method: string; headers: Record<string, string> }
  ): Promise<RedirectVerdict>;
  /**
   * Record a blocked hop. `root` is the routed request that started the chain
   * when the route handler claimed it.
   */
  onBlocked(
    root: Request | undefined,
    detail: { reason: string; redirect?: string; detail?: string; scope?: string }
  ): void;
  maxHops: number;
  /** Live chains per target; past it new body-bearing requests are refused. */
  maxChains?: number;
  /**
   * T10 M2: every response this guard pauses in a tracked chain, as an
   * outcome (origin+path only): finished with its status (and the allowed
   * redirect target), failed, or blocked. The engagement ledger's source for
   * body-bearing requests and their hops.
   */
  onOutcome?(outcome: {
    type: 'request.finished' | 'request.failed';
    data: Record<string, unknown>;
  }): void;
}

interface Chain {
  networkId: string;
  key: string;
  /** The hop in flight (method and full URL), for an outcome reported without a response. */
  current: { method: string; url: string };
  root?: Request;
  headers: Record<string, string>;
  hops: number;
  seen: Set<string>;
}

interface GuardTarget {
  cdp: CDPSession;
  /** Body-bearing chains this target saw, by Chromium network id (insertion-ordered). */
  chains: Map<string, Chain>;
  /** Network ids of chains not yet claimed by the route handler, by method and URL. */
  unclaimed: Map<string, string[]>;
}

type PausedEvent = {
  requestId: string;
  networkId?: string;
  resourceType?: string;
  request: { url: string; method: string; headers?: Record<string, string> };
  responseStatusCode?: number;
  responseStatusText?: string;
  responseErrorReason?: string;
  responseHeaders?: Array<{ name: string; value: string }>;
};

const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH']);
/**
 * Live chains per target. A chain closes when its request finishes or fails;
 * a full table refuses new body-bearing requests (fail closed) and never
 * evicts a live chain, whose redirect would then go unchecked.
 */
const MAX_TRACKED_CHAINS = 4096;

const keyOf = (method: string, url: string): string => `${method.toUpperCase()} ${url}`;

/** The method the browser uses for the next hop (Fetch standard, 4.4). */
export function followMethod(status: number, method: string): string {
  if (status === 307 || status === 308) return method;
  if (status === 303) return method === 'HEAD' ? 'HEAD' : 'GET';
  return method === 'POST' ? 'GET' : method;
}

export class BodyRedirectGuard {
  private readonly pageTargets = new WeakMap<Page, GuardTarget>();
  private readonly frameTargets = new WeakMap<Frame, GuardTarget>();
  private readonly frameAttach = new WeakMap<Frame, Promise<void>>();
  private readonly watched = new WeakSet<Page>();
  /** Every target, so open chains can be reported when the session closes. */
  private readonly allTargets = new Set<GuardTarget>();
  private readonly pageReady = new WeakMap<Page, Promise<void>>();

  constructor(
    private readonly context: BrowserContext,
    private readonly options: BodyRedirectGuardOptions
  ) {
    context.on('page', (page) => this.watchPage(page));
    for (const page of context.pages()) this.watchPage(page);
  }

  /**
   * Claim a body-bearing request before it is continued. True means the guard
   * on this request's own target saw it at the request stage, so its
   * redirects are checked; false means they would not be, and the caller
   * must refuse the request.
   */
  track(request: Request): boolean {
    let frame: Frame;
    try {
      frame = request.frame();
    } catch {
      return false; // no frame: no guarded target to attribute it to
    }
    const target = this.targetOf(frame);
    if (target === undefined) return false;
    const key = keyOf(request.method(), request.url());
    const ids = target.unclaimed.get(key);
    const networkId = ids?.shift();
    if (ids !== undefined && ids.length === 0) target.unclaimed.delete(key);
    const chain = networkId === undefined ? undefined : target.chains.get(networkId);
    if (chain === undefined) return false;
    chain.root = request;
    return true;
  }

  /**
   * Resolves once this page's guard is armed, so a page handed to a caller
   * does not start with requests the guard cannot see (they would be refused).
   */
  ready(page: Page): Promise<void> {
    this.watchPage(page);
    return this.pageReady.get(page) ?? Promise.resolve();
  }

  /**
   * Reports every chain still open as a failed outcome, then forgets it. Called
   * before the browser context closes: a request whose end the guard never saw
   * (an aborted worker POST — its loadingFailed fires on the worker target — or
   * one in flight at close) is recorded rather than lost, with that said.
   */
  recordUnfinished(): void {
    for (const target of this.allTargets) {
      for (const chain of [...target.chains.values()]) {
        const at = new URL(chain.current.url);
        try {
          this.options.onOutcome?.({
            type: 'request.failed',
            data: {
              url: `${at.origin}${at.pathname}`,
              hostname: at.hostname,
              method: chain.current.method,
              reason: 'engine_error',
              detail: 'no outcome observed (recorded at close)',
            },
          });
        } catch {}
        this.close(target, chain);
      }
    }
  }

  /** The target that intercepts this frame's requests: its own if out of process. */
  private targetOf(frame: Frame): GuardTarget | undefined {
    for (let current: Frame | null = frame; current !== null; current = current.parentFrame()) {
      const own = this.frameTargets.get(current);
      if (own !== undefined) return own;
      if (current.parentFrame() === null) return this.pageTargets.get(current.page());
    }
    return undefined;
  }

  private watchPage(page: Page): void {
    if (this.watched.has(page)) return;
    this.watched.add(page);
    this.pageReady.set(
      page,
      this.attach(() => this.context.newCDPSession(page)).then(
        (target) => {
          this.pageTargets.set(page, target);
        },
        () => {}
      )
    );
    const watchFrame = (frame: Frame) => {
      if (frame.parentFrame() === null) return;
      // Only an out-of-process iframe has its own target; the attempt fails
      // for a same-process frame, which its parent's target covers. A
      // navigation can move a frame between processes, so recheck on each.
      const previous = this.frameAttach.get(frame) ?? Promise.resolve();
      const next = previous.then(() =>
        this.attach(() => this.context.newCDPSession(frame)).then(
          (target) => {
            this.frameTargets.set(frame, target);
          },
          () => {
            this.frameTargets.delete(frame);
          }
        )
      );
      this.frameAttach.set(frame, next);
    };
    page.on('frameattached', watchFrame);
    page.on('framenavigated', watchFrame);
  }

  private async attach(open: () => Promise<CDPSession>): Promise<GuardTarget> {
    const cdp = await open();
    const target: GuardTarget = { cdp, chains: new Map(), unclaimed: new Map() };
    this.allTargets.add(target);
    cdp.on('Fetch.requestPaused', (event: PausedEvent) => {
      void this.paused(target, event).catch(() => {});
    });
    // A request that is aborted, hangs up or fails never reaches the response
    // stage; the Network domain reports its end, which frees its chain.
    const ended = (event: { requestId: string }) => {
      const chain = target.chains.get(event.requestId);
      if (chain !== undefined) this.close(target, chain);
    };
    // A request aborted, hung up or failed before any response never reaches the
    // response stage: its only end is loadingFailed, which is its recorded outcome.
    const failed = (event: { requestId: string; errorText?: string; canceled?: boolean }) => {
      const chain = target.chains.get(event.requestId);
      if (chain === undefined) return;
      const at = new URL(chain.current.url);
      try {
        this.options.onOutcome?.({
          type: 'request.failed',
          data: {
            url: `${at.origin}${at.pathname}`,
            hostname: at.hostname,
            method: chain.current.method,
            reason: 'engine_error',
            detail: event.canceled === true ? 'canceled' : (event.errorText ?? 'failed'),
          },
        });
      } catch {}
      this.close(target, chain);
    };
    cdp.on('Network.loadingFailed', failed);
    cdp.on('Network.loadingFinished', ended);
    await cdp.send('Network.enable', { maxTotalBufferSize: 0, maxResourceBufferSize: 0 });
    await cdp.send('Fetch.enable', {
      patterns: [
        { urlPattern: '*', requestStage: 'Request' as const },
        { urlPattern: '*', requestStage: 'Response' as const },
      ],
    });
    return target;
  }

  private open(target: GuardTarget, event: PausedEvent, networkId: string): void {
    const key = keyOf(event.request.method, event.request.url);
    const chain: Chain = {
      networkId,
      key,
      current: { method: event.request.method, url: event.request.url },
      headers: { ...(event.request.headers ?? {}) },
      hops: 0,
      seen: new Set([event.request.url]),
    };
    target.chains.set(networkId, chain);
    target.unclaimed.set(key, [...(target.unclaimed.get(key) ?? []), networkId]);
  }

  private close(target: GuardTarget, chain: Chain): void {
    target.chains.delete(chain.networkId);
    const ids = target.unclaimed.get(chain.key);
    if (ids === undefined) return;
    const remaining = ids.filter((id) => id !== chain.networkId);
    if (remaining.length === 0) target.unclaimed.delete(chain.key);
    else target.unclaimed.set(chain.key, remaining);
  }

  private async paused(target: GuardTarget, event: PausedEvent): Promise<void> {
    const { cdp } = target;
    const networkId = event.networkId;
    if (event.responseStatusCode === undefined && event.responseErrorReason === undefined) {
      // A redirect follow-up keeps its network id: it belongs to the open chain.
      if (
        networkId !== undefined &&
        !target.chains.has(networkId) &&
        BODY_METHODS.has(event.request.method.toUpperCase())
      ) {
        if (target.chains.size >= (this.options.maxChains ?? MAX_TRACKED_CHAINS)) {
          // Full: refuse rather than track it without room (fail closed).
          try {
            this.options.onBlocked(undefined, {
              reason: 'egress_policy',
              detail: 'REDIRECT_UNCHECKABLE',
            });
          } catch {}
          await cdp
            .send('Fetch.failRequest', {
              requestId: event.requestId,
              errorReason: 'BlockedByClient',
            })
            .catch(() => {});
          return;
        }
        this.open(target, event, networkId);
      }
      const chain = networkId === undefined ? undefined : target.chains.get(networkId);
      // Native bodies use per-hop CDP overrides, including the initial hop.
      // Playwright route.continue({headers}) persists overrides across redirects
      // and would reapply an old marker after this guard stripped it.
      try {
        const headers = chain
          ? this.options.headersForRequest?.(
              event.request.url,
              event.request.headers ?? chain.headers
            )
          : undefined;
        if (headers && chain && chain.hops > 0) this.options.onInjection?.(event.request.url);
        await cdp.send('Fetch.continueRequest', {
          requestId: event.requestId,
          ...(headers
            ? { headers: Object.entries(headers).map(([name, value]) => ({ name, value })) }
            : {}),
        });
      } catch {
        // A failed transform/continue must never release the original headers.
        const at = new URL(event.request.url);
        try {
          this.options.onOutcome?.({
            type: 'request.failed',
            data: {
              url: at.origin + at.pathname,
              hostname: at.hostname,
              method: event.request.method,
              reason: 'egress_policy',
              detail: 'REQUEST_HEADERS_UNCHECKABLE',
            },
          });
        } catch {}
        if (chain) this.close(target, chain);
        await cdp
          .send('Fetch.failRequest', { requestId: event.requestId, errorReason: 'BlockedByClient' })
          .catch(() => {});
      }
      return;
    }
    const responseStatus = event.responseStatusCode ?? 0;
    const responseLocation = event.responseHeaders?.find(
      (header) => header.name.toLowerCase() === 'location'
    )?.value;
    const browserRedirect =
      [301, 302, 303, 307, 308].includes(responseStatus) && responseLocation !== undefined;
    const proceed = async () => {
      try {
        if (event.responseErrorReason !== undefined) {
          await cdp.send('Fetch.continueRequest', { requestId: event.requestId });
        } else if (
          this.options.blockDocumentWorkers &&
          !browserRedirect &&
          ![204, 205, 304].includes(event.responseStatusCode ?? 0)
        ) {
          const body = await scopedResponseBody(cdp, event.requestId);
          await cdp.send('Fetch.fulfillRequest', {
            requestId: event.requestId,
            // Explicit decoded response bytes make Chromium apply the CSP override.
            // The original upload request was continued byte-exactly.
            body: body.toString('base64'),
            responseCode: event.responseStatusCode ?? 200,
            responsePhrase:
              event.responseStatusText ?? STATUS_CODES[event.responseStatusCode ?? 200] ?? '',
            responseHeaders: [
              ...(event.responseHeaders ?? []).filter(
                (header) =>
                  ![
                    'content-security-policy',
                    'content-length',
                    'content-encoding',
                    'transfer-encoding',
                  ].includes(header.name.toLowerCase())
              ),
              { name: 'Content-Length', value: String(body.length) },
              {
                name: 'Content-Security-Policy',
                value: [
                  ...(event.responseHeaders ?? [])
                    .filter((header) => header.name.toLowerCase() === 'content-security-policy')
                    .map((header) => header.value),
                  WORKER_DENIAL_CSP,
                ].join(', '),
              },
            ],
          });
        } else {
          await cdp.send('Fetch.continueResponse', { requestId: event.requestId });
        }
      } catch {
        throw new Error('POLICY_HEADERS_UNCHECKABLE');
      }
    };
    const chain = networkId === undefined ? undefined : target.chains.get(networkId);
    if (chain === undefined) {
      try {
        await proceed();
      } catch {
        const at = new URL(event.request.url);
        try {
          this.options.onOutcome?.({
            type: 'request.failed',
            data: {
              url: at.origin + at.pathname,
              hostname: at.hostname,
              method: event.request.method,
              blocked: true,
              reason: 'egress_policy',
              detail: 'POLICY_HEADERS_UNCHECKABLE',
            },
          });
        } catch {}
        await cdp
          .send('Fetch.failRequest', { requestId: event.requestId, errorReason: 'BlockedByClient' })
          .catch(() => {});
      }
      return;
    }
    const at = new URL(event.request.url);
    const base = {
      url: `${at.origin}${at.pathname}`,
      hostname: at.hostname,
      method: event.request.method,
      ...(event.resourceType !== undefined
        ? { resourceType: event.resourceType.toLowerCase() }
        : {}),
    };
    const outcome = (
      type: 'request.finished' | 'request.failed',
      data: Record<string, unknown>
    ) => {
      try {
        this.options.onOutcome?.({ type, data: { ...base, ...data } });
      } catch {}
    };
    const fail = (detail: {
      reason: string;
      redirect?: string;
      detail?: string;
      scope?: string;
    }) => {
      outcome('request.failed', { blocked: true, ...detail });
      this.close(target, chain);
      try {
        this.options.onBlocked(chain.root, detail);
      } catch {}
      return cdp
        .send('Fetch.failRequest', { requestId: event.requestId, errorReason: 'BlockedByClient' })
        .catch(() => {});
    };
    try {
      const status = responseStatus;
      const location = responseLocation;
      if (event.responseErrorReason !== undefined) {
        outcome('request.failed', { reason: 'engine_error', detail: event.responseErrorReason });
        this.close(target, chain);
        await proceed();
        return;
      }
      if (!browserRedirect || location === undefined) {
        await proceed();
        outcome('request.finished', { status });
        this.close(target, chain);
        return;
      }
      const next = new URL(location, event.request.url);
      const redirect = next.origin + next.pathname;
      chain.hops += 1;
      if (chain.hops > this.options.maxHops) {
        await fail({
          reason: 'egress_policy',
          redirect,
          detail: `MAX_REDIRECTS (${chain.hops - 1} hops)`,
        });
        return;
      }
      const hopKey = next.origin + next.pathname + next.search;
      if (chain.seen.has(hopKey)) {
        await fail({ reason: 'egress_policy', redirect, detail: 'REDIRECT_LOOP' });
        return;
      }
      chain.seen.add(hopKey);
      const hop = await this.options.verdictOf(next.hostname, next.href, {
        method: followMethod(status, event.request.method),
        headers: chain.headers,
      });
      if (hop.verdict === 'deny') {
        await fail({
          reason: hop.reason ?? 'egress_policy',
          redirect,
          ...(hop.scope !== undefined ? { scope: hop.scope } : {}),
        });
        return;
      }
      chain.current = { method: followMethod(status, event.request.method), url: next.href };
      await proceed();
      outcome('request.finished', { status, redirect });
    } catch (error) {
      // Fail closed: a hop the guard could not judge is not followed.
      await fail({
        reason: 'egress_policy',
        detail:
          error instanceof Error && error.message === 'POLICY_HEADERS_UNCHECKABLE'
            ? 'POLICY_HEADERS_UNCHECKABLE'
            : 'REDIRECT_UNCHECKABLE',
      });
    }
  }
}
