/**
 * Browser-request guard for the local service.
 *
 * In no-keys local mode the API is unauthenticated by design: anything that
 * can reach 127.0.0.1:5709 controls every session, including `upload`,
 * which reads arbitrary local paths. Loopback binding keeps the LAN out but
 * not the operator's own web browser: any page they visit can address the
 * service directly (cross-origin fetch) or through a DNS-rebound hostname.
 * Non-browser clients (CLI, SDK, MCP) send neither Origin nor fetch
 * metadata, so the guard refuses requests that carry browser provenance from
 * anywhere other than this service's own origin or an operator allowlist:
 *
 * - Host allowlist (DNS rebinding): on a loopback bind, the Host header must
 *   name loopback (`localhost`, 127/8, `::1`) or an operator-allowed host.
 * - Origin allowlist (cross-origin requests): an Origin must be operator-allowed
 *   or same-origin on a checked hostname — same-origin alone is what a
 *   rebound page looks like, so it is never trusted on an unchecked Host.
 * - Fetch metadata: `Sec-Fetch-Site: cross-site|same-site` without an
 *   allowed Origin is refused (no-cors subresource requests omit Origin).
 *
 * Startup-only configuration; request input can never widen it.
 */

export interface RequestOriginGuardOptions {
  /** The listen address; a loopback bind enables the Host check. */
  bindHost: string;
  /** Extra hostnames (no port) accepted in the Host header; enables the Host check on any bind. */
  allowedHosts?: readonly string[];
  /** Exact browser origins allowed to call the API (and to receive CORS headers). '*' opts out. */
  allowedOrigins?: readonly string[];
}

export type RequestOriginVerdict = { allowed: true } | { allowed: false; reason: string };

export interface RequestOriginGuard {
  check(headers: Record<string, string | string[] | undefined>): RequestOriginVerdict;
  /** The @fastify/cors `origin` option: false (no CORS), '*', or the exact allowlist. */
  readonly corsOrigin: false | '*' | string[];
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '::1' || /^127(?:\.\d{1,3}){3}$/.test(hostname);
}

function normalizeHostname(hostname: string): string {
  return hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');
}

/** Hostname of a Host header value, or undefined when it does not parse. */
function hostnameOf(hostHeader: string): string | undefined {
  try {
    return normalizeHostname(new URL(`http://${hostHeader}`).hostname);
  } catch {
    return undefined;
  }
}

function header(
  headers: Record<string, string | string[] | undefined>,
  name: string
): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function validateOrigin(origin: string): string {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    throw new Error(`Invalid allowed origin '${origin}': expected scheme://host[:port]`);
  }
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.origin !== origin) {
    throw new Error(`Invalid allowed origin '${origin}': expected scheme://host[:port]`);
  }
  return origin;
}

function validateHostname(host: string): string {
  const hostname = normalizeHostname(host);
  const bracketedIpv6 = /^\[[0-9a-f:]+\]$/i.test(host);
  if ((host.includes(':') && !bracketedIpv6) || hostnameOf(host) !== hostname) {
    throw new Error(`Invalid allowed host '${host}': expected a hostname without port`);
  }
  return hostname;
}

export function createRequestOriginGuard(
  options: RequestOriginGuardOptions,
  warn: (message: string) => void = console.warn
): RequestOriginGuard {
  const wildcard = options.allowedOrigins?.includes('*') ?? false;
  const origins = (options.allowedOrigins ?? []).filter((o) => o !== '*').map(validateOrigin);
  const hosts = new Set((options.allowedHosts ?? []).map(validateHostname));
  const checkHost = isLoopbackHostname(normalizeHostname(options.bindHost)) || hosts.size > 0;
  const trustedHostname = (hostname: string) => isLoopbackHostname(hostname) || hosts.has(hostname);
  if (wildcard) {
    warn(
      "[agentbrowser] AGENTBROWSER_CORS_ORIGINS includes '*': ANY web page the operator visits can call this API. In no-keys local mode that is full unauthenticated control of every session, including local file upload. Use exact origins instead."
    );
  }

  return {
    corsOrigin: wildcard ? '*' : origins.length > 0 ? origins : false,
    check(headers) {
      const host = header(headers, 'host');
      const hostname = host === undefined ? undefined : hostnameOf(host);
      if (checkHost && (hostname === undefined || !trustedHostname(hostname))) {
        return { allowed: false, reason: 'Host header is not an allowed name for this service' };
      }
      const origin = header(headers, 'origin');
      const allowedOrigin = origin !== undefined && (wildcard || origins.includes(origin));
      if (origin !== undefined && !allowedOrigin) {
        let sameOrigin = false;
        try {
          const parsed = new URL(origin);
          sameOrigin =
            host !== undefined &&
            hostname !== undefined &&
            trustedHostname(hostname) &&
            parsed.host === new URL(`${parsed.protocol}//${host}`).host;
        } catch {
          // 'null' and malformed origins are never same-origin.
        }
        if (!sameOrigin) {
          return { allowed: false, reason: 'Browser origin is not allowed to call this service' };
        }
      }
      const site = header(headers, 'sec-fetch-site');
      if ((site === 'cross-site' || site === 'same-site') && !allowedOrigin) {
        return { allowed: false, reason: 'Cross-site browser requests are not allowed' };
      }
      return { allowed: true };
    },
  };
}

function listFromEnvironment(name: string, raw: string | undefined): string[] {
  const value = raw?.trim() ?? '';
  if (value === '') return [];
  const entries = value.split(',').map((entry) => entry.trim());
  if (entries.some((entry) => entry === '')) {
    throw new Error(`${name} contains an empty entry`);
  }
  return entries;
}

/** Operator startup configuration only; never read from session/request input. */
export function requestOriginGuardFromEnvironment(
  env: {
    AGENTBROWSER_CORS_ORIGINS?: string | undefined;
    AGENTBROWSER_ALLOWED_HOSTS?: string | undefined;
  },
  bindHost: string,
  corsOrigin?: string | readonly string[],
  warn: (message: string) => void = console.warn
): RequestOriginGuard {
  const programmatic =
    corsOrigin === undefined ? [] : typeof corsOrigin === 'string' ? [corsOrigin] : corsOrigin;
  return createRequestOriginGuard(
    {
      bindHost,
      allowedHosts: listFromEnvironment(
        'AGENTBROWSER_ALLOWED_HOSTS',
        env.AGENTBROWSER_ALLOWED_HOSTS
      ),
      allowedOrigins: [
        ...listFromEnvironment('AGENTBROWSER_CORS_ORIGINS', env.AGENTBROWSER_CORS_ORIGINS),
        ...programmatic,
      ],
    },
    warn
  );
}
