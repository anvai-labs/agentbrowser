import { expect, it, vi } from 'vitest';
import { SessionAuthority, type SessionPrincipal } from './session-authority.js';

const operator: SessionPrincipal = { actor: 'operator', tenant: 'owner' };
function fixture() {
  const authority = new SessionAuthority();
  authority.register('session', 'owner', new AbortController().signal);
  return authority;
}
function binding(authority: SessionAuthority) {
  return authority.run('session', operator, {}, async () =>
    authority.reviewBindingInScope('session')
  );
}

it('projects frozen owner identity only inside a current operator operation', async () => {
  const authority = fixture();
  expect(() => authority.reviewBindingInScope('session')).toThrow();
  let late!: Promise<unknown>;
  let release!: () => void;
  await authority.run('session', operator, {}, async () => {
    const result = authority.reviewBindingInScope('session');
    expect(result).toEqual({
      tenant: 'owner',
      sessionId: 'session',
      sessionIncarnation: authority.sessionIncarnation('session'),
      epoch: 0,
      reviewVersion: authority.get('session')!.reviewVersion(),
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(() => Object.assign(result, { tenant: 'forged' })).toThrow();
    expect(() => authority.reviewBindingInScope('other')).toThrow();
    late = new Promise<void>((resolve) => {
      release = resolve;
    }).then(() => {
      expect(() => authority.reviewBindingInScope('session')).toThrow();
    });
  });
  release();
  await late;
});

it('refuses delegated credentials, foreign tenants and resume-review state', async () => {
  const authority = fixture();
  await expect(
    authority.run('session', { actor: 'operator', tenant: 'other' }, {}, async () =>
      authority.reviewBindingInScope('session')
    )
  ).rejects.toThrow();
  const review = authority.get('session')!.prepareResume();
  await expect(binding(authority)).rejects.toThrow();
  const { token } = authority.delegate('session', review.epoch);
  await expect(
    authority.run('session', authority.authenticate(token)!, {}, async () =>
      authority.reviewBindingInScope('session')
    )
  ).rejects.toThrow();
});

it('distinguishes repeated takeover at the same epoch and reused session IDs', async () => {
  const authority = fixture();
  const first = await binding(authority);
  authority.takeover('session');
  const second = await binding(authority);
  expect(second).toMatchObject({ epoch: 0 });
  expect(second).not.toEqual(first);
  authority.remove('session');
  authority.register('session', 'owner', new AbortController().signal);
  const third = await binding(authority);
  expect(third).not.toEqual(second);
});

it.each([false, true])(
  'invalidates configuration even when its callback throws: %s',
  async (fail) => {
    const authority = fixture();
    const before = await binding(authority);
    const change = () => {
      if (fail) throw new Error('Configuration failed');
      return 'changed';
    };
    if (fail)
      expect(() => authority.configure('session', operator, change)).toThrow(
        'Configuration failed'
      );
    else expect(authority.configure('session', operator, change)).toBe('changed');
    expect(await binding(authority)).not.toEqual(before);
    authority.get('session')!.prepareResume();
    expect(() =>
      authority.configure('session', operator, () => {
        throw new Error('Changed');
      })
    ).toThrow();
    expect(authority.status('session').state).toBe('HUMAN_ACTIVE');
  }
);

it('refuses review capture during nested configuration and restores the outer marker', async () => {
  const authority = fixture();
  const attempts: Promise<unknown>[] = [];
  authority.configure('session', operator, () => {
    authority.configure('session', operator, () => 'nested');
    attempts.push(binding(authority));
  });
  await expect(attempts[0]).rejects.toThrow();
  expect(await binding(authority)).toMatchObject({ tenant: 'owner' });
});

it('does not revoke a replacement session from configuration cleanup', () => {
  const authority = fixture();
  let replacementToken = '';
  expect(() =>
    authority.configure('session', operator, () => {
      authority.remove('session');
      authority.register('session', 'owner', new AbortController().signal);
      const review = authority.get('session')!.prepareResume();
      replacementToken = authority.delegate('session', review.epoch).token;
    })
  ).toThrow();
  expect(authority.authenticate(replacementToken)).toBeDefined();
  expect(authority.status('session').state).toBe('AGENT_ACTIVE');
});

it('rejects foreign configuration before callback and preserves current review', async () => {
  const authority = fixture();
  const before = await binding(authority);
  const change = vi.fn();
  expect(() =>
    authority.configure('session', { actor: 'operator', tenant: 'other' }, change)
  ).toThrow();
  expect(change).not.toHaveBeenCalled();
  expect(await binding(authority)).toEqual(before);
});

it('snapshots principal getters before selecting the configuration owner', () => {
  const authority = fixture();
  const change = vi.fn();
  const reentrant: SessionPrincipal = {
    actor: 'operator',
    get tenant() {
      authority.remove('session');
      authority.register('session', 'replacement', new AbortController().signal);
      return 'owner';
    },
  };
  expect(() => authority.configure('session', reentrant, change)).toThrow();
  expect(change).not.toHaveBeenCalled();
  expect(authority.status('session')).toMatchObject({ state: 'HUMAN_ACTIVE', epoch: 0 });
});

it('rejects asynchronous configuration results and invalidates the captured review', async () => {
  const authority = fixture();
  const before = await binding(authority);
  expect(() =>
    authority.configure('session', operator, () => Promise.reject(new Error('late')))
  ).toThrow();
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(await binding(authority)).not.toEqual(before);
});

it.each(['takeover', 'stop', 'replace', 'expire'] as const)(
  'refuses binding in an operation after %s',
  async (change) => {
    let now = 0;
    const authority = new SessionAuthority({ now: () => now });
    authority.register('session', 'owner', new AbortController().signal, { ttlMs: 100 });
    await expect(
      authority.run('session', operator, {}, async () => {
        authority.reviewBindingInScope('session');
        if (change === 'takeover') authority.takeover('session');
        if (change === 'stop') authority.get('session')!.stop();
        if (change === 'replace') {
          authority.remove('session');
          authority.register('session', 'owner', new AbortController().signal);
        }
        if (change === 'expire') now = 100;
        expect(() => authority.reviewBindingInScope('session')).toThrow();
      })
    ).rejects.toThrow();
  }
);
