import { createHash } from 'node:crypto';
import {
  hostMatchesPattern,
  hostPatternsOverlap,
  type ResearchRequestHeader,
  requestHeaderIssues,
  type ScopeAssetHost,
  STATIC_ASSET_TYPES,
} from '@agentbrowser/core';
import { NetworkPolicyError } from './network-policy.js';

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
  assetHosts?: ScopeAssetHost[];
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
  requestHeaders?: ResearchRequestHeader[];
  /** T10 M3: hosts (exact or ".suffix") removed from scope even when allowed. */
  excludeHosts?: string[];
  /** T10 M3: segment-bounded path prefixes removed from scope (optionally host-bound). */
  excludePaths?: ScopePathRule[];
  /** T10 M3: URL schemes in scope, lowercase without ":" (absent = any). */
  allowedSchemes?: string[];
  /** T10 M3: ports in scope; an absent URL port means the scheme's default (absent = any). */
  allowedPorts?: number[];
  /** T10 M3: the program this engagement runs under (metadata only; reported, never enforced). */
  program?: ScopeProgram;
  /**
   * T10 M3: at most `requests` in-scope requests per `perSeconds` window. Paces (waits for a
   * free slot) rather than denying, so a page load slows down instead of breaking.
   */
  rateLimit?: { requests: number; perSeconds: number };
  /** Injected sleep for movement-testable pacing (default an unref'd setTimeout; resolves early on abort). */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Longest a request may wait for a rate-limit slot, queue included (default 15 s). */
  maxPaceMs?: number;
}

/** T10 M3: who authorized the engagement, under which published program scope. */
export interface ScopeProgram {
  id: string;
  version?: string;
  authorizedBy: string;
  /** ISO 8601 timestamp of the authorization. */
  authorizedAt: string;
}

/** The scope in effect, as `EngagementScopePolicy.status()` reports it (T10 M2). */
export interface EngagementScopeStatus {
  revision?: number;
  assetHosts?: ScopeAssetHost[];
  requestHeaders?: Array<{ header: string; hostSuffix?: string; valueSha256: string }>;
  allowedHosts: string[];
  pathRules: ScopePathRule[];
  allowedMethods?: string[];
  /** Header and hosts only: a marker's value is never reported. */
  identityBindings: Array<{ header: string; allowedHosts: string[] }>;
  expiresAt?: number;
  expired: boolean;
  budget?: { limit: number; spent: number; remaining: number };
  /** Denials on the wire and in the navigation preflight, by sub-code. */
  denials: Record<string, number>;
  /** Why all traffic stopped (the ledger is full or failed, or the session is closing). */
  stopped?: string;
  excludeHosts?: string[];
  excludePaths?: ScopePathRule[];
  allowedSchemes?: string[];
  allowedPorts?: number[];
  program?: ScopeProgram;
  /** The rate limit in effect and how many requests waited for a slot. */
  rateLimit?: { requests: number; perSeconds: number; paced: number };
}

const DEFAULT_PORTS: Record<string, number> = { http: 80, https: 443, ws: 80, wss: 443 };

/**
 * The path an exclusion is matched against: every spelling a server might route to the
 * same resource collapses to one form. Percent-escapes are decoded (repeatedly, for
 * double encoding), case is folded, "\\" and repeated "/" become one "/", ";params" are
 * cut from each segment and dot segments resolved. Over-matching only narrows the scope,
 * so exclusions err toward matching; allow-side rules keep the literal path.
 */
const decodeRepeatedly = (path: string, keepSeparators: boolean): string => {
  let current = path;
  for (let pass = 0; pass < 3; pass += 1) {
    const decoded = current.replace(/%([0-9A-Fa-f]{2})/g, (match, hex: string) => {
      const code = Number.parseInt(hex, 16);
      // Form B keeps an encoded "/" or "\\" undecoded so ".." across it stays unresolved.
      return keepSeparators && (code === 0x2f || code === 0x5c) ? match : String.fromCharCode(code);
    });
    if (decoded === current) break;
    current = decoded;
  }
  return current;
};

/**
 * How ".." and dot-and-space segments ("..%20", "...") are read: "parent" resolves them
 * against the previous segment, "drop" skips dot-and-space segments, "literal" keeps ".."
 * as a segment (a server that does not resolve across an encoded separator).
 */
