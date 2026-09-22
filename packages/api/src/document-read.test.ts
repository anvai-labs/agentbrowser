import { ArtifactStore, SecretManager } from '@agentbrowser/core';
import { FakeEngine } from '@agentbrowser/testkit';
import { expect, it, vi } from 'vitest';
import { AgentBrowserService } from './service.js';

async function fixture(
  run: (f: Awaited<ReturnType<typeof setup>>) => Promise<void>,
  controlled = false
) {
  const f = await setup(controlled);
  try {
    await run(f);
  } finally {
    await f.service.shutdown();
  }
}
async function setup(controlled: boolean) {
  const engine = new FakeEngine();
  const artifacts = new ArtifactStore();
  const service = new AgentBrowserService({
    engine,
    artifactStore: artifacts,
    secretManager: new SecretManager({ 'vault://test': 'private-value' }),
  });
  const { sessionId } = await service.createSession({
    tenantId: 'owner',
    ...(controlled ? { controlMode: 'delegated' as const } : {}),
  });
  const run = async <T>(fn: () => Promise<T>) =>
    controlled
      ? service.authority.run(sessionId, { actor: 'operator', tenant: 'owner' }, {}, fn)
      : fn();
  const result = await run(() => service.createPage(sessionId));
  if (!('pageId' in result)) throw new Error('Unexpected replay');
  const pageId = result.pageId;
  await run(() => service.navigate(sessionId, pageId, { url: 'https://example.com/jobs' }));
  const engineId = engine.getSessionIds()[0];
  const page = engineId ? engine.getFakePage(engineId, pageId) : undefined;
  if (!page) throw new Error('Missing fake page');
  page.setContent(
    '<!DOCTYPE html><html><head><title>Jobs</title></head><body><h1>Jobs</h1><p>private-value</p><a href="/job/1">Role</a></body></html>'
  );
  const raw = await page.observe({});
  const readDocument = vi.fn(async () => ({
    url: raw.url,
    title: raw.title,
    content: raw.content,
  }));
  Object.assign(page, { readDocument });
  return { service, sessionId, pageId, page, raw, readDocument, run, artifacts };
}

it('extracts document data and exports HTML without constructing interactive references', async () => {
  await fixture(async (f) => {
    const observe = vi
      .spyOn(f.page, 'observe')
      .mockRejectedValue(new Error('Interactive binding must not run'));
    const text = await f.service.extract(f.sessionId, f.pageId, { format: 'text' });
    expect(JSON.stringify(text)).toContain('***');
    expect(JSON.stringify(text)).not.toContain('private-value');
    const links = await f.service.extract(f.sessionId, f.pageId, { format: 'links' });
    expect(links.data).toEqual([{ text: 'Role', url: 'https://example.com/job/1' }]);
    const html = await f.service.exportHtml(f.sessionId, f.pageId);
    const stored = f.service.getArtifact(f.sessionId, html.artifactId);
    expect(Buffer.from(stored?.bytes ?? []).toString()).toBe(f.raw.content);
    expect(html.description).toContain('NOT secret-redacted');
    expect(f.readDocument).toHaveBeenCalledTimes(3);
    expect(observe).not.toHaveBeenCalled();
  });
});

it('retains full observation for form extraction and legacy engines', async () => {
  await fixture(async (f) => {
    const observe = vi.spyOn(f.page, 'observe');
    await f.service.extract(f.sessionId, f.pageId, { format: 'forms' });
    expect(observe).toHaveBeenCalledTimes(1);
    expect(f.readDocument).not.toHaveBeenCalled();
    Object.assign(f.page, { readDocument: undefined });
    await f.service.extract(f.sessionId, f.pageId, { format: 'text' });
    await f.service.exportHtml(f.sessionId, f.pageId);
    expect(observe).toHaveBeenCalledTimes(3);
  });
});

it('does not fall back after an implemented document reader fails', async () => {
  await fixture(async (f) => {
    const observe = vi.spyOn(f.page, 'observe');
    f.readDocument.mockRejectedValue(new Error('read unavailable'));
    await expect(f.service.extract(f.sessionId, f.pageId, { format: 'links' })).rejects.toThrow();
    await expect(f.service.exportHtml(f.sessionId, f.pageId)).rejects.toThrow();
    expect(observe).not.toHaveBeenCalled();
  });
});

it('keeps the document primitive under existing controlled admission', async () => {
  await fixture(async (f) => {
    await expect(f.service.extract(f.sessionId, f.pageId, { format: 'text' })).rejects.toThrow();
    expect(f.readDocument).not.toHaveBeenCalled();
    await f.run(() => f.service.extract(f.sessionId, f.pageId, { format: 'text' }));
    expect(f.readDocument).toHaveBeenCalledTimes(1);
  }, true);
});

for (const format of [
  'text',
  'markdown',
  'links',
  'tables',
  'jsonld',
  'schema',
  'records',
] as const) {
  it(`preserves ${format} extraction output on the optional document path`, async () => {
    await fixture(async (f) => {
      const request = {
        format,
        ...(format === 'schema' ? { schema: { properties: { title: { type: 'string' } } } } : {}),
        ...(format === 'records'
          ? { records: { container: 'a', fields: { name: ':scope' } } }
          : {}),
      };
      Object.assign(f.page, { readDocument: undefined });
      const baseline = await f.service.extract(f.sessionId, f.pageId, request);
      Object.assign(f.page, { readDocument: f.readDocument });
      const observe = vi.spyOn(f.page, 'observe').mockRejectedValue(new Error('AX unavailable'));
      expect(await f.service.extract(f.sessionId, f.pageId, request)).toEqual(baseline);
      expect(observe).not.toHaveBeenCalled();
    });
  });
}

for (const operation of ['extract', 'html'] as const)
  it(`withholds ${operation} after takeover during a document read`, async () => {
    await fixture(async (f) => {
      let release!: () => void;
      let entered!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const ready = new Promise<void>((resolve) => {
        entered = resolve;
      });
      f.readDocument.mockImplementation(async () => {
        entered();
        await gate;
        return f.raw;
      });
      const put = vi.spyOn(f.artifacts, 'put');
      const read = f.run(() =>
        operation === 'extract'
          ? f.service.extract(f.sessionId, f.pageId, { format: 'text' })
          : f.service.exportHtml(f.sessionId, f.pageId)
      );
      const rejected = expect(read).rejects.toThrow();
      await ready;
      f.service.authority.takeover(f.sessionId);
      release();
      await rejected;
      expect(put).not.toHaveBeenCalled();
    }, true);
  });

it('maps a document-reader crash through shared session recovery', async () => {
  await fixture(async (f) => {
    f.readDocument.mockRejectedValue(new Error('Target page, context or browser has been closed'));
    await expect(
      f.service.extract(f.sessionId, f.pageId, { format: 'text' })
    ).rejects.toMatchObject({ code: 'ENGINE_CRASHED' });
    expect(f.service.getSession(f.sessionId)).toBeUndefined();
  });
});
