/**
 * Network Policy Enforcement
 *
 * Provides SSRF defense and network egress policy enforcement
 * with configurable security rules and comprehensive logging.
 */

import { RingBuffer } from '@agentbrowser/core';
import { classifyIPAddress } from './ip-address.js';

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

/** TCP-only authorization: never substitute a fabricated URL for a request. */
export interface DestinationPolicy {
  checkDestination(destination: Readonly<{ hostname: string; port: number }>): Promise<void>;
  checkResolvedAddresses(addresses: readonly string[]): Promise<void>;
}

export interface GatewayPolicyOptions {
  allowedPorts?: readonly number[];
}

export interface GatewayPolicySnapshot<T = NetworkPolicy> {
  readonly requestPolicy: T;
  readonly destinationPolicy: DestinationPolicy;
  readonly coverage: 'tcp-destination-only';
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
    this.checkHostname(hostname);
    if (this.options.enableLogging) this.logRequest({ ...request, action: 'allowed' });
  }

  private checkHostname(hostname: string): void {
    const address = classifyIPAddress(hostname);
    // Do not fall through as a DNS name after rejecting malformed IP syntax.
    // Raw dotted quads with leading zeroes are ambiguous; URL callers already
    // supply WHATWG-normalized hosts, while raw policy callers must be explicit.
    if (!address && (/[:\[\]%]/.test(hostname) || /^\d+(?:\.\d+){3}$/.test(hostname))) {
      throw new NetworkPolicyError('POLICY_DENIED', 'Invalid or scoped IP hostname', false, {
        rule: 'requestAddressInvalid',
      });
    }

    if (
      this.options.blockLoopback &&
      (address?.loopback || hostname === 'localhost' || hostname === 'localhost.localdomain')
    ) {
      throw new NetworkPolicyError(
        'POLICY_DENIED',
        `Loopback addresses are blocked: ${hostname}`,
        false,
        { hostname, rule: 'blockLoopback' }
      );
    }

    if (this.options.blockPrivateIPs && address?.privateIP) {
      throw new NetworkPolicyError(
        'POLICY_DENIED',
        `Private IP addresses are blocked: ${hostname}`,
        false,
        { hostname, rule: 'blockPrivateIPs' }
      );
    }

    if (this.options.blockMetadata && (address?.metadata || this.isMetadataEndpoint(hostname))) {
      throw new NetworkPolicyError(
        'POLICY_DENIED',
        `Cloud metadata endpoints are blocked: ${hostname}`,
        false,
        { hostname, rule: 'blockMetadata' }
      );
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
    if (addresses.length === 0) {
      throw new NetworkPolicyError('POLICY_DENIED', 'No resolved addresses', false, {
        rule: 'resolvedAddressInvalid',
      });
    }
    for (const address of addresses) {
      const classification = classifyIPAddress(address);
      if (!classification) {
        throw new NetworkPolicyError('POLICY_DENIED', 'Invalid or scoped resolved address', false, {
          rule: 'resolvedAddressInvalid',
        });
      }
      if (this.options.blockLoopback && classification.loopback) {
        throw new NetworkPolicyError(
          'POLICY_DENIED',
          `Resolved address is loopback (DNS rebinding): ${address}`,
          false,
          { address, rule: 'resolvedLoopback' }
        );
      }
      if (this.options.blockPrivateIPs && classification.privateIP) {
        throw new NetworkPolicyError(
          'POLICY_DENIED',
          `Resolved address is private (DNS rebinding): ${address}`,
          false,
          { address, rule: 'resolvedPrivate' }
        );
      }
      if (this.options.blockMetadata && classification.metadata) {
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

  /** Actual decoded bytes, including chunked and compressed responses. */
  async checkBodySize(bytes: number): Promise<void> {
    if (!Number.isFinite(bytes) || bytes < 0 || bytes > this.options.maxResponseSize) {
      throw new NetworkPolicyError('POLICY_DENIED', 'Response exceeds the actual-byte cap', false, {
        rule: 'responseBodySize',
        size: bytes,
        max: this.options.maxResponseSize,
      });
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
   * Check if hostname is a cloud metadata endpoint
   */
  private isMetadataEndpoint(hostname: string): boolean {
    return this.METADATA_ENDPOINTS.some(
      (endpoint) => hostname === endpoint || hostname.endsWith(`.${endpoint}`)
    );
  }

  /**
   * Get current policy configuration
   */
  getConfig(): Readonly<NetworkPolicyOptions> {
    return { ...this.options };
  }

  /** Fixed session-generation rules, without multiplying raw request-log buffers. */
  snapshot(): NetworkPolicy {
    // An inherited config-only clone must never silently drop a custom deny.
    // Custom policies must explicitly implement their own immutable snapshot.
    if (
      Object.getPrototypeOf(this) !== NetworkPolicy.prototype ||
      [
        'checkRequest',
        'checkResolvedAddresses',
        'checkResponse',
        'checkBodySize',
        'checkRedirectChain',
      ].some((name) => Object.hasOwn(this, name))
    ) {
      throw new NetworkPolicyError(
        'ENGINE_UNSUPPORTED',
        'Custom policy requires an immutable snapshot implementation'
      );
    }
    const snapshot = new NetworkPolicy({ ...this.options, enableLogging: false, maxLogEntries: 1 });
    Object.freeze(snapshot.options);
    return snapshot;
  }

  /** Explicit trusted opt-in; custom rules require their own conservative adapter. */
  snapshotForGateway(options: GatewayPolicyOptions = {}): GatewayPolicySnapshot {
    assertGatewayBuiltin(this, NetworkPolicy.prototype);
    const allowedPorts = portGate(options.allowedPorts);
    // Do not dispatch overridable snapshot/getConfig methods or infer that a
    // download snapshot confers gateway capability. Both views share this copy.
    const snapshot = new NetworkPolicy({ ...this.options, enableLogging: false, maxLogEntries: 1 });
    Object.freeze(snapshot.options);
    const checkHostname = snapshot.checkHostname.bind(snapshot);
    const checkAddresses = snapshot.checkResolvedAddresses.bind(snapshot);
    const destinationPolicy: DestinationPolicy = Object.freeze({
      async checkDestination({ hostname, port }: Readonly<{ hostname: string; port: number }>) {
        allowedPorts(port);
        checkHostname(hostname.toLowerCase());
      },
      checkResolvedAddresses: (addresses: readonly string[]) => checkAddresses([...addresses]),
    });
    Object.freeze(snapshot);
    return Object.freeze({
      requestPolicy: snapshot,
      destinationPolicy,
      coverage: 'tcp-destination-only',
    });
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
  private readonly hosts: HostRules;

  constructor(
    private readonly base: NetworkPolicy,
    rules: SessionHostRules
  ) {
    this.hosts = new HostRules(rules);
  }

  async checkResponse(response: { headers?: Record<string, string> }): Promise<void> {
    await this.base.checkResponse({
      ...(response.headers !== undefined ? { headers: response.headers } : {}),
    });
  }

  async checkBodySize(bytes: number): Promise<void> {
    await this.base.checkBodySize(bytes);
  }
  async checkRedirectChain(requests: RedirectRequest[]): Promise<void> {
    await this.base.checkRedirectChain(requests);
  }
  async checkResolvedAddresses(addresses: string[]): Promise<void> {
    await this.base.checkResolvedAddresses(addresses);
  }

  async checkRequest(request: { hostname: string; url?: string }): Promise<void> {
    const hostname = request.hostname.toLowerCase();
    this.hosts.check(hostname);
    await this.base.checkRequest({
      hostname,
      ...(request.url !== undefined ? { url: request.url } : {}),
    });
  }

  snapshotForGateway(options: GatewayPolicyOptions = {}): GatewayPolicySnapshot<SessionHostPolicy> {
    assertGatewayBuiltin(this, SessionHostPolicy.prototype);
    const allowedPorts = portGate(options.allowedPorts);
    const pair = this.base.snapshotForGateway(options);
    if (
      pair?.coverage !== 'tcp-destination-only' ||
      ![
        'checkRequest',
        'checkResolvedAddresses',
        'checkResponse',
        'checkBodySize',
        'checkRedirectChain',
      ].every((name) => typeof pair.requestPolicy?.[name as keyof NetworkPolicy] === 'function') ||
      typeof pair.destinationPolicy?.checkDestination !== 'function' ||
      typeof pair.destinationPolicy.checkResolvedAddresses !== 'function'
    ) {
      throw new NetworkPolicyError(
        'ENGINE_UNSUPPORTED',
        'Invalid immutable gateway policy capability'
      );
    }
    const requestPolicy = new SessionHostPolicy(pair.requestPolicy, this.hosts.rules());
    const checkDestination = pair.destinationPolicy.checkDestination.bind(pair.destinationPolicy);
    const checkResolvedAddresses = pair.destinationPolicy.checkResolvedAddresses.bind(
      pair.destinationPolicy
    );
    const hosts = this.hosts;
    Object.freeze(requestPolicy);
    return Object.freeze({
      requestPolicy,
      coverage: 'tcp-destination-only',
      destinationPolicy: Object.freeze({
        async checkDestination({ hostname, port }: Readonly<{ hostname: string; port: number }>) {
          allowedPorts(port);
          const normalized = hostname.toLowerCase();
          hosts.check(normalized);
          await checkDestination({ hostname: normalized, port });
        },
        checkResolvedAddresses,
      }),
    });
  }
}

/** Single immutable host predicate shared by request and destination views. */
class HostRules {
  private readonly allowedExact = new Set<string>();
  private readonly allowedSuffixes = new Set<string>();
  private readonly blockedExact = new Set<string>();
  private readonly blockedSuffixes = new Set<string>();
  private readonly hasAllowList: boolean;

  constructor(rules: SessionHostRules) {
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

  check(hostname: string): void {
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
  }

  rules(): SessionHostRules {
    return {
      allowedHosts: [...this.allowedExact, ...this.allowedSuffixes],
      blockedHosts: [...this.blockedExact, ...this.blockedSuffixes],
    };
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

function assertGatewayBuiltin(value: object, prototype: object): void {
  if (
    Object.getPrototypeOf(value) !== prototype ||
    Object.getOwnPropertyNames(prototype).some((name) => Object.hasOwn(value, name))
  ) {
    throw new NetworkPolicyError(
      'ENGINE_UNSUPPORTED',
      'Custom policy requires an explicit immutable gateway adapter'
    );
  }
}

function portGate(input: readonly number[] = [443]): (port: number) => void {
  if (
    !Array.isArray(input) ||
    input.length < 1 ||
    input.length > 64 ||
    Array.from(input).some((port) => !Number.isSafeInteger(port) || port < 1 || port > 65535) ||
    new Set(input).size !== input.length
  ) {
    throw new NetworkPolicyError('INVALID_REQUEST', 'Invalid gateway port allowlist');
  }
  const ports = new Set(input);
  return (port) => {
    if (!ports.has(port))
      throw new NetworkPolicyError('POLICY_DENIED', 'Destination port is not allowed');
  };
}
