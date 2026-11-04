// P1-6c (ADR-033): the operator-side CDP extraction — context/tab selection,
// tab-context cookie mapping, provenance, and the loopback guards. Driven by
// a fake CDP client (receiver-independent canaries); values never appear in
// errors or diagnostics.
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseCookieSeedFile } from '@agentbrowser/protocol';
import { UsageError } from '@agentbrowser/sdk-typescript';
import { describe, expect, it } from 'vitest';
import { writeCookieFile } from './cookie-file.js';
import { type CdpClient, connectLoopbackCdp, extractSeedFromCdp } from './seed-from-cdp.js';

interface Page {
  type: string;
  targetId: string;
  url: string;
  browserContextId?: string;
}

function fakeClient(
  pages: Page[],
  cookies: Array<Record<string, unknown>>,
  nonDefaultContexts: string[] = []
) {
  const calls: string[] = [];
  let sessionId: string | undefined;
  const client: CdpClient = {
    async send(method, params, session) {
      calls.push(method);
      if (method === 'Target.getTargets') return { targetInfos: pages };
      if (method === 'Target.getBrowserContexts') return { browserContextIds: nonDefaultContexts };
      if (method === 'Target.attachToTarget') {
        sessionId = 'sess-1';
        return { sessionId: 'sess-1' };
      }
      if (method === 'Network.getCookies') {
        if (session !== 'sess-1') throw new Error('cookies read without an attached tab session');
        if ((params?.urls as string[] | undefined)?.length === 0)
          throw new Error('cookie read without URL binding');
        return { cookies };
      }
      throw new Error(`unexpected CDP command ${method}`);
    },
    close() {
      calls.push('close');
    },
  };
  return { client, calls, attached: () => sessionId !== undefined };
}

const DEFAULT_TAB: Page = {
  type: 'page',
  targetId: 't-default',
  url: 'https://www.vinted.com/member/items',
};
const INCOGNITO_TAB: Page = {
  type: 'page',
  targetId: 't-inco',
  url: 'https://www.vinted.com/',
  browserContextId: '24AF0011AABBCCDD',
};

