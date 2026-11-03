// P1-6c (ADR-033): operator-side cookie-seed extraction from an ALREADY-OPEN
// operator Chrome over loopback CDP. This is explicitly NOT the protected
// login-browser handoff of ADR-025: the port is not a credential boundary
// (anything that can reach it can read that browser's state), it never starts
// a browser, never reads a profile database, never calls browser-wide
// Storage.getCookies as a substitute (tab-context Network.getCookies is the
// only source — browser-level reads miss session cookies), and never touches
// passwords/localStorage/IndexedDB. Values go straight to the private seed
// file (exclusive 0600 via writeCookieFile); results carry counts and advisory
// metadata only.
import { createHash } from 'node:crypto';
import { SCOPE_HOST_PATTERN } from '@agentbrowser/protocol';
import { UsageError } from '@agentbrowser/sdk-typescript';

/** The minimal CDP surface the extraction needs; fakes drive the tests. */
export interface CdpClient {
  send(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<unknown>;
  close(): void;
}

/** Structural socket types: this package compiles without the DOM lib. */
interface SocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: 'open' | 'error' | 'close', listener: (event: unknown) => void): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
}
type SocketFactory = (url: string) => SocketLike;

type FetchLike = (
  url: string,
  init?: {
    redirect?: 'manual';
    signal?: AbortSignal;
  }
) => Promise<{ status: number; json(): Promise<unknown> }>;

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
const CDP_TIMEOUT_MS = 5000;

/**
 * Connect to the operator Chrome's browser endpoint on a loopback port.
 * The version fetch is bounded and NON-REDIRECTING (a redirect is refused,
 * not followed); the browser WebSocket URL it reports must itself be loopback
 * ws://. A wrong port, a silent endpoint or a redirect all refuse with the
 * same operator-facing hint — no guessing about what is listening.
 */
export async function connectLoopbackCdp(
  port: number,
  deps: { fetch?: FetchLike; openSocket?: SocketFactory; timeoutMs?: number } = {}
): Promise<CdpClient> {
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new UsageError('The CDP port must be an integer between 1 and 65535.');
  const doFetch = deps.fetch ?? fetch;
  let version: unknown;
  try {
    const response = await doFetch(`http://127.0.0.1:${port}/json/version`, {
      redirect: 'manual',
      signal: AbortSignal.timeout(deps.timeoutMs ?? CDP_TIMEOUT_MS),
    });
    if (response.status !== 200) throw new Error(`status ${response.status}`);
    version = await response.json();
  } catch {
    throw new UsageError(
      `No loopback CDP endpoint answered on 127.0.0.1:${port}; open the operator Chrome with a debugging port first.`
    );
  }
  const wsUrl = (version as { webSocketDebuggerUrl?: unknown } | null)?.webSocketDebuggerUrl;
  if (typeof wsUrl !== 'string' || wsUrl === '')
    throw new UsageError('The CDP endpoint did not report a browser WebSocket URL.');
  let parsed: URL;
  try {
    parsed = new URL(wsUrl);
  } catch {
    throw new UsageError('The CDP endpoint reported an unusable browser WebSocket URL.');
  }
  if (parsed.protocol !== 'ws:' || !LOOPBACK_HOSTS.has(parsed.hostname))
    throw new UsageError(
      'The CDP browser WebSocket URL must be loopback ws:// — refusing a non-loopback or TLS endpoint.'
    );
  const openSocket =
    deps.openSocket ??
    ((url: string) => {
      const candidate = (globalThis as Record<string, unknown>).WebSocket;
      if (typeof candidate !== 'function')
        throw new UsageError('This runtime has no WebSocket client for CDP.');
      return new (candidate as new (u: string) => SocketLike)(url);
    });
  let socket: SocketLike;
  try {
    socket = openSocket(wsUrl);
  } catch {
    throw new UsageError('Could not open the CDP browser WebSocket.');
  }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new UsageError('The CDP browser WebSocket did not open in time.')),
      deps.timeoutMs ?? CDP_TIMEOUT_MS
    );
    socket.addEventListener('open', () => {
      clearTimeout(timer);
      resolve();
    });
    socket.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new UsageError('Could not open the CDP browser WebSocket.'));
    });
  });
  let nextId = 0;
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  socket.addEventListener('message', (event) => {
    let message: unknown;
    try {
      message = JSON.parse(String(event.data));
    } catch {
      return;
    }
    if (message === null || typeof message !== 'object' || !('id' in message)) return;
    const entry = pending.get((message as { id: unknown }).id as number);
    if (entry === undefined) return;
    pending.delete((message as { id: unknown }).id as number);
    const error = (message as { error?: { message?: unknown } }).error;
    if (error !== undefined)
      entry.reject(new UsageError(`CDP command failed: ${String(error.message ?? 'unknown')}`));
    else entry.resolve((message as { result?: unknown }).result);
  });
  return {
    send: (method, params, sessionId) =>
      new Promise((resolve, reject) => {
        nextId += 1;
        const id = nextId;
        const message: Record<string, unknown> = { id, method, ...(params ? { params } : {}) };
        if (sessionId !== undefined) message.sessionId = sessionId;
        pending.set(id, { resolve, reject });
        try {
          socket.send(JSON.stringify(message));
        } catch (error) {
          pending.delete(id);
          reject(error instanceof Error ? error : new UsageError('CDP send failed.'));
        }
      }),
    close: () => {
      try {
        socket.close();
      } catch {
        // Closing a dead socket is success for our purposes.
      }
    },
  };
}

