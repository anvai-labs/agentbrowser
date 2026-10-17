import { createServer } from 'node:http';
import { EngineError, type RequestPolicy } from '@agentbrowser/engine';
import { EngagementScopePolicy, NetworkPolicy } from '@agentbrowser/policy';
import { SCOPE_DENIAL_CODES } from '@agentbrowser/protocol';
import { describe, expect, it, vi } from 'vitest';
import { ConnectionAuthority, ConnectionBudget } from './connection-authority.js';
import { DownloadBudget, DownloadTransport } from './download-transport.js';

const secret = 'synthetic-credential-not-for-output';
const destination = {
  kind: 'request' as const,
  url: `http://download.invalid/file?token=${secret}`,
  hostname: 'download.invalid',
  port: 80,
};
const deny = (scope: unknown): RequestPolicy => ({
  checkRequest: async () => {
    throw new EngineError('POLICY_DENIED', secret, true, {
      scope,
      token: secret,
      url: destination.url,
      reason: secret,
    });
  },
  checkResolvedAddresses: async () => {},
});

describe('download scope denial reporting', () => {
  it.each(SCOPE_DENIAL_CODES)(
    'preserves %s through connection and download sanitization',
    async (scope) => {
      const resolve = vi.fn(async () => [{ address: '127.0.0.1', family: 4 }]);
      const transport = new DownloadTransport(
        { policy: deny(scope), budget: new DownloadBudget() },
        { resolve }
      );
      try {
        const failure = await transport
          .download(destination.url, { maxBytes: 1024 })
          .catch((error) => error);
        expect(failure).toBeInstanceOf(EngineError);
        expect(failure).toMatchObject({
          code: 'POLICY_DENIED',
          message: 'Download failed',
          retryable: false,
        });
        expect(failure.details).toEqual({ stage: 'connect', reason: 'transferFailed', scope });
        expect(JSON.stringify(failure)).not.toContain(secret);
        expect(resolve).not.toHaveBeenCalled();
      } finally {
        transport.revoke();
      }
    }
  );

  it.each([undefined, null, 1, { token: secret }, `SCOPE_HOST_DENIED:${secret}`])(
    'drops unknown scope values and arbitrary details at each sanitizer (%j)',
    async (scope) => {
      const policy = deny(scope);
      const resolve = vi.fn(async () => [{ address: '127.0.0.1', family: 4 }]);
      const authority = new ConnectionAuthority(
        { policy, admission: new ConnectionBudget().createSessionScope() },
        { resolve }
      );
      const fetch = vi.fn(async () => ({ bytes: new Uint8Array(), contentType: 'text/plain' }));
      // The fetch fixture takes the policy denial straight to the download sanitizer,
      // independently of the connection sanitizer exercised above.
      const transport = new DownloadTransport({ policy, budget: new DownloadBudget() }, { fetch });
      try {
        const connectionFailure = await authority
          .connect(destination, { deadline: performance.now() + 5000 })
          .catch((error) => error);
        expect(connectionFailure).toMatchObject({
          code: 'POLICY_DENIED',
          message: 'Connection failed',
          retryable: false,
        });
        expect(connectionFailure.details).toEqual({ stage: 'policy', reason: 'callbackFailure' });
        const downloadFailure = await transport
          .download(destination.url, { maxBytes: 1024 })
          .catch((error) => error);
        expect(downloadFailure).toMatchObject({
          code: 'POLICY_DENIED',
          message: 'Download failed',
          retryable: false,
        });
        expect(downloadFailure.details).toEqual({ stage: 'admission', reason: 'transferFailed' });
        expect(JSON.stringify([connectionFailure, downloadFailure])).not.toContain(secret);
        expect(resolve).not.toHaveBeenCalled();
        expect(fetch).not.toHaveBeenCalled();
      } finally {
        transport.revoke();
        authority.revoke();
        await authority.closed;
      }
    }
  );

  it.each(['connection', 'fetch'])(
    'reads the original scope value only once (%s)',
    async (mode) => {
      const scope = vi.fn().mockReturnValueOnce('SCOPE_HOST_DENIED').mockReturnValue(secret);
      const policy: RequestPolicy = {
        checkRequest: async () => {
          throw new EngineError('POLICY_DENIED', secret, false, {
            get scope() {
              return scope();
            },
          });
        },
        checkResolvedAddresses: async () => {},
      };
      const transport = new DownloadTransport(
        { policy, budget: new DownloadBudget() },
        mode === 'fetch'
          ? { fetch: async () => ({ bytes: new Uint8Array(), contentType: 'text/plain' }) }
          : {}
      );
      try {
        const failure = await transport
          .download(destination.url, { maxBytes: 1024 })
          .catch((error) => error);
        expect(failure.details.scope).toBe('SCOPE_HOST_DENIED');
        expect(scope).toHaveBeenCalledOnce();
        expect(JSON.stringify(failure)).not.toContain(secret);
      } finally {
        transport.revoke();
      }
    }
  );

  it.each(['initial', 'redirect', 'unknown redirect'])(
    'reports a real %s scope refusal without contacting the denied host',
    async (mode) => {
      const hits: string[] = [];
      const server = createServer((request, response) => {
        hits.push(request.url ?? '');
        response.writeHead(302, { location: `http://denied.invalid/file?token=${secret}` });
        response.end();
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const resolve = vi.fn(async () => [{ address: '127.0.0.1', family: 4 }]);
      const policy = new EngagementScopePolicy(new NetworkPolicy(), {
        allowedHosts: ['download.invalid'],
      });
      const checkRedirectChain = policy.checkRedirectChain.bind(policy);
      policy.checkRedirectChain = async (chain) => {
        try {
          await checkRedirectChain(chain);
        } catch (cause) {
          const original = cause as { details?: { scope?: unknown } };
          throw new EngineError('POLICY_DENIED', secret, true, {
            scope:
              mode === 'unknown redirect' ? `SCOPE_HOST_DENIED:${secret}` : original.details?.scope,
            token: secret,
            url: chain.at(-1)?.url,
          });
        }
      };
      const transport = new DownloadTransport(
        { policy, budget: new DownloadBudget() },
        { resolve }
      );
      try {
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('Missing fixture address');
        const url =
          mode === 'initial'
            ? `http://denied.invalid:${address.port}/file?token=${secret}`
            : `http://download.invalid:${address.port}/start`;
        const failure = await transport.download(url, { maxBytes: 1024 }).catch((error) => error);
        expect(failure).toMatchObject({ code: 'POLICY_DENIED', message: 'Download failed' });
        expect(failure.details).toEqual({
          stage: mode === 'initial' ? 'connect' : 'redirect',
          reason: 'transferFailed',
          ...(mode === 'unknown redirect' ? {} : { scope: 'SCOPE_HOST_DENIED' }),
        });
        expect(JSON.stringify(failure)).not.toContain(secret);
        expect(JSON.stringify(failure)).not.toContain('denied.invalid');
        expect(hits).toEqual(mode === 'initial' ? [] : ['/start']);
        expect(resolve).toHaveBeenCalledTimes(mode === 'initial' ? 0 : 1);
      } finally {
        transport.revoke();
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    }
  );
});