describe('extractSeedFromCdp (P1-6c)', () => {
  it('reads tab-context cookies from the default context and maps the seed shape', async () => {
    const { client, calls } = fakeClient(
      [DEFAULT_TAB, INCOGNITO_TAB],
      [
        {
          name: 'session',
          value: 'sv',
          domain: '.vinted.com',
          path: '/',
          expires: -1,
          httpOnly: true,
          secure: true,
          sameSite: 'Unspecified',
        },
        {
          name: 'prefs',
          value: 'pv',
          domain: '.vinted.net',
          path: '/p',
          expires: 1893456000.7,
          sameSite: 'Lax',
        },
        // Never enters the file: outside the domain filters (defense in depth).
        { name: 'evil', value: 'x', domain: 'evil.example', path: '/' },
      ],
      [INCOGNITO_TAB.browserContextId ?? '']
    );
    const extracted = await extractSeedFromCdp(client, {
      domains: ['vinted.net', 'vinted.com'],
      context: 'default',
      now: () => new Date('2026-11-03T12:00:00.000Z'),
    });
    // Attached to the DEFAULT tab (the incognito one is a different context).
    expect(calls).toEqual([
      'Target.getTargets',
      'Target.getBrowserContexts',
      'Target.attachToTarget',
      'Network.getCookies',
    ]);
    expect(extracted.selectedTabOrigin).toBe('https://www.vinted.com');
    expect(extracted.cookies).toEqual([
      // Session cookie: expires omitted; Unspecified sameSite omitted.
      {
        name: 'session',
        value: 'sv',
        domain: '.vinted.com',
        path: '/',
        httpOnly: true,
        secure: true,
      },
      // Persistent: rounded epoch seconds (1893456000.7 -> ...601); Lax kept; flags only when true.
      {
        name: 'prefs',
        value: 'pv',
        domain: '.vinted.net',
        path: '/p',
        expires: 1893456001,
        sameSite: 'Lax',
      },
    ]);
    expect(extracted.provenance).toEqual({
      source: 'operator-cdp',
      sourceContext: 'default',
      extractedAt: '2026-11-03T12:00:00.000Z',
      domainFilters: ['vinted.com', 'vinted.net'],
    });
  });

  it('classifies the default context when Chrome stamps every target with a context id (156+)', async () => {
    // Real Chrome 156 shape: default-context targets carry a browserContextId
    // that Target.getBrowserContexts does NOT list.
    const stamped: Page = { ...DEFAULT_TAB, browserContextId: 'A0FD5180E54583F8' };
    const { client } = fakeClient(
      [stamped, INCOGNITO_TAB],
      [{ name: 's', value: 'v', domain: '.vinted.com', path: '/' }],
      [INCOGNITO_TAB.browserContextId ?? '']
    );
    const extracted = await extractSeedFromCdp(client, {
      domains: ['vinted.com'],
      context: 'default',
    });
    expect(extracted.selectedTabOrigin).toBe('https://www.vinted.com');
    expect(extracted.provenance.sourceContext).toBe('default');
    expect(extracted.cookies).toHaveLength(1);
  });

  it('selects the single incognito context and stamps its digest; a prefix selects among several', async () => {
    const second: Page = {
      ...INCOGNITO_TAB,
      targetId: 't-inco2',
      browserContextId: '99BB2211EEFF0011',
    };
    const { client } = fakeClient([DEFAULT_TAB, INCOGNITO_TAB], []);
    const extracted = await extractSeedFromCdp(client, {
      domains: ['vinted.com'],
      context: 'incognito',
    });
    expect(extracted.selectedTabOrigin).toBe('https://www.vinted.com');
    expect(extracted.provenance.sourceContext).toBe('incognito');
    expect(extracted.provenance.sourceContextSha256).toHaveLength(64);

    const several = fakeClient([DEFAULT_TAB, INCOGNITO_TAB, second], []);
    // Without an explicit selection, several open incognito contexts refuse.
    await expect(
      extractSeedFromCdp(several.client, { domains: ['vinted.com'], context: 'incognito' })
    ).rejects.toThrow(/--browser-context/);
    // An explicit unique prefix selects exactly that context's tab.
    const picked = await extractSeedFromCdp(several.client, {
      domains: ['vinted.com'],
      context: 'incognito',
      browserContext: '99BB',
    });
    expect(picked.selectedTabOrigin).toBe('https://www.vinted.com');
    await expect(
      extractSeedFromCdp(several.client, {
        domains: ['vinted.com'],
        context: 'incognito',
        browserContext: ' DEADBEEF',
      })
    ).rejects.toThrow(/No incognito context matches/);
  });

  it('refuses an ambiguous --browser-context prefix instead of selecting the first match (F4)', async () => {
    const a: Page = { ...INCOGNITO_TAB, targetId: 't-a' };
    const b: Page = { ...INCOGNITO_TAB, targetId: 't-b', browserContextId: '24AF0099AABB0000' };
    const { client } = fakeClient([DEFAULT_TAB, a, b], []);
    await expect(
      extractSeedFromCdp(client, {
        domains: ['vinted.com'],
        context: 'incognito',
        browserContext: '24AF',
      })
    ).rejects.toThrow(/matches 2 incognito contexts/);
  });

  it('refuses when no tab matches, no incognito pages exist, or the filters are invalid', async () => {
    const unrelated: Page = { type: 'page', targetId: 't-x', url: 'https://other.example/' };
    const none = fakeClient([unrelated, INCOGNITO_TAB], [], [INCOGNITO_TAB.browserContextId ?? '']);
    await expect(
      extractSeedFromCdp(none.client, { domains: ['vinted.com'], context: 'default' })
    ).rejects.toThrow(/No open tab in the default context/);
    const noIncognito = fakeClient([DEFAULT_TAB], []);
    await expect(
      extractSeedFromCdp(noIncognito.client, { domains: ['vinted.com'], context: 'incognito' })
    ).rejects.toThrow(/No incognito tabs/);
    const { client } = fakeClient([DEFAULT_TAB], []);
    await expect(extractSeedFromCdp(client, { domains: [], context: 'default' })).rejects.toThrow(
      /between 1 and 20/
    );
    await expect(
      extractSeedFromCdp(client, { domains: ['https://vinted.com'], context: 'default' })
    ).rejects.toThrow(/hostname or \.suffix/);
  });

  it('is bounded to 1000 cookies and writes an exclusive 0600 v1 seed via writeCookieFile', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'seed-cdp-'));
    try {
      const many = Array.from({ length: 1001 }, (_, i) => ({
        name: `c${i}`,
        value: 'v',
        domain: '.vinted.com',
        path: '/',
      }));
      const over = fakeClient([DEFAULT_TAB], many);
      await expect(
        extractSeedFromCdp(over.client, { domains: ['vinted.com'], context: 'default' })
      ).rejects.toThrow(/bounded to 1000/);

      // Expired rows are omitted by the strict pass, with a counted skip.
      const expiring = fakeClient(
        [DEFAULT_TAB],
        [
          {
            name: 'live',
            value: 'v',
            domain: '.vinted.com',
            path: '/',
            expires: Math.floor(Date.now() / 1000) + 3600,
            secure: true,
          },
          {
            name: 'dead',
            value: 'v',
            domain: '.vinted.com',
            path: '/',
            expires: Math.floor(Date.now() / 1000) - 3600,
          },
        ]
      );
      const extracted = await extractSeedFromCdp(expiring.client, {
        domains: ['vinted.com'],
        context: 'default',
        now: () => new Date('2026-11-03T12:00:00.000Z'),
      });
      const out = join(dir, 'seed.json');
      const written = await writeCookieFile(out, extracted.cookies, extracted.provenance);
      expect(written.count).toBe(1); // the expired row never entered the file
      expect(statSync(out).mode & 0o777).toBe(0o600);
      const parsed = parseCookieSeedFile(JSON.parse(readFileSync(out, 'utf8')));
      expect(parsed.provenance.source).toBe('operator-cdp');
      expect(parsed.provenance.cookieClasses).toContain('persistent');
      // Exclusive creation: a second write to the same path refuses.
      await expect(writeCookieFile(out, [], extracted.provenance)).rejects.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('connectLoopbackCdp guards (P1-6c)', () => {
  const version = { webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/x' };
  const fetchReturning =
    (status: number, body: unknown) =>
    async (): Promise<{ status: number; json(): Promise<unknown> }> => ({
      status,
      json: async () => body,
    });

  it('refuses non-200 (redirects), missing and non-loopback browser URLs, bad ports', async () => {
    await expect(
      connectLoopbackCdp(9222, { fetch: fetchReturning(0, version) as never })
    ).rejects.toThrow(/No loopback CDP endpoint/);
    await expect(connectLoopbackCdp(0)).rejects.toThrow(/port/);
    await expect(
      connectLoopbackCdp(9222, { fetch: fetchReturning(200, {}) as never })
    ).rejects.toThrow(/did not report a browser WebSocket URL/);
    await expect(
      connectLoopbackCdp(9222, {
        fetch: fetchReturning(200, { webSocketDebuggerUrl: 'ws://10.0.0.5:9222/x' }) as never,
      })
    ).rejects.toThrow(/loopback/);
    await expect(
      connectLoopbackCdp(9222, {
        fetch: fetchReturning(200, { webSocketDebuggerUrl: 'wss://127.0.0.1:9222/x' }) as never,
      })
    ).rejects.toThrow(/loopback ws/);
  });

  it('surfaces a bounded operator error when the socket never opens', async () => {
    await expect(
      connectLoopbackCdp(9222, {
        fetch: fetchReturning(200, version) as never,
        openSocket: () => {
          throw new Error('boom');
        },
      })
    ).rejects.toThrow(UsageError);
  });
});
