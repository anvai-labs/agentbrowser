import type { BrowserContext, CDPSession, Frame, Page, Request } from 'playwright';

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
 * route handler, so a request the guard saw at the request stage is one whose
 * response it will also see. The rule is therefore exact and fails closed:
 *
 * - a body-bearing request is continued only if the guard already saw it;
 *   otherwise `track()` reports false and the caller refuses the request;
 * - each paused redirect of a tracked chain gets a fresh policy verdict, the
 *   shared hop cap and loop detection; a denied hop fails the request before
 *   the browser follows it.
 *
 * Every request and response in a guarded target pauses once, so this runs
 * only where a policy requires it (an engagement scope).
 */

export interface RedirectVerdict {
  verdict: 'allow' | 'deny';
  reason?: string;
}

export interface BodyRedirectGuardOptions {
  verdictOf(
    hostname: string,
    url: string,
    context: { method: string; headers: Record<string, string> }
  ): Promise<RedirectVerdict>;
  /** Record a blocked hop against the request that started the chain. */
  onBlocked(root: Request, detail: { reason: string; redirect?: string; detail?: string }): void;
  maxHops: number;
}

interface Chain {
  root: Request;
  headers: Record<string, string>;
  hops: number;
  seen: Set<string>;
  keys: Set<string>;
  target: GuardTarget;
}

interface GuardTarget {
  cdp: CDPSession;
  /** Body-bearing requests seen at the request stage, not yet claimed. */
  seen: Map<string, number[]>;
  /** Tracked redirect chains, by the next hop's method and URL. */
  pending: Map<string, Chain>;
}

type PausedEvent = {
  requestId: string;
  request: { url: string; method: string };
  responseStatusCode?: number;
  responseErrorReason?: string;
  responseHeaders?: Array<{ name: string; value: string }>;
};

const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH']);
/** A seen request the route handler never claimed (denied, aborted) expires. */
const SEEN_TTL_MS = 60_000;

const keyOf = (method: string, url: string): string => `${method.toUpperCase()} ${url}`;

/** The method the browser uses for the next hop (Fetch standard, 4.4). */
export function followMethod(status: number, method: string): string {
  if (status === 307 || status === 308) return method;
  if (status === 303) return method === 'HEAD' ? 'HEAD' : 'GET';
  return method === 'POST' ? 'GET' : method;
}

export class BodyRedirectGuard {
  private readonly targets = new WeakMap<Page, GuardTarget[]>();
  private readonly frames = new WeakMap<Frame, Promise<void>>();
  private readonly chains = new WeakMap<Request, Chain>();

  constructor(
    private readonly context: BrowserContext,
    private readonly options: BodyRedirectGuardOptions
  ) {
    context.on('page', (page) => this.watchPage(page));
    for (const page of context.pages()) this.watchPage(page);
    const settle = (request: Request) => {
      let root: Request = request;
      for (let from = root.redirectedFrom(); from !== null; from = from.redirectedFrom()) {
        root = from;
      }
      const chain = this.chains.get(root);
      if (chain === undefined) return;
      this.chains.delete(root);
      for (const key of chain.keys) {
        if (chain.target.pending.get(key) === chain) chain.target.pending.delete(key);
      }
      chain.keys.clear();
    };
    // Playwright also finishes each redirecting request of a chain; the chain
    // ends with a response that is not a redirect, or with a failure.
    context.on('requestfinished', (request) => {
      void request
        .response()
        .then((response) => {
          const status = response?.status() ?? 0;
          if (!(status >= 300 && status < 400)) settle(request);
        })
        .catch(() => settle(request));
    });
    context.on('requestfailed', settle);
  }

  /**
   * Claim a body-bearing request before it is continued. True means the guard
   * saw it at the request stage, so its redirects will be checked; false
   * means they would not be, and the caller must refuse the request.
   */
  track(request: Request): boolean {
    let page: Page;
    try {
      page = request.frame().page();
    } catch {
      return false; // worker or service-worker request: no guarded target
    }
    const key = keyOf(request.method(), request.url());
    for (const target of this.targets.get(page) ?? []) {
      const times = target.seen.get(key);
      if (times === undefined || times.length === 0) continue;
      times.shift();
      if (times.length === 0) target.seen.delete(key);
      const chain: Chain = {
        root: request,
        headers: request.headers(),
        hops: 0,
        seen: new Set([request.url()]),
        keys: new Set([key]),
        target,
      };
      target.pending.set(key, chain);
      this.chains.set(request, chain);
      return true;
    }
    return false;
  }

