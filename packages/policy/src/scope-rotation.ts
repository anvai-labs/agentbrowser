import { NetworkPolicyError } from './network-policy.js';

/**
 * Glob (`*` = within one path segment, `**` = anything) or `/regex/flags`,
 * anchored at both ends. The one URL-pattern convention across the product:
 * the wait `urlPattern` condition and the rotation advisor (P1-6a) compile
 * through this so the spellings cannot drift apart. Throws on a syntactically
 * invalid regex body — a bad pattern is a configuration error, never a
 * silently-never-matching rule.
 */
export function compileUrlPattern(pattern: string): RegExp {
  const regexForm = /^\/(.*)\/([a-z]*)$/.exec(pattern);
  if (regexForm) {
    try {
      return new RegExp(regexForm[1] ?? '', regexForm[2] ?? '');
    } catch {
      throw new NetworkPolicyError(
        'POLICY_DENIED',
        `URL pattern regex is invalid: ${pattern}`,
        false,
        { rule: 'urlpattern.invalid' }
      );
    }
  }
  const source = pattern
    .split('*')
    .map((segment) => segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join(pattern.includes('**') ? '[\\s\\S]*' : '[^/]*');
  return new RegExp(`^${source}$`);
}

/** P1-6a (ADR-033): the advisory emitted when a refresh bounce is followed by
 * an auth rejection on the identity endpoint — exactly once per session. */
export interface RotationAdvisory {
  readonly event: 'auth.rotation-suspected';
  /** Origin+path of the navigation that armed the detection (query never recorded). */
  readonly refresh: string;
  /** Origin+path of the 401/403 identity response (query never recorded). */
  readonly identity: string;
  /** The rejection status that completed the signature (401 or 403). */
  readonly status: number;
}

/** Same-page request outcomes after the refresh navigation that still count
 * as "followed by" (ADR-033's bounded window). */
const ROTATION_WINDOW_REQUESTS = 20;

/**
 * P1-6a (ADR-033): advisory-only auth-rotation detection, fed request
 * outcomes at the choke point. Operator-configured patterns, never inferred:
 * a navigation matching the refresh pattern followed (same page, bounded
 * window) by a 401/403 response matching the identity pattern completes the
 * signature and fires once. Advisory only — no DOM identity inference, no
 * automatic login, no scope change, no auto-reseed; it never gates traffic.
 *
 * Records without a page attribution (the redirect walker's hop records,
 * probes) are ignored; outcomes on other pages neither advance nor expire a
 * page's window. A repeated refresh navigation re-arms and restarts the
 * window while nothing has fired — bounce loops navigate repeatedly.
 */
export class RotationAdvisor {
  private readonly refresh: RegExp;
  private readonly identity: RegExp;
  private fired = false;
  private armed: { pageKey: number; remaining: number; navigation: string } | undefined;

  constructor(config: { refreshUrlPattern: string; identityUrlPattern: string }) {
    this.refresh = compileUrlPattern(config.refreshUrlPattern);
    this.identity = compileUrlPattern(config.identityUrlPattern);
  }

  /** True once the signature has completed; sticks until the session ends. */
  suspected(): boolean {
    return this.fired;
  }

  /**
   * Feed one request outcome (the engine's request-record data). Returns the
   * advisory exactly once — when the signature completes — for the caller to
   * ledger; undefined otherwise (including when it already fired).
   */
  noteOutcome(
    type: 'request.finished' | 'request.failed' | 'request.headersInjected',
    data: { url?: unknown; resourceType?: unknown; status?: unknown; pageKey?: unknown }
  ): RotationAdvisory | undefined {
    if (this.fired || type === 'request.headersInjected') return undefined;
    // Unattributed records cannot honour "same page"; ignore rather than guess.
    const pageKey = data.pageKey;
    if (typeof pageKey !== 'number') return undefined;
    const url = typeof data.url === 'string' ? data.url : '';
    const armed = this.armed;
    if (armed !== undefined && armed.pageKey === pageKey) {
      const status = data.status;
      if (
        type === 'request.finished' &&
        (status === 401 || status === 403) &&
        this.identity.test(url)
      ) {
        this.fired = true;
        this.armed = undefined;
        return {
          event: 'auth.rotation-suspected',
          refresh: armed.navigation,
          identity: url,
          status,
        };
      }
      armed.remaining -= 1;
      if (armed.remaining <= 0) this.armed = undefined;
    }
    if (type === 'request.finished' && data.resourceType === 'document' && this.refresh.test(url)) {
      this.armed = { pageKey, remaining: ROTATION_WINDOW_REQUESTS, navigation: url };
    }
    return undefined;
  }
}
