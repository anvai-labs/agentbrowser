import { request } from 'node:http';
import { expect, it } from 'vitest';
import { startDraftFixture } from './test-support/application-draft-http.js';
import { createApplicationDraft } from './test-support/application-draft.js';

it('commits only bounded fully received upload bytes and refuses submission', async () => {
  const draft = createApplicationDraft({ id: 'transport' });
  const fixture = await startDraftFixture(draft);
  const upload = (body: string | Uint8Array, version = 0, type = 'application/pdf') =>
    fetch(`${fixture.url}/upload`, {
      method: 'POST',
      headers: {
        'x-draft-filename': 'candidate.pdf',
        'x-draft-filetype': type,
        'x-draft-version': String(version),
        'x-draft-incarnation': draft.read().incarnation,
      },
      body,
    });
  try {
    expect((await upload(new Uint8Array(32769))).status).toBe(400);
    expect((await upload('invalid media', 0, 'text/plain')).status).toBe(400);
    expect(draft.read().version).toBe(0);
    expect((await upload('ACTUAL-BYTES')).status).toBe(200);
    expect(draft.read().attachment).toMatchObject({
      size: 12,
      name: 'candidate.pdf',
      type: 'application/pdf',
    });
    expect((await fetch(`${fixture.url}/submit`, { method: 'POST' })).status).toBe(403);
    expect(fixture.submissionAttempts()).toBe(1);
    expect(draft.read()).toMatchObject({ intent: 'draft', version: 1 });
  } finally {
    await fixture.close();
  }
});

it('captures upload version before await and fences a delayed upload after removal', async () => {
  const draft = createApplicationDraft({ id: 'delayed' });
  let release!: () => void;
  let entered!: () => void;
  const arrived = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fixture = await startDraftFixture(draft, {
    beforeUploadCommit: async () => {
      entered();
      await hold;
    },
  });
  try {
    const pending = fetch(`${fixture.url}/upload`, {
      method: 'POST',
      headers: {
        'x-draft-filename': 'resume.pdf',
        'x-draft-filetype': 'application/pdf',
        'x-draft-version': '0',
        'x-draft-incarnation': draft.read().incarnation,
      },
      body: 'old bytes',
    });
    await arrived;
    draft.remove(0);
    release();
    expect((await pending).status).toBe(409);
    expect(draft.read()).toMatchObject({ version: 1, attachment: null });
  } finally {
    release();
    await fixture.close();
  }
});

it('an interrupted upload never commits a partial attachment', async () => {
  const draft = createApplicationDraft({ id: 'interrupted' });
  const fixture = await startDraftFixture(draft);
  let req: ReturnType<typeof request> | undefined;
  try {
    const disconnected = new Promise<void>((resolve) => {
      req = request(`${fixture.url}/upload`, {
        method: 'POST',
        headers: {
          'content-length': '100',
          'x-draft-filename': 'resume.pdf',
          'x-draft-filetype': 'application/pdf',
          'x-draft-version': '0',
          'x-draft-incarnation': draft.read().incarnation,
        },
      });
      req.on('error', () => resolve());
      req.flushHeaders();
      req.write('partial');
    });
    await expect.poll(() => fixture.uploadAttempts()).toBe(1);
    req?.destroy();
    await disconnected;
    expect(draft.read()).toMatchObject({ version: 0, attachment: null });
  } finally {
    req?.destroy();
    await fixture.close();
  }
});