type DotReading = 'parent' | 'drop' | 'literal';

const resolveSegments = (path: string, dots: DotReading): string => {
  const segments: string[] = [];
  for (const raw of path
    .toLowerCase()
    .replace(/%2f|%5c/g, '/')
    .replace(/\\/g, '/')
    .split('/')) {
    // Cut ";params" and anything after a NUL.
    let segment = (raw.split(';')[0] ?? '').split('\u0000')[0] ?? '';
    if (segment === '' || segment === '.') continue;
    // A segment of dots and whitespace: IIS/Windows trim trailing dots and spaces, so
    // "..%20" and "..." may reach the server as "..".
    const dotsOnly = /^[.\s]+$/.test(segment);
    const parent = segment === '..' || (dotsOnly && (segment.match(/\./g)?.length ?? 0) >= 2);
    if (parent) {
      if (dots === 'parent') segments.pop();
      else if (dots === 'literal') segments.push('..');
      continue;
    }
    if (dotsOnly) continue;
    // Strip the trailing dots and whitespace IIS/Windows ignore.
    segment = segment.replace(/[.\s]+$/, '');
    if (segment !== '') segments.push(segment);
  }
  return `/${segments.join('/')}`;
};

/**
 * The paths an exclusion is matched against: every spelling a server might route to the
 * same resource. Form A decodes everything (repeatedly, for double encoding), then reads
 * dot segments both as a parent step and, for dot-and-space segments, as dropped. Form B
 * keeps an encoded separator undecoded so ".." across it stays literal. All fold case,
 * map "\\" to "/", collapse repeated "/", cut ";params" and NUL tails, and strip trailing
 * dots and whitespace per segment. An exclusion matches if any form falls under it:
 * over-matching only narrows the scope. Allow-side rules keep the literal path.
 */
const canonicalPaths = (pathname: string): string[] => {
  const decoded = decodeRepeatedly(pathname, false);
  return [
    resolveSegments(decoded, 'parent'),
    resolveSegments(decoded, 'drop'),
    resolveSegments(decodeRepeatedly(pathname, true), 'literal'),
  ];
};

/** Segment-bounded prefix: "/api" admits "/api" and "/api/x", never "/apix". */
const underPrefix = (pathname: string, prefix: string): boolean =>
  pathname === prefix ||
  (pathname.startsWith(prefix) && (prefix.endsWith('/') || pathname.charAt(prefix.length) === '/'));

const DENIED = 'POLICY_DENIED' as const;

/**
 * A configured host as the request side sees it: lowercase, no trailing dot. Every rule
 * that binds a host goes through this, so a rule binds exactly what it names; an
 * un-normalized rule would bind nothing (and an unbound path rule widens the scope).
 */
const normalizeHost = (host: string): string => host.toLowerCase().replace(/\.+$/, '');

/** Do two host patterns (exact or ".suffix") admit at least one common host? */
const patternsOverlap = hostPatternsOverlap;

/**
 * Configuration a scope cannot enforce as written, refused at create time: a path rule
 * whose host binds none of the allowed hosts would leave that host's paths unrestricted.
 */
export function scopeConfigurationIssues(scope: {
  allowedHosts: string[];
  pathRules?: Array<{ hostSuffix?: string }>;
  excludePaths?: Array<{ hostSuffix?: string }>;
  requestHeaders?: ResearchRequestHeader[];
  assetHosts?: ScopeAssetHost[];
}): string[] {
  const allowed = scope.allowedHosts.map(normalizeHost);
  const issues: string[] = scope.requestHeaders ? requestHeaderIssues(scope.requestHeaders) : [];
  for (const asset of scope.assetHosts ?? []) {
    if (
      asset.class !== 'asset' ||
      allowed.some((p) => patternsOverlap(p, normalizeHost(asset.host)))
    )
      issues.push('assetHosts must be asset-class and disjoint from program hosts');
  }
  // pathRules: an unbound rule leaves its host unrestricted. excludePaths: an unbound
  // exclusion is a restriction silently ignored. Both are refused.
  for (const field of ['pathRules', 'excludePaths', 'requestHeaders'] as const) {
    for (const [index, rule] of (scope[field] ?? []).entries()) {
      if (rule.hostSuffix === undefined) continue;
      const host = normalizeHost(rule.hostSuffix);
      const sample = (pattern: string) =>
        pattern.startsWith('.') ? `scope-probe${pattern}` : pattern;
      const bindingHosts =
        field === 'excludePaths'
          ? [...allowed, ...(scope.assetHosts ?? []).map((a) => normalizeHost(a.host))]
          : allowed;
      const binds = bindingHosts.some((pattern) =>
        field === 'requestHeaders'
          ? hostMatchesPattern(sample(host), pattern) || hostMatchesPattern(sample(pattern), host)
          : patternsOverlap(host, pattern)
      );
      if (!binds)
        issues.push(`${field}[${index}].hostSuffix ${rule.hostSuffix} binds no allowed host`);
    }
  }
  return issues;
}

