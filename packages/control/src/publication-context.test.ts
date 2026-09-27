import { expect, it } from 'vitest';
import { composePublicationContext } from './publication.js';

it.each(['resolved', 'rejected'])(
  'refuses an asynchronous %s owner and latches refusal',
  async (mode) => {
    const context = { signal: new AbortController().signal, assertCurrent() {} };
    let calls = 0;
    const output = composePublicationContext(context, async () => {
      calls++;
      if (mode === 'rejected') throw new Error('private denial');
    });
    expect(() => output.assertCurrent()).toThrow();
    expect(() => output.assertCurrent()).toThrow();
    expect(calls).toBe(1);
    await Promise.resolve();
  }
);

it('rechecks the base lifetime after owner callbacks and cannot revive a refused context', () => {
  let current = true;
  const output = composePublicationContext(
    {
      signal: new AbortController().signal,
      assertCurrent() {
        if (!current) throw new Error('expired');
      },
    },
    () => {
      current = false;
    }
  );
  expect(() => output.assertCurrent()).toThrow();
  current = true;
  expect(() => output.assertCurrent()).toThrow();
});