interface CdpTargetInfo {
  type?: unknown;
  targetId?: unknown;
  url?: unknown;
  browserContextId?: unknown;
}

interface CdpCookie {
  name?: unknown;
  value?: unknown;
  domain?: unknown;
  path?: unknown;
  expires?: unknown;
  httpOnly?: unknown;
  secure?: unknown;
  sameSite?: unknown;
}

export interface SeedFromCdpRequest {
  /** 1..20 host filters (exact host or ".suffix"); cookies outside them never enter the file. */
  domains: string[];
  /** default = the shared context; incognito = an explicitly identified non-default context. */
  context: 'default' | 'incognito';
  /** Explicit incognito browser-context id or unique prefix, required when several are open. */
  browserContext?: string;
  /** Injectable clock (tests); default real now. */
  now?: () => Date;
}

export interface ExtractedCdpSeed {
  /** Mapped CDP cookies, pre-normalization — writeCookieFile does the strict pass. */
  cookies: Array<Record<string, unknown>>;
  provenance: {
    source: 'operator-cdp';
    sourceContext: 'default' | 'incognito';
    sourceContextSha256?: string;
    extractedAt: string;
    domainFilters: string[];
  };
  /** Origin of the tab the cookies were read from (never the full URL). */
  selectedTabOrigin: string;
}

const hostUnder = (hostname: string, filter: string): boolean => {
  const base = filter.replace(/^\./, '').toLowerCase();
  return hostname === base || hostname.endsWith(`.${base}`);
};

/**
 * Select the context and one matching tab, then read TAB-CONTEXT
 * Network.getCookies for the domain URLs and map them to the seed shape.
 * Attaches only matching page targets; multiple open incognito contexts
 * require an explicit selection (ADR-033); zero matching tabs refuse.
 */
