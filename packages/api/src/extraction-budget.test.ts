import { SecretManager } from '@agentbrowser/core';
import { FakeEngine } from '@agentbrowser/testkit';
import { expect, it, vi } from 'vitest';
import { buildServer } from './server.js';

async function fixture(
  check: (f: {
    post(body: unknown): ReturnType<Awaited<ReturnType<typeof buildServer>>['inject']>;
    read: ReturnType<typeof vi.fn>;
  }) => Promise<void>,
  extractMaxBytes = 16384
) {
  const engine = new FakeEngine();
  const server = await buildServer({
    engine,
    extractMaxBytes,
    secretManager: new SecretManager({ 'vault://budget': 'SECRET-DATA' }),
  });
  try {
    const { sessionId } = (
      await server.inject({ method: 'POST', url: '/v1/sessions', payload: { tenantId: 'local' } })
    ).json();
    const { pageId } = (
      await server.inject({ method: 'POST', url: `/v1/sessions/${sessionId}/pages`, payload: {} })
    ).json();
    const page = engine.getFakePage(engine.getSessionIds()[0] ?? '', pageId);
    if (!page) throw new Error('Missing fake page');
    const read = vi.fn(async () => ({
      url: 'https://example.com/',
      title: 'Budget',
      content: `<body>${'😀'.repeat(1500)}TAIL</body>`,
    }));
    Object.assign(page, { readDocument: read });
    await check({
      read,
      post: (body) =>
        server.inject({
          method: 'POST',
          url: `/v1/sessions/${sessionId}/pages/${pageId}/extract`,
          payload: body as object,
        }),
    });
  } finally {
    await server.close();
  }
}

it('returns complete >4KB extraction and enforces the exact UTF-8 response budget', async () => {
  await fixture(async ({ post }) => {
    const full = await post({ format: 'text', maxBytes: 16384 });
    expect(full.statusCode).toBe(200);
    expect(full.json().data.text).toBe(`${'😀'.repeat(1500)}TAIL`);
    const bytes = Buffer.byteLength(full.body);
    expect(bytes).toBeGreaterThan(4096);
    expect((await post({ format: 'text', maxBytes: bytes })).statusCode).toBe(200);
    const limited = await post({ format: 'text', maxBytes: bytes - 1 });
    expect(limited.statusCode).toBe(400);
    expect(limited.json()).toMatchObject({
      error: { code: 'OUTPUT_TRUNCATED', details: { maxBytes: bytes - 1, actualBytes: bytes } },
    });
    expect(limited.body).not.toContain('TAIL');
  });
});

it.each([0, -1, 1.5, '8192', null, 16385, 9007199254740992])(
  'refuses invalid/over-ceiling maxBytes %s before reading the page',
  async (maxBytes) => {
    await fixture(async ({ post, read }) => {
      expect((await post({ format: 'text', maxBytes })).statusCode).toBe(400);
      expect(read).not.toHaveBeenCalled();
    });
  }
);

it('measures the returned redacted envelope rather than the larger private source', async () => {
  await fixture(async ({ post, read }) => {
    read.mockResolvedValue({
      url: 'https://example.com/',
      title: 'Budget',
      content: `<body>${'SECRET-DATA'.repeat(600)}</body>`,
    });
    const full = await post({ format: 'text' });
    expect(full.statusCode).toBe(200);
    expect(full.body).not.toContain('SECRET-DATA');
    const bytes = Buffer.byteLength(full.body);
    expect(bytes).toBeLessThan(4096);
    expect((await post({ format: 'text', maxBytes: bytes })).statusCode).toBe(200);
    expect((await post({ format: 'text', maxBytes: bytes - 1 })).statusCode).toBe(400);
  });
});

it('applies the configured server ceiling when the request omits maxBytes', async () => {
  await fixture(async ({ post }) => {
    const result = await post({ format: 'text' });
    expect(result.statusCode).toBe(400);
    expect(result.json()).toMatchObject({
      error: { details: { maxBytes: 1024, serverMaxBytes: 1024 } },
    });
  }, 1024);
});

it.each(['text', 'markdown', 'links', 'tables', 'forms', 'jsonld', 'schema', 'records'])(
  'enforces the shared budget for %s without slicing structured output',
  async (format) => {
    await fixture(async ({ post }) => {
      const result = await post({
        format,
        maxBytes: 1,
        ...(format === 'schema' ? { schema: { properties: { title: { type: 'string' } } } } : {}),
        ...(format === 'records'
          ? { records: { container: 'body', fields: { text: 'body' } } }
          : {}),
      });
      expect(result.statusCode).toBe(400);
      expect(result.json().error.code).toBe('OUTPUT_TRUNCATED');
      expect(result.json()).not.toHaveProperty('data');
    });
  }
);

it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
  'fails closed on invalid embedded server ceiling %s',
  async (extractMaxBytes) => {
    await expect(buildServer({ engine: new FakeEngine(), extractMaxBytes })).rejects.toThrow();
  }
);
