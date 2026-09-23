import { createHash } from 'node:crypto';
import {
  ApplicationAuthority,
  ApplicationSessions,
  type SessionPrincipal,
} from '@agentbrowser/control';
import { expect, it, vi } from 'vitest';
import { type DraftSnapshot, createApplicationDraft } from './test-support/application-draft.js';

const operator: SessionPrincipal = { actor: 'operator', tenant: 'owner' };
const fields = {
  fullName: 'Synthetic Person',
  currentCompany: 'Current Co',
  previousCompany: 'Previous Co',
  preference: 'remote',
  relocation: null,
  referral: '',
  terms: true,
};
const bytes = Buffer.from('Synthetic attachment bytes');

it('reads the named complete draft inside one existing operator admission without dispatch', async () => {
  const draft = createApplicationDraft({ id: 'scoped-draft' });
  draft.update(0, fields);
  draft.upload(1, { name: 'candidate.pdf', type: 'application/pdf', bytes });
  const sessions = new ApplicationSessions();
  const { sessionId } = sessions.create(operator);
  const app = new ApplicationAuthority(sessions.authority, [draft.adapter]);
  app.bind(sessionId, operator, { adapter: draft.adapter.id, resource: 'scoped-draft' });
  const run = vi.spyOn(sessions.authority, 'run');
  try {
    await sessions.authority.run(
      sessionId,
      operator,
      { id: 'outer-read', fingerprint: 'one-admission' },
      async () => {
        const admission = sessions.authority.admissionInScope(sessionId);
        const reader = app.prepareReadInScope(sessionId, { operation: 'read', input: {} });
        expect(reader.identity).toMatchObject({
          operation: 'read',
          sessionId,
          resource: 'scoped-draft',
          adapter: draft.adapter.id,
        });
        expect(reader.identity.admission).toBe(admission);
        const snapshot = (await reader.read()) as DraftSnapshot;
        expect(snapshot).toEqual(draft.read());
        expect(snapshot).toMatchObject({
          version: 2,
          complete: true,
          attachment: {
            name: 'candidate.pdf',
            sha256: createHash('sha256').update(bytes).digest('hex'),
          },
        });
        snapshot.fields.fullName = 'Caller mutation';
        expect(((await reader.read()) as DraftSnapshot).fields.fullName).toBe(fields.fullName);
        expect(draft.read().version).toBe(2);
        expect(sessions.authority.didDispatchInScope(sessionId)).toBe(false);
        // Fresh data comes from the application owner, not the prior detached response.
        draft.update(2, { terms: false });
        expect(await reader.read()).toMatchObject({
          version: 3,
          complete: false,
          missing: ['terms'],
        });
        expect(sessions.authority.admissionInScope(sessionId)).toBe(admission);
      }
    );
    expect(run).toHaveBeenCalledTimes(1);
  } finally {
    run.mockRestore();
    sessions.dispose();
  }
});

it('does not let a named draft reader escape its admission or mutate through a write operation', async () => {
  const draft = createApplicationDraft({ id: 'read-only' });
  const sessions = new ApplicationSessions();
  const { sessionId } = sessions.create(operator);
  const app = new ApplicationAuthority(sessions.authority, [draft.adapter]);
  app.bind(sessionId, operator, { adapter: draft.adapter.id, resource: 'read-only' });
  try {
    const reader = await sessions.authority.run(sessionId, operator, {}, async () => {
      expect(() =>
        app.prepareReadInScope(sessionId, { operation: 'update', input: fields })
      ).toThrow();
      expect(draft.read().version).toBe(0);
      return app.prepareReadInScope(sessionId, { operation: 'read', input: {} });
    });
    await expect(reader.read()).rejects.toThrow();
    await sessions.authority.run(sessionId, operator, {}, async () => {
      await expect(reader.read()).rejects.toThrow();
    });
    expect(draft.read().version).toBe(0);
  } finally {
    sessions.dispose();
  }
});

it('retains distinct source identities for drafts with identical answers', async () => {
  const drafts = ['first', 'second'].map((id) => createApplicationDraft({ id }));
  const sessions = new ApplicationSessions();
  const app = new ApplicationAuthority(
    sessions.authority,
    drafts.map((draft) => draft.adapter)
  );
  try {
    const observations = [];
    for (const draft of drafts) {
      draft.update(0, fields);
      const { sessionId } = sessions.create(operator);
      app.bind(sessionId, operator, { adapter: draft.adapter.id, resource: draft.read().id });
      observations.push(
        await sessions.authority.run(sessionId, operator, {}, async () => {
          const reader = app.prepareReadInScope(sessionId, { operation: 'read', input: {} });
          return { identity: reader.identity, snapshot: (await reader.read()) as DraftSnapshot };
        })
      );
    }
    expect(observations[0]?.snapshot.fields).toEqual(observations[1]?.snapshot.fields);
    expect(observations[0]?.identity).not.toEqual(observations[1]?.identity);
    expect(observations[0]?.snapshot.incarnation).not.toBe(observations[1]?.snapshot.incarnation);
  } finally {
    sessions.dispose();
  }
});
