/**
 * Network Policy Enforcement
 *
 * Provides SSRF defense and network egress policy enforcement
 * with configurable security rules and comprehensive logging.
 */

import { RingBuffer } from '@agentbrowser/core';

export interface NetworkPolicyOptions {
  blockLoopback?: boolean;
  blockPrivateIPs?: boolean;
  blockMetadata?: boolean;
  maxRedirects?: number;
  maxResponseSize?: number;
  enableLogging?: boolean;
  /**
   * Bound on the request log (TD-BROWSER-9, A4): previously fully unbounded
   * when `enableLogging` was on - every checked request stayed for the life
   * of the process. Oldest entries are evicted first once the cap is hit.
   */
  maxLogEntries?: number;
}

export interface NetworkRequest {
  hostname: string;
  url?: string;
  timestamp?: number;
}

export interface NetworkResponse {
  headers?: Record<string, string>;
}

export interface RedirectRequest {
  url: string;
  hostname?: string;
}

export interface LogEntry {
  timestamp: number;
  hostname: string;
  url?: string | undefined;
  action: string;
  details?: Record<string, unknown> | undefined;
}

export class NetworkPolicyError extends Error {
  constructor(
    public code: string,
    message: string,
    public retryable = false,
    public details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'NetworkPolicyError';
  }
}

/**
 * Network Policy enforcer for SSRF defense and safety
 */
export class NetworkPolicy {
  private readonly options: Required<NetworkPolicyOptions>;
  private readonly logs: RingBuffer<LogEntry>;

  // Cloud metadata service endpoints
  private readonly METADATA_ENDPOINTS = [
    '169.254.169.254', // AWS, Azure
    'metadata.google.internal', // GCP
    'metadata.goog', // GCP alternate
  ];

  constructor(options: NetworkPolicyOptions = {}) {
    this.options = {
      blockLoopback: options.blockLoopback ?? false,
      blockPrivateIPs: options.blockPrivateIPs ?? false,
      blockMetadata: options.blockMetadata ?? false,
      maxRedirects: options.maxRedirects ?? 10,
      maxResponseSize: options.maxResponseSize ?? 10 * 1024 * 1024, // 10MB default
      enableLogging: options.enableLogging ?? false,
      maxLogEntries: options.maxLogEntries ?? 10_000,
    };

    // Validate configuration
    if (this.options.maxRedirects < 0) {
      throw new Error('maxRedirects must be non-negative');
    }

    this.logs = new RingBuffer({ capacity: this.options.maxLogEntries });
  }

  /**
   * Check if a network request is allowed by policy
   */
  async checkRequest(request: NetworkRequest): Promise<void> {
    const { hostname } = request;

    if (this.options.blockLoopback && this.isLoopback(hostname)) {
      throw new NetworkPolicyError(
        'POLICY_DENIED',
        `Loopback addresses are blocked: ${hostname}`,
        false,
        { hostname, rule: 'blockLoopback' }
      );
    }

    if (this.options.blockPrivateIPs && this.isPrivateIP(hostname)) {
      throw new NetworkPolicyError(
        'POLICY_DENIED',
        `Private IP addresses are blocked: ${hostname}`,
        false,
        { hostname, rule: 'blockPrivateIPs' }
      );
    }

    if (this.options.blockMetadata && this.isMetadataEndpoint(hostname)) {
      throw new NetworkPolicyError(
        'POLICY_DENIED',
        `Cloud metadata endpoints are blocked: ${hostname}`,
        false,
        { hostname, rule: 'blockMetadata' }
      );
    }

    if (this.options.enableLogging) {
      this.logRequest({
        ...request,
        action: 'allowed',
      });
    }
  }

  /**
   * Check if a redirect chain is allowed
   */
  async checkRedirectChain(requests: RedirectRequest[]): Promise<void> {
    if (requests.length > this.options.maxRedirects) {
      throw new NetworkPolicyError(
        'MAX_REDIRECTS',
        `Redirect chain exceeds maximum limit of ${this.options.maxRedirects}`,
        false,
        { count: requests.length, max: this.options.maxRedirects }
      );
    }

    // Check for redirect loops
    const seenUrls = new Set<string>();
    for (const request of requests) {
      if (seenUrls.has(request.url)) {
        throw new NetworkPolicyError(
          'REDIRECT_LOOP',
          `Redirect loop detected: ${request.url}`,
          false,
          { url: request.url }
        );
      }
      seenUrls.add(request.url);
    }
  }