// One host matcher for the whole product (T10 consolidation): delegates to
// the core implementation so the session host policy and the engagement
// scope cannot drift apart again. `.suffix` matches subdomains only; a bare
// bounded domain covers its subtree (#588 semantics); unbounded patterns
// match exactly only.
const hostMatches = (hostname: string, pattern: string): boolean =>
  hostMatchesPattern(hostname, pattern);

/**
 * Every sub-code this policy raises. `scopeDenial` accepts only these, and a
 * contract test pins the list to the protocol's SCOPE_DENIAL_CODES, so a new
 * code cannot reach clients without the projection knowing it (ADR-015).
 */
export const SCOPE_SUBCODES = Object.freeze([
  'SCOPE_HOST_DENIED',
  'SCOPE_PATH_DENIED',
  'SCOPE_METHOD_DENIED',
  'SCOPE_IDENTITY_DENIED',
  'SCOPE_EXPIRED',
  'SCOPE_BUDGET_EXHAUSTED',
  'SCOPE_LEDGER_UNAVAILABLE',
  'SCOPE_RATE_LIMITED',
] as const);
export type ScopeSubCode = (typeof SCOPE_SUBCODES)[number];

const scopeDenial = (subCode: ScopeSubCode, detail: string): NetworkPolicyError =>
  new NetworkPolicyError(DENIED, `${subCode}: ${detail}`, false, { scope: subCode });

/**
 * Distinct hop URLs remembered so a re-validated chain spends each hop once.
 * FIFO-bounded (#447): past the bound the oldest hop is forgotten, and a
 * forgotten hop that is re-submitted is charged again — over-charging only,
 * so the budget can end sooner, never later. A session reaches the bound only
 * 41+ redirect-saturated navigations at the transport's 100-hop cap (~410 at the default).
 */
export const CHAIN_SPENT_BOUND = 4096;

export class EngagementScopePolicy {
  /** A scope never lets a redirect hop go unchecked (T10 M1). */
  readonly requireRedirectGuard = true;
  declare readonly headersForRequest?: (
    hostname: string,
    headers: Record<string, string>
  ) => Record<string, string> | undefined;
  private revision = 0;
  private readonly assetHosts: ScopeAssetHost[];
  private readonly injected: ResearchRequestHeader[];
  /** Lowercased configured marker names, for the cheap carries-a-marker check. */
  private readonly injectedNames: Set<string>;
  private readonly allowed: string[];
  private readonly paths: ScopePathRule[];
  private readonly methods: Set<string> | undefined;
  private readonly identities: ScopeIdentityBinding[];
  private readonly expiresAt: number | undefined;
  private readonly now: () => number;
  private budget: number | undefined;
  private readonly excludedHosts: string[];
  private readonly excludedPaths: ScopePathRule[];
  private readonly schemes: Set<string> | undefined;
  private readonly ports: Set<number> | undefined;
  private readonly program: ScopeProgram | undefined;
  private readonly rate: { requests: number; perSeconds: number } | undefined;
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  private readonly maxPaceMs: number;
  /** Aborted by stop(): waiting requests wake at once and are denied. */
  private readonly wake = new AbortController();
  /** Admission times inside the current window, oldest first. */
  private admitted: number[] = [];
  /** Pacing is serialized so concurrent requests cannot burst past the limit. */
  private paceQueue: Promise<void> = Promise.resolve();
  private paced = 0;
  private spent = 0;
  /** Hops already spent by checkRedirectChain — callers may re-submit the
   * accumulated chain per redirect (the download transport does), and the
   * budget must charge a hop once, not once per resubmission. */
  private readonly chainSpent = new Set<string>();

