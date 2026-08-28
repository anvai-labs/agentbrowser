/**
 * Network Policy Enforcement
 *
 * Provides SSRF defense and network egress policy enforcement
 * with configurable security rules and comprehensive logging.
 */

export interface NetworkPolicyOptions {
  blockLoopback?: boolean;
  blockPrivateIPs?: boolean;
  blockMetadata?: boolean;
  maxRedirects?: number;
  maxResponseSize?: number;
  enableLogging?: boolean;
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
  private readonly logs: LogEntry[] = [];

  // Private IP ranges
  private readonly PRIVATE_IP_RANGES = [
    { start: '10.0.0.0', prefix: 8 }, // 10.0.0.0/8
    { start: '172.16.0.0', prefix: 12 }, // 172.16.0.0/12
    { start: '192.168.0.0', prefix: 16 }, // 192.168.0.0/16
    { start: '127.0.0.0', prefix: 8 }, // 127.0.0.0/8 (loopback)
  ];

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
    };

    // Validate configuration
    if (this.options.maxRedirects < 0) {
      throw new Error('maxRedirects must be non-negative');
    }
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
    return [...this.logs];
  }

  /**
   * Clear all logs
   */
  clearLogs(): void {
    this.logs.length = 0;
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
   * Check if hostname is a private IP address
   */
  private isPrivateIP(hostname: string): boolean {
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