  private watchPage(page: Page): void {
    if (this.targets.has(page)) return;
    this.targets.set(page, []);
    void this.attach(page, () => this.context.newCDPSession(page)).catch(() => {});
    const watchFrame = (frame: Frame) => {
      if (frame.parentFrame() === null) return;
      // Only an out-of-process iframe has its own target; the attempt fails
      // for a same-process frame, which the page's target already covers.
      // A navigation can move a frame to a new process, so retry on each.
      const previous = this.frames.get(frame) ?? Promise.resolve();
      const next = previous.then(() =>
        this.attach(page, () => this.context.newCDPSession(frame)).catch(() => {})
      );
      this.frames.set(frame, next);
    };
    page.on('frameattached', watchFrame);
    page.on('framenavigated', watchFrame);
  }

  private async attach(page: Page, open: () => Promise<CDPSession>): Promise<void> {
    const cdp = await open();
    const target: GuardTarget = { cdp, seen: new Map(), pending: new Map() };
    cdp.on('Fetch.requestPaused', (event: PausedEvent) => {
      void this.paused(target, event);
    });
    // Registered before enabling, so no request seen by this session is missed.
    this.targets.get(page)?.push(target);
    await cdp.send('Fetch.enable', {
      patterns: [
        { urlPattern: '*', requestStage: 'Request' as const },
        { urlPattern: '*', requestStage: 'Response' as const },
      ],
    });
  }

  private async paused(target: GuardTarget, event: PausedEvent): Promise<void> {
    const { cdp } = target;
    const key = keyOf(event.request.method, event.request.url);
    if (event.responseStatusCode === undefined && event.responseErrorReason === undefined) {
      if (BODY_METHODS.has(event.request.method.toUpperCase())) {
        const now = Date.now();
        const times = (target.seen.get(key) ?? []).filter((at) => now - at < SEEN_TTL_MS);
        times.push(now);
        target.seen.set(key, times);
      }
      await cdp.send('Fetch.continueRequest', { requestId: event.requestId }).catch(() => {});
      return;
    }
    const proceed = () =>
      (event.responseErrorReason !== undefined
        ? cdp.send('Fetch.continueRequest', { requestId: event.requestId })
        : cdp.send('Fetch.continueResponse', { requestId: event.requestId })
      ).catch(() => {});
    const chain = target.pending.get(key);
    if (chain === undefined || event.responseErrorReason !== undefined) {
      await proceed();
      return;
    }
    target.pending.delete(key);
    chain.keys.delete(key);
    const fail = (detail: { reason: string; redirect?: string; detail?: string }) => {
      this.options.onBlocked(chain.root, detail);
      return cdp
        .send('Fetch.failRequest', { requestId: event.requestId, errorReason: 'BlockedByClient' })
        .catch(() => {});
    };
    try {
      const status = event.responseStatusCode ?? 0;
      const location = event.responseHeaders?.find(
        (header) => header.name.toLowerCase() === 'location'
      )?.value;
      if (!(status >= 300 && status < 400 && location !== undefined)) {
        await proceed();
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
      if (chain.seen.has(next.href)) {
        await fail({ reason: 'egress_policy', redirect, detail: 'REDIRECT_LOOP' });
        return;
      }
      chain.seen.add(next.href);
      const method = followMethod(status, event.request.method);
      const hop = await this.options.verdictOf(next.hostname, next.href, {
        method,
        headers: chain.headers,
      });
      if (hop.verdict === 'deny') {
        await fail({ reason: hop.reason ?? 'egress_policy', redirect });
        return;
      }
      const nextKey = keyOf(method, next.href);
      target.pending.set(nextKey, chain);
      chain.keys.add(nextKey);
      await proceed();
    } catch {
      // Fail closed: a hop the guard could not judge is not followed.
      await fail({ reason: 'egress_policy', detail: 'REDIRECT_UNCHECKABLE' });
    }
  }
}
