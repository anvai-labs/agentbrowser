// T10 P0-2: transport qualification only. This does not enable the fetch action
// or qualify request approval, egress, redirect admission or the durable journal.
import { createServer, type Server } from 'node:http';
import { gzipSync } from 'node:zlib';
import type { RequestPolicy } from '@agentbrowser/engine';
import { type Browser, chromium } from 'playwright';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { admitPageFetchResponse } from './page-fetch-admission.js';

let browser: Browser;
let server: Server;
let origin: string;
const hits: Array<{ path: string; method: string; body: string }> = [];
const text = 'é\u0000🚀';

beforeAll(async () => {
  server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const path = request.url ?? '/';
      hits.push({ path, method: request.method ?? 'GET', body: Buffer.concat(chunks).toString() });
      if (path === '/probe/gzip') {
        const compressed = gzipSync('é'.repeat(20000));
        response.writeHead(200, {
          'content-encoding': 'gzip',
          'content-length': compressed.length,
        });
        response.end(compressed);
      } else if (path === '/probe/headers') {
        for (let i = 0; i < 40; i++) response.setHeader(`x-padding-${i}`, 'v');
        response.setHeader('content-length', '2');
        response.end('ok');
      } else if (path.startsWith('/probe/empty/')) {
        response.writeHead(Number(path.split('/').at(-1)));
        response.end();
      } else if (path.startsWith('/probe/redirect/')) {
        response.writeHead(Number(path.split('/').at(-1)), { location: '/probe/ok' });
        response.end('redirect body');
      } else if (path === '/probe/terminal302') {
        response.writeHead(302);
        response.end(text);
      } else if (path === '/probe/stall') {
        response.writeHead(200);
        response.write('x'.repeat(70000));
      } else if (path === '/probe/ok') {
        response.writeHead(200, {
          'content-type': 'text/plain; charset=utf-8',
          'set-cookie': ['first=one; HttpOnly; Path=/', 'second=two; HttpOnly; Path=/'],
        });
        response.end(text);
      } else {
        response.end('<!doctype html><title>Transport admission fixture</title>');
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  browser = await chromium.launch({ headless: true });
}, 60000);

afterAll(async () => {
  await browser?.close();
  server?.closeAllConnections();
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function fixture(
  policy: Pick<RequestPolicy, 'checkResponse' | 'checkBodySize'>,
  run: (state: {
    page: import('playwright').Page;
    context: import('playwright').BrowserContext;
    abort: () => void;
    failures: unknown[];
    admitted: Array<{ status: number; kind: string; bytes?: number }>;
  }) => Promise<void>
) {
  const context = await browser.newContext();
  const controller = new AbortController();
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  const failures: unknown[] = [];
  const admitted: Array<{ status: number; kind: string; bytes?: number }> = [];
  const pending = new Set<Promise<void>>();
  cdp.on('Fetch.requestPaused', (event) => {
    const task = (async () => {
      try {
        const result = await admitPageFetchResponse(
          cdp,
          {
            requestId: event.requestId,
            method: event.request.method,
            status: event.responseStatusCode ?? 0,
            headers: event.responseHeaders ?? [],
          },
          policy,
          { signal: controller.signal, assertCurrent: () => {} }
        );
        admitted.push({
          status: event.responseStatusCode ?? 0,
          kind: result.kind,
          ...(result.kind === 'terminal' ? { bytes: result.body.length } : {}),
        });
        if (result.body === undefined) {
          await cdp.send('Fetch.continueResponse', { requestId: event.requestId });
        } else {
          try {
            await cdp.send('Fetch.fulfillRequest', {
              requestId: event.requestId,
              responseCode: event.responseStatusCode ?? 200,
              responseHeaders: [
                ...result.headers.filter(
                  ({ name }) =>
                    !['content-encoding', 'content-length', 'transfer-encoding'].includes(
                      name.toLowerCase()
                    )
                ),
                { name: 'Content-Length', value: String(result.body.length) },
              ],
              body: result.body.toString('base64'),
            });
          } finally {
            result.body.fill(0);
          }
        }
      } catch (error) {
        failures.push(error);
        await cdp
          .send('Fetch.failRequest', { requestId: event.requestId, errorReason: 'BlockedByClient' })
          .catch(() => {});
      }
    })();
    pending.add(task);
    void task.finally(() => pending.delete(task));
  });
  try {
    await cdp.send('Fetch.enable', {
      patterns: [{ urlPattern: `${origin}/probe/*`, requestStage: 'Response' }],
    });
    await page.goto(origin, { waitUntil: 'domcontentloaded' });
    await run({ page, context, abort: () => controller.abort(), failures, admitted });
  } finally {
    controller.abort();
    await context.close();
    await Promise.allSettled([...pending]);
  }
}

it('admits exact decoded bytes and retains both HttpOnly cookies', async () => {
  const bytes: number[] = [];
  await fixture(
    {
      checkBodySize: async (count) => {
        bytes.push(count);
      },
    },
    async ({ page, context, failures }) => {
      expect(
        await page.evaluate(async () =>
          (await fetch('/probe/ok', { method: 'PUT', body: 'request 🚀' })).text()
        )
      ).toBe(text);
      expect(failures).toEqual([]);
      expect(bytes.at(-1)).toBe(Buffer.byteLength(text));
      expect((await context.cookies()).map(({ name, httpOnly }) => ({ name, httpOnly }))).toEqual([
        { name: 'first', httpOnly: true },
        { name: 'second', httpOnly: true },
      ]);
      expect(hits.at(-1)).toEqual({ path: '/probe/ok', method: 'PUT', body: 'request 🚀' });
    }
  );
});

it('refuses decompressed bytes even when compressed Content-Length is below the floor', async () => {
  let declared = Number.POSITIVE_INFINITY;
  let actual = 0;
  await fixture(
    {
      checkResponse: async ({ headers }) => {
        declared = Number(headers['content-length']);
      },
      checkBodySize: async (bytes) => {
        actual = bytes;
        if (bytes > 4096) throw new Error('decoded floor');
      },
    },
    async ({ page, failures, admitted }) => {
      expect(
        await page.evaluate(async () =>
          fetch('/probe/gzip').then(
            () => 'published',
            () => 'denied'
          )
        )
      ).toBe('denied');
      expect(declared).toBeLessThan(4096);
      expect(actual).toBeGreaterThan(4096);
      expect(failures).toHaveLength(1);
      expect(admitted).toEqual([]);
    }
  );
});

it('checks declared length beyond 32 headers and refuses before body publication', async () => {
  let headerCount = 0;
  await fixture(
    {
      checkResponse: async ({ headers }) => {
        headerCount = Object.keys(headers).length;
        if (Number(headers['content-length']) > 1) throw new Error('declared floor');
      },
    },
    async ({ page, failures, admitted }) => {
      expect(
        await page.evaluate(async () =>
          fetch('/probe/headers').then(
            () => 'published',
            () => 'denied'
          )
        )
      ).toBe('denied');
      expect(headerCount).toBeGreaterThan(32);
      expect(failures).toHaveLength(1);
      expect(admitted).toEqual([]);
    }
  );
});

it.each([204, 205, 304])('admits bodyless status %i without a stream', async (status) => {
  const bytes: number[] = [];
  await fixture(
    {
      checkBodySize: async (count) => {
        bytes.push(count);
      },
    },
    async ({ page, failures }) => {
      expect(
        await page.evaluate(async (code) => {
          const result = await fetch(`/probe/empty/${code}`);
          return { status: result.status, text: await result.text() };
        }, status)
      ).toEqual({ status, text: '' });
      expect(bytes).toEqual([0]);
      expect(failures).toEqual([]);
    }
  );
});

it.each([301, 302, 303, 307, 308])(
  'qualifies redirect-header then terminal-body admission through native %i',
  async (status) => {
    const observed: number[] = [];
    await fixture(
      {
        checkBodySize: async (bytes) => {
          observed.push(bytes);
        },
      },
      async ({ page, failures, admitted }) => {
        const result = await page.evaluate(
          async (code) =>
            fetch(`/probe/redirect/${code}`, { method: 'PUT', body: 'redirect 🚀' }).then(
              (response) => response.text(),
              () => 'refused'
            ),
          status
        );
        expect(failures).toEqual([]);
        expect(result).toBe(text);
        expect(admitted).toEqual([
          { status, kind: 'redirect' },
          { status: 200, kind: 'terminal', bytes: Buffer.byteLength(text) },
        ]);
        expect(observed.filter((bytes) => bytes === 0)).toEqual([0]);
        expect(observed.at(-1)).toBe(Buffer.byteLength(text));
        expect(observed.every((bytes) => bytes === 0 || bytes === Buffer.byteLength(text))).toBe(
          true
        );
        expect(hits.at(-1)).toEqual({
          path: '/probe/ok',
          method: status === 303 ? 'GET' : 'PUT',
          body: status === 303 ? '' : 'redirect 🚀',
        });
      }
    );
  }
);

it('refuses redirect header policy before the destination receives a request', async () => {
  const start = hits.length;
  await fixture(
    {
      checkResponse: async ({ headers }) => {
        if (headers.location) throw new Error('redirect header floor');
      },
    },
    async ({ page, failures, admitted }) => {
      expect(
        await page.evaluate(async () =>
          fetch('/probe/redirect/307', { method: 'PUT', body: 'must not follow' }).then(
            () => 'published',
            () => 'denied'
          )
        )
      ).toBe('denied');
      expect(failures).toHaveLength(1);
      expect(admitted).toEqual([]);
      expect(hits.slice(start).filter(({ path }) => path === '/probe/ok')).toEqual([]);
    }
  );
});

it('admits a 302 without Location as a terminal body', async () => {
  await fixture({}, async ({ page, failures, admitted }) => {
    expect(await page.evaluate(async () => (await fetch('/probe/terminal302')).text())).toBe(text);
    expect(failures).toEqual([]);
    expect(admitted).toEqual([{ status: 302, kind: 'terminal', bytes: Buffer.byteLength(text) }]);
  });
});

it('admits HEAD headers and a zero-byte policy witness without acquiring a stream', async () => {
  const bytes: number[] = [];
  await fixture(
    {
      checkBodySize: async (count) => {
        bytes.push(count);
      },
    },
    async ({ page, failures, admitted }) => {
      expect(
        await page.evaluate(async () => (await fetch('/probe/ok', { method: 'HEAD' })).text())
      ).toBe('');
      expect(bytes).toEqual([0]);
      expect(failures).toEqual([]);
      expect(admitted).toEqual([{ status: 200, kind: 'bodyless' }]);
    }
  );
});

it('cancels a stalled decoded stream without publishing any response', async () => {
  let reading!: () => void;
  const ready = new Promise<void>((resolve) => {
    reading = resolve;
  });
  await fixture(
    {
      checkBodySize: async (bytes) => {
        if (bytes) reading();
      },
    },
    async ({ page, abort, admitted, failures }) => {
      const result = page.evaluate(async () =>
        fetch('/probe/stall').then(
          () => 'published',
          () => 'denied'
        )
      );
      await ready;
      abort();
      expect(await result).toBe('denied');
      expect(admitted).toEqual([]);
      expect(failures).toHaveLength(1);
    }
  );
});
