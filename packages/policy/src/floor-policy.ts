import { classifyIPAddress, isMetadataHostname } from './ip-address.js';
import { NetworkPolicyError } from './network-policy.js';

/** The request-policy port (engine `RequestPolicy`), structurally. */
export interface RequestPolicyChain {
  headersForRequest?(hostname: string, headers: Record<string, string>): Record<string, string>;
  injectedHeaderNames?(hostname: string): string[];
  checkRequest(request: {
    hostname: string;
    url: string;
    method?: string;
    headers?: Record<string, string>;
    resourceType?: string;
    initiatorHost?: string;
  }): Promise<void>;
  checkRedirectChain?(
    requests: Array<{ url: string; hostname?: string; method?: string }>
  ): Promise<void>;
  checkResponse?(response: { headers: Record<string, string> }): Promise<void>;
  checkBodySize?(bytes: number): Promise<void>;
  checkResolvedAddresses?(addresses: string[]): Promise<void>;
  /** Every redirect hop must be checked (EngagementScopePolicy); see the engine port. */
  readonly requireRedirectGuard?: boolean;
  /** Service-side navigation preflight without spending scope budget (EngagementScopePolicy). */
  preflightCheck?(request: {
    hostname: string;
    url?: string;
    method?: string;
    headers?: Record<string, string>;
  }): Promise<void>;
}

function refuse(target: string): never {
  throw new NetworkPolicyError(
    'POLICY_DENIED',
    `Cloud metadata endpoints are always blocked: ${target}`,
    false,
    { rule: 'floor.metadata' }
  );
}

function checkHost(hostname: string): void {
  const host = hostname.toLowerCase();
  if (isMetadataHostname(host) || classifyIPAddress(host)?.metadata) refuse(host);
}

/**
 * The metadata floor (ADR-024 §1, TD-BROWSER-15 phase 0). The service wraps
 * every session's policy chain in it, so cloud metadata endpoints stay refused
 * whatever policy an embedder injects (`new NetworkPolicy({})` leaves
 * `blockMetadata` off). It checks first and then delegates; it never relaxes
 * the chain.
 *
 * Each optional gate, including the scope's budget-free `preflightCheck`, exists
 * only when the base has it: downloads refuse a
 * policy without a DNS gate, and the floor must not make a weaker chain look
 * stricter than it is.
 */
export class MetadataFloorPolicy implements RequestPolicyChain {
  declare readonly checkRedirectChain?: NonNullable<RequestPolicyChain['checkRedirectChain']>;
  declare readonly checkResponse?: NonNullable<RequestPolicyChain['checkResponse']>;
  declare readonly checkBodySize?: NonNullable<RequestPolicyChain['checkBodySize']>;
  declare readonly checkResolvedAddresses?: NonNullable<
    RequestPolicyChain['checkResolvedAddresses']
  >;
  declare readonly preflightCheck?: NonNullable<RequestPolicyChain['preflightCheck']>;
  declare readonly requireRedirectGuard?: true;

  declare readonly headersForRequest?: NonNullable<RequestPolicyChain['headersForRequest']>;
  declare readonly injectedHeaderNames?: NonNullable<RequestPolicyChain['injectedHeaderNames']>;
  constructor(private readonly base: RequestPolicyChain) {
    if (base.headersForRequest) this.headersForRequest = base.headersForRequest.bind(base);
    if (base.injectedHeaderNames) this.injectedHeaderNames = base.injectedHeaderNames.bind(base);
    if (base.requireRedirectGuard === true) this.requireRedirectGuard = true;
    const {
      checkRedirectChain,
      checkResponse,
      checkBodySize,
      checkResolvedAddresses,
      preflightCheck,
    } = base;
    if (preflightCheck) {
      this.preflightCheck = async (request) => {
        checkHost(request.hostname);
        await preflightCheck.call(base, request);
      };
    }
    if (checkRedirectChain) {
      this.checkRedirectChain = async (requests) => {
        for (const hop of requests) checkHost(hop.hostname ?? new URL(hop.url).hostname);
        await checkRedirectChain.call(base, requests);
      };
    }
    if (checkResponse) this.checkResponse = (response) => checkResponse.call(base, response);
    if (checkBodySize) this.checkBodySize = (bytes) => checkBodySize.call(base, bytes);
    if (checkResolvedAddresses) {
      this.checkResolvedAddresses = async (addresses) => {
        for (const address of addresses) {
          if (classifyIPAddress(address)?.metadata) refuse(address);
        }
        await checkResolvedAddresses.call(base, addresses);
      };
    }
    Object.freeze(this);
  }

  async checkRequest(request: Parameters<RequestPolicyChain['checkRequest']>[0]): Promise<void> {
    checkHost(request.hostname);
    await this.base.checkRequest(request);
  }
}