export async function extractSeedFromCdp(
  client: CdpClient,
  request: SeedFromCdpRequest
): Promise<ExtractedCdpSeed> {
  const domains = [...new Set(request.domains.map((d) => d.toLowerCase()))].sort();
  if (domains.length < 1 || domains.length > 20)
    throw new UsageError('Pass between 1 and 20 --domain filters.');
  for (const domain of domains)
    if (!new RegExp(`^${SCOPE_HOST_PATTERN}$`).test(domain))
      throw new UsageError(`Domain filter '${domain}' must be a hostname or .suffix entry.`);

  let targets: { targetInfos: unknown };
  try {
    targets = (await client.send('Target.getTargets')) as { targetInfos: unknown };
  } catch {
    throw new UsageError('Could not list the operator Chrome targets over CDP.');
  }
  const pages = (Array.isArray(targets.targetInfos) ? targets.targetInfos : []).filter(
    (t): t is Required<CdpTargetInfo> =>
      t !== null && typeof t === 'object' && (t as CdpTargetInfo).type === 'page'
  ) as Array<{ type: string; targetId: string; url: string; browserContextId?: string }>;

  let contextId: string | undefined;
  if (request.context === 'incognito') {
    const ids = [
      ...new Set(
        pages
          .map((p) => p.browserContextId)
          .filter((id): id is string => typeof id === 'string' && id !== '')
      ),
    ];
    if (request.browserContext !== undefined) {
      const wanted = request.browserContext;
      contextId = ids.find((id) => id === wanted || id.startsWith(wanted));
      if (contextId === undefined)
        throw new UsageError(
          `No incognito context matches '${request.browserContext}' (open: ${
            ids
              .slice(0, 3)
              .map((id) => id.slice(0, 8))
              .join(', ') || 'none'
          }).`
        );
    } else if (ids.length === 1) {
      contextId = ids[0];
    } else if (ids.length === 0) {
      throw new UsageError('No incognito tabs are open in the operator Chrome.');
    } else {
      throw new UsageError(
        `Multiple incognito contexts are open; select one with --browser-context (open: ${ids
          .slice(0, 3)
          .map((id) => id.slice(0, 8))
          .join(', ')}).`
      );
    }
  }
  const matchingContext = pages.filter((p) =>
    request.context === 'default'
      ? p.browserContextId === undefined
      : p.browserContextId === contextId
  );

  const tabHost = (url: string): string | undefined => {
    try {
      return new URL(url).hostname;
    } catch {
      return undefined; // an unparseable target URL is not a matching tab
    }
  };
  const tab = matchingContext.find(
    (p) => tabHost(p.url) !== undefined && domains.some((d) => hostUnder(tabHost(p.url) ?? '', d))
  );
  if (tab === undefined)
    throw new UsageError(
      `No open tab in the ${request.context} context matches ${domains.join(', ')}; open the site in that context first.`
    );
  const tabOrigin = new URL(tab.url).origin;

  let attached: { sessionId?: unknown };
  try {
    attached = (await client.send('Target.attachToTarget', {
      targetId: tab.targetId,
      flatten: true,
    })) as { sessionId?: unknown };
  } catch {
    throw new UsageError('Could not attach to the selected tab.');
  }
  const sessionId = attached.sessionId;
  if (typeof sessionId !== 'string' || sessionId === '')
    throw new UsageError('CDP did not return a session for the selected tab.');

  let result: { cookies?: unknown };
  try {
    // Tab-context cookies only: the browser-wide Storage.getCookies call
    // misses session cookies and is never used as a substitute (ADR-033).
    result = (await client.send(
      'Network.getCookies',
      { urls: domains.map((d) => `https://${d.replace(/^\./, '')}/`) },
      sessionId
    )) as { cookies?: unknown };
  } catch {
    throw new UsageError('Could not read cookies from the selected tab.');
  }
  const raw = (Array.isArray(result.cookies) ? result.cookies : []).filter(
    (c): c is CdpCookie => c !== null && typeof c === 'object'
  );

  const cookies: Array<Record<string, unknown>> = [];
  for (const entry of raw) {
    const name = String(entry.name ?? '');
    const value = String(entry.value ?? '');
    const domain = String(entry.domain ?? '');
    const path = String(entry.path ?? '/') || '/';
    if (name === '' || value === '' || domain === '')
      throw new UsageError('CDP returned a cookie without name, value or domain.');
    // Defense in depth: the URL bound should already scope the answer, but
    // the filter is applied to the cookie domains too, never trusted.
    const bare = domain.replace(/^\./, '');
    if (
      !domains.some(
        (d) => bare === d.replace(/^\./, '') || bare.endsWith(`.${d.replace(/^\./, '')}`)
      )
    )
      continue;
    const expires = typeof entry.expires === 'number' ? entry.expires : 0;
    const sameSite = entry.sameSite;
    cookies.push({
      name,
      value,
      domain,
      path,
      ...(expires > 0 ? { expires: Math.round(expires) } : {}),
      ...(entry.httpOnly === true ? { httpOnly: true } : {}),
      ...(entry.secure === true ? { secure: true } : {}),
      ...(sameSite === 'Strict' || sameSite === 'Lax' || sameSite === 'None' ? { sameSite } : {}),
    });
  }
  if (cookies.length > 1000)
    throw new UsageError(
      `Extraction returned ${cookies.length} cookies; the seed file is bounded to 1000 — narrow the domain filters.`
    );

  return {
    cookies,
    provenance: {
      source: 'operator-cdp',
      sourceContext: request.context,
      ...(request.context === 'incognito' && contextId !== undefined
        ? { sourceContextSha256: createHash('sha256').update(contextId).digest('hex') }
        : {}),
      extractedAt: (request.now ?? (() => new Date()))().toISOString(),
      domainFilters: domains,
    },
    selectedTabOrigin: tabOrigin,
  };
}
