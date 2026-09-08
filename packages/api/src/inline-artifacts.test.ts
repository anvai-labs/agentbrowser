/**
 * F8: inline artifact payloads. Small evidence (screenshot / pdf / html)
 * rides the response body under AGENTBROWSER_INLINE_ARTIFACT_MAX_BYTES;
 * the artifact is still registered in the store either way.
 */
import { FakeEngine } from '@agentbrowser/testkit';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentBrowserService } from './service';

const ENV = 'AGENTBROWSER_INLINE_ARTIFACT_MAX_BYTES';

async function setup() {
  const engine = new FakeEngine();
  const service = new AgentBrowserService({ engine });
  const session = await service.createSession({ tenantId: 't1' });
  const pageId = (await service.createPage(session.sessionId)).pageId;
  await service.navigate(session.sessionId, pageId, { url: 'https://example.com/' });
  return { service, session, pageId };
}

afterEach(() => {
  delete process.env[ENV];
});

describe('inline artifact payloads (F8)', () => {
  it('inlines small screenshots by default and the bytes match the stored artifact', async () => {
    const { service, session, pageId } = await setup();

    const shot = await service.screenshot(session.sessionId, pageId, { format: 'png' });

    const inline = (shot as { inline?: { contentBase64: string; byteSize: number } }).inline;
    expect(inline).toBeDefined();
    expect(typeof inline?.contentBase64).toBe('string');
    const stored = service.getArtifact(session.sessionId, shot.artifactId);
    expect(stored).toBeDefined();
    expect(inline?.byteSize).toBe(stored?.metadata.sizeBytes);
    expect(
      Buffer.from(inline?.contentBase64 ?? '', 'base64').equals(Buffer.from(stored?.bytes ?? []))
    ).toBe(true);
  });

  it('registers the artifact even when it is inlined', async () => {
    const { service, session, pageId } = await setup();
    const shot = await service.screenshot(session.sessionId, pageId, { format: 'png' });
    expect(service.getArtifact(session.sessionId, shot.artifactId)).toBeDefined();
  });

  it('suppresses inline payloads when the env threshold is below the artifact', async () => {
    process.env[ENV] = '1';
    const { service, session, pageId } = await setup();
    const shot = await service.screenshot(session.sessionId, pageId, { format: 'png' });
    expect((shot as { inline?: unknown }).inline).toBeUndefined();
  });

  it.each([
    ['invalid string falls back to the default', 'abc'],
    ['negative values fall back to the default', '-5'],
  ])('%s', async (_name, value) => {
    process.env[ENV] = value;
    const { service, session, pageId } = await setup();
    const shot = await service.screenshot(session.sessionId, pageId, { format: 'png' });
    expect((shot as { inline?: unknown }).inline).toBeDefined();
  });

  it('clamps the threshold at 10MiB', async () => {
    process.env[ENV] = '99999999999';
    const { service, session, pageId } = await setup();
    const shot = await service.screenshot(session.sessionId, pageId, { format: 'png' });
    expect((shot as { inline?: unknown }).inline).toBeDefined();
  });

  it('still rejects oversized payloads with ARTIFACT_TOO_LARGE', async () => {
    const engine = new FakeEngine();
    const service = new AgentBrowserService({ engine });
    const session = await service.createSession({ tenantId: 't1' });
    const pageId = (await service.createPage(session.sessionId)).pageId;
    await service.navigate(session.sessionId, pageId, { url: 'https://example.com/' });
    const engineSessionId = engine.getSessionIds()[0];
    const fakePage = engine.getFakePage(engineSessionId as string, pageId);
    if (!fakePage) throw new Error('no fake page');
    fakePage.screenshot = async () => ({
      bytesBase64: Buffer.alloc(11 * 1024 * 1024).toString('base64'),
      contentType: 'image/png',
    });

    const error = await service
      .screenshot(session.sessionId, pageId, { format: 'png' })
      .catch((e: unknown) => e as { code: string; message: string });
    // The store's ceiling still bites (mapped to INTERNAL outside the
    // download path per the frozen taxonomy); F8 must not swallow or
    // truncate it.
    expect(error.message).toContain('maximum');
  });

  it('inlines pdf captures', async () => {
    const { service, session, pageId } = await setup();
    const pdf = await service.pdf(session.sessionId, pageId, {});
    expect((pdf as { inline?: unknown }).inline).toBeDefined();
  });

  it('inlines html exports', async () => {
    const { service, session, pageId } = await setup();
    const html = await service.exportHtml(session.sessionId, pageId);
    const inline = (html as { inline?: { contentBase64: string; byteSize: number } }).inline;
    expect(inline).toBeDefined();
    expect(Buffer.from(inline?.contentBase64 ?? '', 'base64').toString('utf8')).toContain('<');
  });
});
