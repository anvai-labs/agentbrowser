import { NetworkPolicyError } from './network-policy.js';
import type { RedirectRequest } from './network-policy.js';

/**
 * T7 slice 2: engagement scope enforcement for authorized security
 * testing. A stateful RequestPolicy decorator composed OVER the
 * session's base policy: scope rules can only RESTRICT, the base always
 * runs. Designed for the choke point's per-request call — including
 * every redirect hop of the Node-side chain walk, so no hop is a free
 * ride.
 *
 * Coverage boundary (stated, not hidden): page-routed traffic only —
 * the same boundary as the egress choke point itself; worker traffic
 * outside Playwright routing and the operator cdp-attach lane are not
 * scope-checked, and this is application-layer enforcement, not the
 * OS-level pairing hostile multi-tenancy requires (T7 prerequisite).
 */

export interface ScopePathRule {
  /** Host this rule binds (exact or ".suffix"). Absent = any allowed host. */
  hostSuffix?: string;
  /** Pathname prefix that is in scope for the bound host. */
  prefix: string;
}

export interface ScopeIdentityBinding {
  /** Header name (lowercase-compared) carrying the identity marker. */
  header: string;
  /** Exact header value identifying the authorized identity. */
  value: string;
  /** Hosts (exact or ".suffix") this identity is authorized on. */
  allowedHosts: string[];
}

export interface EngagementScopeOptions {
  /** Exhaustive when set: exact hosts and ".suffix" entries in scope. */
  allowedHosts: string[];
  /** Pathname rules; absent = all paths on allowed hosts. */
  pathRules?: ScopePathRule[];
  /** Uppercase-compared method allowlist; absent = all methods. */
  allowedMethods?: string[];
  /** Epoch ms after which every check denies (SCOPE_EXPIRED). */
  expiresAt?: number;
  /** Injected clock for movement-testable expiry (default Date.now). */
  now?: () => number;
  /** Total choke-point requests in scope, redirect hops included. */
  requestBudget?: number;
  /** Identity markers that must not leave their bound hosts. */
  identityBindings?: ScopeIdentityBinding[];
}

const DENIED = 'POLICY_DENIED' as const;

const hostMatches = (hostname: string, pattern: string): boolean => {
  const host = hostname.toLowerCase();
  if (pattern.startsWith('.')) {
    // Aligned with SessionHostPolicy's suffix semantics: ".example.com"
    // matches SUBDOMAINS ONLY — list the apex explicitly alongside it
    // when both are in scope.
    return host.endsWith(pattern);
  }
  return host === pattern;
};

const scopeDenial = (subCode: string, detail: string): NetworkPolicyError =>
  new NetworkPolicyError(DENIED, `${subCode}: ${detail}`, false, { scope: subCode });

export class EngagementScopePolicy {
  private readonly allowed: string[];
  private readonly paths: ScopePathRule[];
  private readonly methods: Set<string> | undefined;
  private readonly identities: ScopeIdentityBinding[];
  private readonly expiresAt: number | undefined;
  private readonly now: () => number;
  private readonly budget: number | undefined;
  private spent = 0;
  /** Hops already spent by checkRedirectChain — callers may re-submit the
   * accumulated chain per redirect (the download transport does), and the
   * budget must charge a hop once, not once per resubmission. */
  private readonly chainSpent = new Set<string>();

  constructor(
    private readonly base: {
      checkRequest(request: {
        hostname: string;
        url?: string;
        method?: string;
        headers?: Record<string, string>;
      }): Promise<void>;
      checkRedirectChain?(requests: Array<{ url: string; hostname?: string }>): Promise<void>;
      checkResponse?(response: { headers: Record<string, string> }): Promise<void>;
      checkBodySize?(bytes: number): Promise<void>;
      checkResolvedAddresses?(addresses: string[]): Promise<void>;
    },
    scope: EngagementScopeOptions
  ) {
    this.allowed = scope.allowedHosts.map((host) => host.toLowerCase());
    this.paths = scope.pathRules ?? [];
    this.methods =
      scope.allowedMethods !== undefined
        ? new Set(scope.allowedMethods.map((m) => m.toUpperCase()))
        : undefined;
    this.identities = scope.identityBindings ?? [];
    this.expiresAt = scope.expiresAt;
    this.now = scope.now ?? Date.now;
    this.budget = scope.requestBudget;
  }