  /**
   * DNS-rebinding gate: validate every resolved address against the
   * loopback/private/metadata IP checks, regardless of the hostname.
   */
  async checkResolvedAddresses(addresses: string[]): Promise<void> {
    for (const address of addresses) {
      if (this.options.blockLoopback && this.isLoopback(address)) {
        throw new NetworkPolicyError(
          'POLICY_DENIED',
          `Resolved address is loopback (DNS rebinding): ${address}`,
          false,
          { address, rule: 'resolvedLoopback' }
        );
      }
      if (this.options.blockPrivateIPs && this.isPrivateIP(address)) {
        throw new NetworkPolicyError(
          'POLICY_DENIED',
          `Resolved address is private (DNS rebinding): ${address}`,
          false,
          { address, rule: 'resolvedPrivate' }
        );
      }
      if (this.options.blockMetadata && this.isMetadataEndpoint(address)) {
        throw new NetworkPolicyError(
          'POLICY_DENIED',
          `Resolved address is a metadata endpoint: ${address}`,
          false,
          { address, rule: 'resolvedMetadata' }
        );
      }
    }
  }

  /**
   * Check if response size is within limits
   */
  async checkResponse(response: NetworkResponse): Promise<void> {
    const contentLength = response.headers?.['content-length'];

    if (contentLength !== undefined) {
      const size = Number.parseInt(contentLength, 10);

      if (!Number.isNaN(size) && size > this.options.maxResponseSize) {
        throw new NetworkPolicyError(
          'RESPONSE_TOO_LARGE',
          `Response size ${size} bytes exceeds maximum ${this.options.maxResponseSize} bytes`,
          false,
          { size, max: this.options.maxResponseSize }
        );
      }
    }
  }

  /**
   * Log a network request
   */
  logRequest(
    request: NetworkRequest & { action?: string; details?: Record<string, unknown> }
  ): void {
    if (!this.options.enableLogging) {
      return;
    }

    this.logs.push({
      timestamp: request.timestamp ?? Date.now(),
      hostname: request.hostname,
      url: request.url || undefined,
      action: request.action ?? 'logged',
      details: request.details,
    });
  }

  /**
   * Get all logged requests
   */
  getLogs(): LogEntry[] {
    return this.logs.toArray();
  }

  /**
   * Clear all logs
   */
  clearLogs(): void {
    this.logs.clear();
  }

  /**
   * Check if hostname is a loopback address
   */
  private isLoopback(hostname: string): boolean {
    // Check hostname variants
    if (hostname === 'localhost' || hostname === 'localhost.localdomain') {
      return true;
    }

    // Check IP address
    if (this.isIPAddress(hostname)) {
      const parts = hostname.split('.').map(Number);

      // 127.0.0.0/8
      if (parts[0] === 127) {
        return true;
      }

      // 0.0.0.0/8 (special case)
      if (parts[0] === 0 && parts[1] === 0 && parts[2] === 0 && parts[3] === 0) {
        return true;
      }
    }

    return false;
  }

  /**
   * Check if hostname is a private / non-routable IP address.
   *
   * Covers the full SSRF-relevant set, not just RFC1918 (hygiene C3): the
   * gaps below were previously ALLOWED through blockPrivateIPs —
   * 169.254.0.0/16 link-local (which also guards metadata endpoints
   * beyond the exact ones listed in METADATA_ENDPOINTS, e.g. ECS task
   * metadata at 169.254.170.2), 100.64.0.0/10 CGNAT, 0.0.0.0/8
   * "this network" (only exact 0.0.0.0 was loopback-checked), and
   * 198.18.0.0/15 benchmarking. IPv6 literals are checked too: ::1
   * loopback, fe80::/10 link-local, fc00::/7 ULA (URL hostnames may
   * arrive bracketed).
   */
  private isPrivateIP(hostname: string): boolean {
    // IPv6 (possibly bracketed, as URL hostnames are).
    const unbracketed =
      hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
    if (unbracketed.includes(':')) {
      const expanded = unbracketed.toLowerCase();
      if (expanded === '::1' || expanded === '::') {
        return true; // loopback / unspecified
      }
      if (
        expanded.startsWith('fe8') ||
        expanded.startsWith('fe9') ||
        expanded.startsWith('fea') ||
        expanded.startsWith('feb')
      ) {
        return true; // fe80::/10 link-local
      }
      if (expanded.startsWith('fc') || expanded.startsWith('fd')) {
        return true; // fc00::/7 unique local
      }
      return false;
    }

    if (!this.isIPAddress(hostname)) {
      return false;
    }

    const parts = hostname.split('.').map(Number);
    const [a, b] = parts;

    // 10.0.0.0/8
    if (a === 10) {
      return true;
    }

    // 172.16.0.0/12
    if (a === 172 && b !== undefined && b >= 16 && b <= 31) {
      return true;
    }

    // 192.168.0.0/16
    if (a === 192 && b === 168) {
      return true;
    }

    // 169.254.0.0/16 link-local
    if (a === 169 && b === 254) {
      return true;
    }

    // 100.64.0.0/10 CGNAT
    if (a === 100 && b !== undefined && b >= 64 && b <= 127) {
      return true;
    }

    // 0.0.0.0/8 "this network"
    if (a === 0) {
      return true;
    }

    // 198.18.0.0/15 benchmarking
    if (a === 198 && b === 18) {
      return true;
    }
    if (a === 198 && b === 19) {
      return true;
    }

    return false;
  }