  /** Remembers a hop unless already remembered; evicts the oldest past the bound. */
  private rememberHop(url: string): boolean {
    if (this.chainSpent.has(url)) return false;
    if (this.chainSpent.size >= CHAIN_SPENT_BOUND) {
      const oldest = this.chainSpent.values().next().value;
      if (oldest !== undefined) this.chainSpent.delete(oldest);
    }
    this.chainSpent.add(url);
    return true;
  }

  constructor(
    private readonly base: {
      checkRequest(request: {
        hostname: string;
        url?: string;
        method?: string;
        headers?: Record<string, string>;
        resourceType?: string;
        initiatorHost?: string;
      }): Promise<void>;
      checkRedirectChain?(requests: Array<{ url: string; hostname?: string }>): Promise<void>;
      checkResponse?(response: { headers: Record<string, string> }): Promise<void>;
      checkBodySize?(bytes: number): Promise<void>;
      checkResolvedAddresses?(addresses: string[]): Promise<void>;
    },
    scope: EngagementScopeOptions
  ) {
    const headerIssues = scopeConfigurationIssues(scope);
    if (headerIssues.length)
      throw new NetworkPolicyError('POLICY_DENIED', headerIssues.join('; '), false, {
        rule: 'scope.requestHeaders.invalid',
      });
    this.assetHosts = (scope.assetHosts ?? []).map((entry) => ({
      ...entry,
      host: normalizeHost(entry.host),
    }));
    if (
      this.assetHosts.some(
        (asset) =>
          asset.class !== 'asset' ||
          scope.allowedHosts.some((p) => patternsOverlap(normalizeHost(p), asset.host))
      )
    )
      throw new NetworkPolicyError(
        'POLICY_DENIED',
        'Asset and program hosts must be disjoint',
        false,
        { rule: 'scope.assets.invalid' }
      );
    this.injected = (scope.requestHeaders ?? []).map((entry) => ({
      ...entry,
      header: entry.header.toLowerCase(),
      ...(entry.hostSuffix ? { hostSuffix: normalizeHost(entry.hostSuffix) } : {}),
    }));
    this.injectedNames = new Set(this.injected.map((entry) => entry.header));
    this.headersForRequest = this.transformHeaders.bind(this);
    this.allowed = scope.allowedHosts.map(normalizeHost);
    this.paths = (scope.pathRules ?? []).map((rule) => ({
      ...rule,
      ...(rule.hostSuffix !== undefined ? { hostSuffix: normalizeHost(rule.hostSuffix) } : {}),
    }));
    this.methods =
      scope.allowedMethods !== undefined
        ? new Set(scope.allowedMethods.map((m) => m.toUpperCase()))
        : undefined;
    this.identities = (scope.identityBindings ?? []).map((binding) => ({
      ...binding,
      allowedHosts: binding.allowedHosts.map(normalizeHost),
    }));
    this.expiresAt = scope.expiresAt;
    this.now = scope.now ?? Date.now;
    this.budget = scope.requestBudget;
    this.excludedHosts = (scope.excludeHosts ?? []).map(normalizeHost);
    this.excludedPaths = (scope.excludePaths ?? []).map((rule) => ({
      ...rule,
      ...(rule.hostSuffix !== undefined ? { hostSuffix: normalizeHost(rule.hostSuffix) } : {}),
    }));
    this.schemes =
      scope.allowedSchemes !== undefined
        ? new Set(scope.allowedSchemes.map((s) => s.toLowerCase()))
        : undefined;
    this.ports = scope.allowedPorts !== undefined ? new Set(scope.allowedPorts) : undefined;
    this.program = scope.program !== undefined ? { ...scope.program } : undefined;
    this.rate = scope.rateLimit !== undefined ? { ...scope.rateLimit } : undefined;
    this.sleep =
      scope.sleep ??
      ((ms: number, signal: AbortSignal) =>
        new Promise<void>((resolve) => {
          if (signal.aborted) return resolve();
          const timer = setTimeout(resolve, ms);
          timer.unref?.();
          signal.addEventListener(
            'abort',
            () => {
              clearTimeout(timer);
              resolve();
            },
            { once: true }
          );
        }));
    this.maxPaceMs = scope.maxPaceMs ?? 15_000;
  }

