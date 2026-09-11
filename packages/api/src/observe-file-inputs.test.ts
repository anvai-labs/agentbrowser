/**
 * include:["fileInputs"]: hidden <input type=file> elements get refs through
 * the full service pipeline - normalization, the ref bridge, and pagination -
 * so a minted ref attaches files even when the element is hidden or paginated
 * out of the delivered observation.
 */
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeEngine } from '@agentbrowser/testkit';
import { describe, expect, it } from 'vitest';
import { AgentBrowserService } from './service';

describe('observe include:["fileInputs"] service pipeline', () => {
  async function setup() {
    const engine = new FakeEngine();
    const service = new AgentBrowserService({ engine });
    const session = await service.createSession({ tenantId: 't1' });
    const sessionId = session.sessionId;
    const pageId = (await service.createPage(sessionId)).pageId;
    const engineSessionId = engine.getSessionIds().at(-1);
    if (engineSessionId === undefined) throw new Error('no engine session');
    const fakePage = engine.getFakePage(engineSessionId, pageId);
    if (!fakePage) throw new Error('no fake page');
    fakePage.seedElements([
      { ref: 'e2_90', role: 'button', name: 'Submit', visible: true },
      { ref: 'e2_91', role: 'fileinput', name: 'avatar', visible: true },
      { ref: 'e2_92', role: 'fileinput', name: 'dropzone', visible: false },
    ]);
    return { engine, service, sessionId, pageId };
  }

  it('mints refs for hidden inputs only under the token, and the ref attaches files', async () => {
    const { service, sessionId, pageId } = await setup();

    const withoutToken = await service.observe(sessionId, pageId, {});
    expect(
      withoutToken.elements.filter((element) => element.role === 'fileinput').map((e) => e.name)
    ).toEqual(['avatar']);

    const withToken = await service.observe(sessionId, pageId, { include: ['fileInputs'] });
    const fileInputs = withToken.elements.filter((element) => element.role === 'fileinput');
    expect(fileInputs.map((element) => element.name)).toEqual(['avatar', 'dropzone']);
    expect(fileInputs.map((element) => element.visible)).toEqual([true, false]);
    expect(fileInputs[1].attributes).toEqual({});

    const hidden = fileInputs.find((element) => element.visible === false);
    if (!hidden) throw new Error('hidden file input missing from observation');

    const dir = await mkdtemp(join(tmpdir(), 'ab-fileinputs-'));
    const file = join(dir, 'resume.pdf');
    const bytes = '%PDF-fileinputs';
    await writeFile(file, bytes);

    const effect = await service.act(sessionId, pageId, {
      action: 'upload',
      target: { ref: hidden.ref },
      paths: [file],
    });
    expect(effect.status).toBe('success');
    expect(effect.result).toMatchObject({
      success: true,
      files: [{ name: 'resume.pdf', size: bytes.length }],
    });
  });

  it('keeps a minted ref usable after its element is truncated out of the observation', async () => {
    const { service, sessionId, pageId } = await setup();

    const full = await service.observe(sessionId, pageId, { include: ['fileInputs'] });
    const hidden = full.elements.find(
      (element) => element.role === 'fileinput' && element.visible === false
    );
    if (!hidden) throw new Error('hidden file input missing from observation');

    const paginated = await service.observe(sessionId, pageId, {
      include: ['fileInputs'],
      maxElements: 2,
    });
    expect(paginated.truncated).toBe(true);
    expect(paginated.elements.some((element) => element.ref === hidden.ref)).toBe(false);

    const dir = await mkdtemp(join(tmpdir(), 'ab-fileinputs-'));
    const file = join(dir, 'resume.pdf');
    await writeFile(file, 'pdf');

    // Refs are minted pre-pagination: the delivered page dropped the element,
    // but the ref still resolves against the engine's raw element index.
    const effect = await service.act(sessionId, pageId, {
      action: 'upload',
      target: { ref: hidden.ref },
      paths: [file],
    });
    expect(effect.status).toBe('success');
  });
});