  /**
   * Check if hostname is a cloud metadata endpoint
   */
  private isMetadataEndpoint(hostname: string): boolean {
    return this.METADATA_ENDPOINTS.some(
      (endpoint) => hostname === endpoint || hostname.endsWith(`.${endpoint}`)
    );
  }

  /**
   * Check if string is an IPv4 address
   */
  private isIPAddress(hostname: string): boolean {
    const ipv4Regex = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
    const match = hostname.match(ipv4Regex);

    if (!match) {
      return false;
    }

    // Check each octet is 0-255
    const octets = match.slice(1).map(Number);
    return octets.every((octet) => octet >= 0 && octet <= 255);
  }

  /**
   * Get current policy configuration
   */
  getConfig(): Readonly<NetworkPolicyOptions> {
    return { ...this.options };
  }

  /**
   * Update policy configuration
   */
  updateConfig(options: Partial<NetworkPolicyOptions>): void {
    if (options.maxRedirects !== undefined && options.maxRedirects < 0) {
      throw new Error('maxRedirects must be non-negative');
    }

    Object.assign(this.options, options);
  }
}

// ---------------------------------------------------------------------------
// Per-session host policy (composite over the base NetworkPolicy)
// ---------------------------------------------------------------------------

export interface SessionHostRules {
  /** Exact hosts and domain suffixes (".example.com") the session may reach.
   * When set, the list is exhaustive: everything else is denied. */
  allowedHosts?: string[];
  /** Hosts denied on top of the base policy. */
  blockedHosts?: string[];
}

/**
 * Chains per-session allow/blocked host rules over the base NetworkPolicy.
 * Session rules can only RESTRICT, never weaken: the base policy always
 * runs. Satisfies the engine RequestPolicy port structurally.
 */
export class SessionHostPolicy {
  private readonly maxResponseSizeBytes: number;
  private readonly allowedExact = new Set<string>();
  private readonly allowedSuffixes = new Set<string>();
  private readonly blockedExact = new Set<string>();
  private readonly blockedSuffixes = new Set<string>();
  private readonly hasAllowList: boolean;

  constructor(
    private readonly base: NetworkPolicy,
    rules: SessionHostRules
  ) {
    for (const host of rules.allowedHosts ?? []) {
      if (host.startsWith('.')) {
        this.allowedSuffixes.add(host.toLowerCase());
      } else {
        this.allowedExact.add(host.toLowerCase());
      }
    }
    for (const host of rules.blockedHosts ?? []) {
      if (host.startsWith('.')) {
        this.blockedSuffixes.add(host.toLowerCase());
      } else {
        this.blockedExact.add(host.toLowerCase());
      }
    }
    this.hasAllowList = this.allowedExact.size > 0 || this.allowedSuffixes.size > 0;
    this.maxResponseSizeBytes = base.getConfig().maxResponseSize ?? 10 * 1024 * 1024;
  }

  async checkResponse(response: { headers?: Record<string, string> }): Promise<void> {
    // Session rules are host-scoped; response caps come from the base.
    await this.base.checkResponse({
      ...(response.headers !== undefined ? { headers: response.headers } : {}),
    });
  }

  async checkRequest(request: { hostname: string; url?: string }): Promise<void> {
    const hostname = request.hostname.toLowerCase();

    if (this.blockedExact.has(hostname) || this.matchesSuffix(this.blockedSuffixes, hostname)) {
      throw new NetworkPolicyError(
        'POLICY_DENIED',
        `Host ${hostname} is blocked by the session policy`,
        false,
        { hostname, rule: 'sessionBlockedHosts' }
      );
    }

    if (this.hasAllowList) {
      const allowed =
        this.allowedExact.has(hostname) || this.matchesSuffix(this.allowedSuffixes, hostname);
      if (!allowed) {
        throw new NetworkPolicyError(
          'POLICY_DENIED',
          `Host ${hostname} is not in the session allow-list`,
          false,
          { hostname, rule: 'sessionAllowedHosts' }
        );
      }
    }

    // The base SSRF policy always runs last: sessions cannot weaken it.
    await this.base.checkRequest({
      hostname,
      ...(request.url !== undefined ? { url: request.url } : {}),
    });
  }

  private matchesSuffix(suffixes: Set<string>, hostname: string): boolean {
    for (const suffix of suffixes) {
      if (hostname.endsWith(suffix)) {
        return true;
      }
    }
    return false;
  }
}