  /**
   * Waits until the request fits the rate limit, then records its admission. Returns
   * whether it waited (the caller re-checks the scope: it may have expired or stopped).
   * A request that would wait longer than `maxPaceMs` (its time in the queue included) is
   * denied SCOPE_RATE_LIMITED instead, so nothing is sent after the caller's navigation
   * has given up.
   */
  private async pace(): Promise<boolean> {
    const rate = this.rate;
    if (rate === undefined) return false;
    const windowMs = rate.perSeconds * 1000;
    const enqueuedAt = this.now();
    let waited = false;
    const turn = this.paceQueue.then(async () => {
      for (;;) {
        // A stopped scope admits nothing; the caller's re-check denies.
        if (this.stopped !== undefined) {
          waited = true;
          return;
        }
        const now = this.now();
        this.admitted = this.admitted.filter((at) => at > now - windowMs);
        if (this.admitted.length < rate.requests) {
          this.admitted.push(now);
          return;
        }
        const oldest = this.admitted[this.admitted.length - rate.requests] ?? now;
        const wait = Math.max(1, oldest + windowMs - now);
        if (now - enqueuedAt + wait > this.maxPaceMs) {
          this.denials.set('SCOPE_RATE_LIMITED', (this.denials.get('SCOPE_RATE_LIMITED') ?? 0) + 1);
          throw scopeDenial(
            'SCOPE_RATE_LIMITED',
            `rate limit ${rate.requests} per ${rate.perSeconds}s would hold this request past ${this.maxPaceMs} ms`
          );
        }
        if (!waited) {
          waited = true;
          this.paced += 1;
        }
        // Loop after waking: a timer may fire early or the clock may move backwards.
        await this.sleep(wait, this.wake.signal);
      }
    });
    this.paceQueue = turn.catch(() => {});
    await turn;
    return waited;
  }

  /** Denials raised on the wire or in the navigation preflight, by sub-code. */
  private readonly denials = new Map<string, number>();
  /** Set once the engagement ledger cannot take more traffic (T10 M2): fail closed. */
  private stopped: string | undefined;

  /**
   * Stops all further traffic in this scope (the engagement ledger is full or
   * failed). One-way: a stopped scope never reopens.
   */
  stop(reason: string): void {
    this.stopped ??= reason;
    this.wake.abort();
  }

  /** The rules, counted: a denial is recorded by sub-code before it is thrown. */
  private denyIf(request: {
    hostname: string;
    url?: string;
    method?: string;
    headers?: Record<string, string>;
    resourceType?: string;
    initiatorHost?: string;
  }): void {
    try {
      this.rules(request);
    } catch (error) {
      const code = (error as { details?: { scope?: unknown } }).details?.scope;
      if (typeof code === 'string') this.denials.set(code, (this.denials.get(code) ?? 0) + 1);
      throw error;
    }
  }

  /**
   * Remove configured markers first, so cross-host hops cannot inherit one,
   * then add the matching set for this destination. `undefined` means ZERO
   * header-policy interaction: the destination matches no entry, carries no
   * configured marker name, and is not an asset host — the engine passes the
   * request through untouched (no replayed header set, no CDP overrides).
   * This is what scopes `hostSuffix` to enforcement as well as injection:
   * cross-origin dependencies of an in-scope page (captcha vendors, SSO,
   * payment iframes) never touch the marker transport paths at all.
   */
  private transformHeaders(
    hostname: string,
    headers: Record<string, string>
  ): Record<string, string> | undefined {
    const host = normalizeHost(hostname);
    if (
      !this.assetHosts.some((a) => hostMatches(host, a.host)) &&
      !this.injected.some(
        (entry) => !entry.hostSuffix || hostMatchesPattern(host, entry.hostSuffix)
      ) &&
      !Object.keys(headers).some((name) => this.injectedNames.has(name.toLowerCase()))
    ) {
      return undefined; // pass-through: nothing to inject, strip, or scrub
    }
    const result = Object.fromEntries(
      Object.entries(headers).filter(([name]) => !this.injectedNames.has(name.toLowerCase()))
    );
    if (this.assetHosts.some((a) => hostMatches(host, a.host))) {
      for (const name of Object.keys(result))
        if (['cookie', 'authorization', 'proxy-authorization'].includes(name.toLowerCase()))
          Reflect.deleteProperty(result, name);
      // Explicit empty Cookie also prevents route.fetch's automatic cookie-jar reattachment.
      return { ...result, cookie: '' };
    }
    for (const entry of this.injected)
      if (!entry.hostSuffix || hostMatchesPattern(host, entry.hostSuffix))
        result[entry.header] = entry.value;
    return result;
  }