  private denyIf(request: {
    hostname: string;
    url?: string;
    method?: string;
    headers?: Record<string, string>;
  }): void {
    if (this.expiresAt !== undefined && this.now() >= this.expiresAt) {
      throw scopeDenial('SCOPE_EXPIRED', `engagement scope expired at ${this.expiresAt}`);
    }
    if (this.budget !== undefined && this.spent >= this.budget) {
      throw scopeDenial(
        'SCOPE_BUDGET_EXHAUSTED',
        `request budget ${this.budget} spent (denying further traffic)`
      );
    }
    const hostname = request.hostname.toLowerCase();
    if (!this.allowed.some((pattern) => hostMatches(hostname, pattern))) {
      throw scopeDenial('SCOPE_HOST_DENIED', `host ${hostname} is outside the engagement scope`);
    }
    if (this.methods !== undefined) {
      const method = request.method?.toUpperCase();
      if (method === undefined || !this.methods.has(method)) {
        throw scopeDenial(
          'SCOPE_METHOD_DENIED',
          `method ${method ?? '(absent)'} is outside the engagement scope`
        );
      }
    }
    if (this.paths.length > 0) {
      const pathname = request.url !== undefined ? new URL(request.url).pathname : '/';
      // Rules bind their own hosts: a host with no binding rule is fully
      // in scope for paths. Prefixes match on path-SEGMENT boundaries —
      // prefix "/api" admits "/api" and "/api/users" but never "/apix" —
      // so a bare prefix cannot silently expand the engagement scope.
      const boundRules = this.paths.filter(
        (rule) => rule.hostSuffix === undefined || hostMatches(hostname, rule.hostSuffix)
      );
      const inPath =
        boundRules.length === 0 ||
        boundRules.some(
          (rule) =>
            pathname === rule.prefix ||
            (pathname.startsWith(rule.prefix) &&
              (rule.prefix.endsWith('/') || pathname.charAt(rule.prefix.length) === '/'))
        );
      if (!inPath) {
        throw scopeDenial('SCOPE_PATH_DENIED', `path ${pathname} is outside the engagement scope`);
      }
    }
    for (const binding of this.identities) {
      const carried = request.headers?.[binding.header.toLowerCase()];
      if (carried === binding.value) {
        const bound = binding.allowedHosts.some((pattern) => hostMatches(hostname, pattern));
        if (!bound) {
          throw scopeDenial(
            'SCOPE_IDENTITY_DENIED',
            `identity bound to [${binding.allowedHosts.join(', ')}] would leak to ${hostname}`
          );
        }
      }
    }
  }

  async checkRequest(request: {
    hostname: string;
    url?: string;
    method?: string;
    headers?: Record<string, string>;
  }): Promise<void> {
    // Deny-if runs BEFORE the spend: denied attempts consume no budget.
    this.denyIf(request);
    if (this.budget !== undefined) {
      this.spent += 1;
    }
    await this.base.checkRequest(request);
  }

  /**
   * Service-side preflight: the full denial checks (a spent budget
   * included) WITHOUT consuming budget — the choke point spends when the
   * request actually flows, so a navigation is not double-charged by the
   * service preflight plus the wire-level check.
   */
  async preflightCheck(request: {
    hostname: string;
    url?: string;
    method?: string;
    headers?: Record<string, string>;
  }): Promise<void> {
    this.denyIf(request);
  }

  async checkRedirectChain(
    requests: Array<{ url: string; hostname?: string; method?: string }>
  ): Promise<void> {
    // Per-hop checkRequest deliberately SUBSUMES base chain-level logic
    // (each hop gets the full scope + base request verdict); a base
    // checkRedirectChain is not double-invoked. The engine's walker
    // calls checkRequest per hop; the download lane re-submits the
    // accumulated chain per redirect, so budget spend is idempotent per
    // hop URL — a hop is charged once no matter how often its chain is
    // re-validated. Denial checks still run on every call.
    for (const hop of requests) {
      const hostname = hop.hostname ?? new URL(hop.url).hostname;
      const firstSpend = !this.chainSpent.has(hop.url);
      this.chainSpent.add(hop.url);
      if (this.budget !== undefined && !firstSpend) {
        // Full denial checks, no second spend for this hop.
        this.denyIf({
          hostname,
          url: hop.url,
          ...(hop.method !== undefined ? { method: hop.method } : {}),
        });
        await this.base.checkRequest({
          hostname,
          url: hop.url,
          ...(hop.method !== undefined ? { method: hop.method } : {}),
        });
        continue;
      }
      await this.checkRequest({
        hostname,
        url: hop.url,
        ...(hop.method !== undefined ? { method: hop.method } : {}),
      });
    }
  }

  async checkResponse(response: { headers: Record<string, string> }): Promise<void> {
    if (this.base.checkResponse !== undefined) {
      await this.base.checkResponse(response);
    }
  }

  async checkBodySize(bytes: number): Promise<void> {
    if (this.base.checkBodySize !== undefined) {
      await this.base.checkBodySize(bytes);
    }
  }

  async checkResolvedAddresses(addresses: string[]): Promise<void> {
    if (this.base.checkResolvedAddresses !== undefined) {
      await this.base.checkResolvedAddresses(addresses);
    }
  }
}