  injectedHeaderNames(hostname: string): string[] {
    if (this.assetHosts.some((a) => hostMatches(normalizeHost(hostname), a.host))) return [];
    return this.injected
      .filter(
        (entry) =>
          !entry.hostSuffix || hostMatchesPattern(normalizeHost(hostname), entry.hostSuffix)
      )
      .map((entry) => entry.header);
  }

  /** Stable authority identity, including secret bindings inside the digest only. */
  configurationSha256(assets = this.assetHosts, budgetLimit = this.budget): string {
    const {
      budget: _budget,
      denials: _denials,
      expired: _expired,
      rateLimit,
      stopped: _stopped,
      revision: _revision,
      ...config
    } = this.status();
    return createHash('sha256')
      .update(
        JSON.stringify({
          ...config,
          assetHosts: assets,
          budget: budgetLimit,
          rateLimit: rateLimit
            ? { requests: rateLimit.requests, perSeconds: rateLimit.perSeconds }
            : undefined,
          identities: this.identities,
          requestHeaders: this.injected,
        })
      )
      .digest('hex');
  }

  /** ADR-028: only the operator service calls this, after strict request validation. */
  async appendAssets(
    entries: ScopeAssetHost[],
    expectedRevision: number,
    persist: (next: {
      revision: number;
      assets: ScopeAssetHost[];
      beforeSha256: string;
      afterSha256: string;
    }) => Promise<void>
  ): Promise<EngagementScopeStatus> {
    const active = () => {
      if (this.revision !== expectedRevision)
        throw scopeDenial('SCOPE_HOST_DENIED', 'scope amendment revision changed');
      if (this.stopped !== undefined)
        throw scopeDenial('SCOPE_LEDGER_UNAVAILABLE', 'scope is stopped');
      if (this.expiresAt !== undefined && this.now() >= this.expiresAt)
        throw scopeDenial('SCOPE_EXPIRED', 'scope expired');
      if (this.budget !== undefined && this.spent >= this.budget)
        throw scopeDenial('SCOPE_BUDGET_EXHAUSTED', 'scope budget exhausted');
    };
    active();
    const existing = new Set(this.assetHosts.map((entry) => entry.host));
    const additions: ScopeAssetHost[] = [];
    for (const entry of entries) {
      const host = normalizeHost(entry.host);
      const name = host.replace(/^\./, '');
      if (
        !/^[a-z0-9.-]+$/.test(name) ||
        new URL(`https://${name}`).hostname !== name ||
        entry.class !== 'asset'
      )
        throw scopeDenial('SCOPE_HOST_DENIED', 'invalid asset host');
      if (!existing.has(host)) {
        existing.add(host);
        additions.push({ ...entry, host });
      }
    }
    const assets = [...this.assetHosts, ...additions];
    if (
      assets.length > 128 ||
      scopeConfigurationIssues({ allowedHosts: this.allowed, assetHosts: assets }).length
    )
      throw scopeDenial(
        'SCOPE_HOST_DENIED',
        'asset additions must be bounded and disjoint from program targets'
      );
    if (!additions.length) return this.status();
    await persist({
      revision: expectedRevision + 1,
      assets,
      beforeSha256: this.configurationSha256(),
      afterSha256: this.configurationSha256(assets),
    });
    active();
    this.assetHosts.push(...additions);
    this.revision += 1;
    return this.status();
  }

  /** ADR-029: absolute finite increase, persisted before grant; no counter reset. */
  async topUpBudget(
    limit: number,
    expectedRevision: number,
    persist: (next: {
      revision: number;
      beforeLimit: number;
      afterLimit: number;
      spent: number;
      beforeSha256: string;
      afterSha256: string;
    }) => Promise<void>
  ): Promise<EngagementScopeStatus> {
    const active = () => {
      if (this.revision !== expectedRevision)
        throw scopeDenial('SCOPE_HOST_DENIED', 'scope amendment revision changed');
      if (this.stopped !== undefined)
        throw scopeDenial('SCOPE_LEDGER_UNAVAILABLE', 'scope is stopped');
      if (this.expiresAt !== undefined && this.now() >= this.expiresAt)
        throw scopeDenial('SCOPE_EXPIRED', 'scope expired');
      if (
        this.budget === undefined ||
        !Number.isSafeInteger(limit) ||
        limit <= this.budget ||
        limit > 10000000
      )
        throw scopeDenial(
          'SCOPE_BUDGET_EXHAUSTED',
          'top-up requires a larger finite budget at most 10000000'
        );
    };
    active();
    await persist({
      revision: expectedRevision + 1,
      beforeLimit: this.budget as number,
      afterLimit: limit,
      spent: this.spent,
      beforeSha256: this.configurationSha256(),
      afterSha256: this.configurationSha256(this.assetHosts, limit),
    });
    active();
    this.budget = limit;
    this.revision++;
    return this.status();
  }

  /** The scope in effect, budget and denials; marker values are never reported. */
  status(): EngagementScopeStatus {
    return {
      revision: this.revision,
      ...(this.assetHosts.length ? { assetHosts: this.assetHosts.map((a) => ({ ...a })) } : {}),
      ...(this.injected.length
        ? {
            requestHeaders: this.injected.map(({ header, hostSuffix, value }) => ({
              header,
              ...(hostSuffix ? { hostSuffix } : {}),
              valueSha256: createHash('sha256').update(value).digest('hex'),
            })),
          }
        : {}),
      allowedHosts: [...this.allowed],
      pathRules: this.paths.map((rule) => ({ ...rule })),
      ...(this.methods !== undefined ? { allowedMethods: [...this.methods] } : {}),
      identityBindings: this.identities.map((binding) => ({
        header: binding.header.toLowerCase(),
        allowedHosts: [...binding.allowedHosts],
      })),
      ...(this.expiresAt !== undefined ? { expiresAt: this.expiresAt } : {}),
      expired: this.expiresAt !== undefined && this.now() >= this.expiresAt,
      ...(this.budget !== undefined
        ? {
            budget: {
              limit: this.budget,
              spent: this.spent,
              remaining: Math.max(0, this.budget - this.spent),
            },
          }
        : {}),
      denials: Object.fromEntries(this.denials),
      ...(this.stopped !== undefined ? { stopped: this.stopped } : {}),
      ...(this.excludedHosts.length > 0 ? { excludeHosts: [...this.excludedHosts] } : {}),
      ...(this.excludedPaths.length > 0
        ? { excludePaths: this.excludedPaths.map((rule) => ({ ...rule })) }
        : {}),
      ...(this.schemes !== undefined ? { allowedSchemes: [...this.schemes] } : {}),
      ...(this.ports !== undefined ? { allowedPorts: [...this.ports] } : {}),
      ...(this.program !== undefined ? { program: { ...this.program } } : {}),
      ...(this.rate !== undefined ? { rateLimit: { ...this.rate, paced: this.paced } } : {}),
    };
  }

  /**
   * Dry run: would the scope rules allow this request now? Spends no budget
   * and records no denial. The base policy (SSRF, host lists) and DNS still
   * apply when the request is actually made.
   */
  check(request: {
    url: string;
    method?: string;
    headers?: Record<string, string>;
    resourceType?: string;
    initiatorHost?: string;
  }): { allowed: true } | { allowed: false; scope: string } {
    try {
      this.rules({
        hostname: new URL(request.url).hostname,
        url: request.url,
        method: request.method ?? 'GET',
        ...(request.headers !== undefined ? { headers: request.headers } : {}),
      });
      return { allowed: true };
    } catch (error) {
      const code = (error as { details?: { scope?: unknown } }).details?.scope;
      if (typeof code !== 'string') throw error;
      return { allowed: false, scope: code };
    }
  }

  private rules(request: {
    hostname: string;
    url?: string;
    method?: string;
    headers?: Record<string, string>;
    resourceType?: string;
    initiatorHost?: string;
  }): void {
    if (this.stopped !== undefined) {
      throw scopeDenial(
        'SCOPE_LEDGER_UNAVAILABLE',
        `the engagement ledger cannot record more traffic (${this.stopped})`
      );
    }
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
    const program = this.allowed.some((pattern) => hostMatches(hostname, pattern));
    const initiatorHost = request.initiatorHost;
    const asset = this.assetHosts.some((entry) => hostMatches(hostname, entry.host));
    if (
      !program &&
      !(
        asset &&
        ['GET', 'HEAD'].includes(request.method ?? '') &&
        STATIC_ASSET_TYPES.has(request.resourceType ?? '') &&
        initiatorHost &&
        this.allowed.some((p) => hostMatches(initiatorHost, p)) &&
        !this.excludedHosts.some((p) => hostMatches(initiatorHost, p))
      )
    ) {
      throw scopeDenial(
        'SCOPE_HOST_DENIED',
        `host ${hostname} is outside the authorized program/static-asset class`
      );
    }
    if (asset && !program) {
      if (!request.url) throw scopeDenial('SCOPE_HOST_DENIED', 'asset URL is required');
      const assetUrl = new URL(request.url);
      if (assetUrl.username || assetUrl.password || normalizeHost(assetUrl.hostname) !== hostname)
        throw scopeDenial(
          'SCOPE_HOST_DENIED',
          'asset URLs cannot carry credentials or a mismatched host'
        );
    }
    if (this.excludedHosts.some((pattern) => hostMatches(hostname, pattern))) {
      throw scopeDenial(
        'SCOPE_HOST_DENIED',
        `host ${hostname} is excluded from the engagement scope`
      );
    }
    if (this.schemes !== undefined || this.ports !== undefined) {
      // Fail closed: an origin rule cannot be checked without the URL.
      if (request.url === undefined) {
        throw scopeDenial('SCOPE_HOST_DENIED', `origin of ${hostname} cannot be checked (no URL)`);
      }
      const parsed = new URL(request.url);
      const scheme = parsed.protocol.replace(/:$/, '').toLowerCase();
      if (this.schemes !== undefined && !this.schemes.has(scheme)) {
        throw scopeDenial('SCOPE_HOST_DENIED', `scheme ${scheme} is outside the engagement scope`);
      }
      if (this.ports !== undefined) {
        const port = parsed.port !== '' ? Number(parsed.port) : DEFAULT_PORTS[scheme];
        if (port === undefined || !this.ports.has(port)) {
          throw scopeDenial(
            'SCOPE_HOST_DENIED',
            `port ${port ?? '(unknown)'} on ${hostname} is outside the engagement scope`
          );
        }
      }
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
    if (program && this.paths.length > 0) {
      const pathname = request.url !== undefined ? new URL(request.url).pathname : '/';
      // Rules bind their own hosts: a host with no binding rule is fully
      // in scope for paths. Prefixes match on path-SEGMENT boundaries —
      // prefix "/api" admits "/api" and "/api/users" but never "/apix" —
      // so a bare prefix cannot silently expand the engagement scope.
      const boundRules = this.paths.filter(
        (rule) => rule.hostSuffix === undefined || hostMatches(hostname, rule.hostSuffix)
      );
      const inPath =
        boundRules.length === 0 || boundRules.some((rule) => underPrefix(pathname, rule.prefix));
      if (!inPath) {
        throw scopeDenial('SCOPE_PATH_DENIED', `path ${pathname} is outside the engagement scope`);
      }
    }
    if (this.excludedPaths.length > 0) {
      // Fail closed: an exclusion cannot be checked without the URL.
      if (request.url === undefined) {
        throw scopeDenial('SCOPE_PATH_DENIED', `path on ${hostname} cannot be checked (no URL)`);
      }
      const pathname = new URL(request.url).pathname;
      const forms = canonicalPaths(pathname);
      const excluded = this.excludedPaths.some((rule) => {
        if (rule.hostSuffix !== undefined && !hostMatches(hostname, rule.hostSuffix)) return false;
        const prefix = canonicalPaths(rule.prefix)[0] ?? '/';
        return forms.some((form) => underPrefix(form, prefix));
      });
      if (excluded) {
        throw scopeDenial(
          'SCOPE_PATH_DENIED',
          `path ${pathname} is excluded from the engagement scope`
        );
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
    resourceType?: string;
    initiatorHost?: string;
  }): Promise<void> {
    // Deny-if runs BEFORE the spend: denied attempts consume no budget.
    this.denyIf(request);
    // Pacing waits for a slot; a scope that expired or stopped meanwhile still denies.
    if (await this.pace()) this.denyIf(request);
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
    resourceType?: string;
    initiatorHost?: string;
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
      const firstSpend = this.budget !== undefined && this.rememberHop(hop.url);
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
