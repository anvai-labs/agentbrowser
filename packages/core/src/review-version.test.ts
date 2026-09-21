import { expect, it } from 'vitest';
import { SessionControl } from './session-control.js';

it('invalidates review on repeated human takeover without changing control epoch', () => {
  const control = new SessionControl();
  const epoch = control.view().epoch;
  const first = control.reviewVersion();
  control.takeover();
  const second = control.reviewVersion();
  control.takeover();
  expect(control.view().epoch).toBe(epoch);
  expect(second).not.toBe(first);
  expect(control.reviewVersion()).not.toBe(second);
});

it('rotates review versions for successful control transitions and stop', () => {
  const control = new SessionControl();
  const versions = [control.reviewVersion()];
  const review = control.prepareResume();
  versions.push(control.reviewVersion());
  control.delegate(review.epoch);
  versions.push(control.reviewVersion());
  control.takeover();
  versions.push(control.reviewVersion());
  control.stop();
  versions.push(control.reviewVersion());
  expect(new Set(versions).size).toBe(versions.length);
});

it('invalidates review on operator write admission, but not observations or replay', () => {
  const control = new SessionControl();
  control.prepareResume();
  const before = control.reviewVersion();
  const read = control.begin({ actor: 'operator' });
  if ('replay' in read) throw new Error('Unexpected replay');
  control.finish(read, 'completed');
  expect(control.reviewVersion()).toBe(before);
  const write = { actor: 'operator' as const, operationId: 'edit', fingerprint: 'edit' };
  const ticket = control.begin(write);
  if ('replay' in ticket) throw new Error('Unexpected replay');
  expect(control.reviewVersion()).not.toBe(before);
  const after = control.reviewVersion();
  control.finish(ticket, 'failed');
  expect(control.begin(write)).toHaveProperty('replay');
  expect(control.reviewVersion()).toBe(after);
});

it('leaves review version unchanged after invalid or busy transitions', () => {
  const control = new SessionControl();
  const first = control.reviewVersion();
  expect(() => control.delegate(0)).toThrow();
  expect(control.reviewVersion()).toBe(first);
  const review = control.prepareResume();
  const version = control.reviewVersion();
  expect(() => control.delegate(review.epoch - 1)).toThrow();
  const ticket = control.begin({ actor: 'operator' });
  if ('replay' in ticket) throw new Error('Unexpected replay');
  expect(() => control.prepareResume()).toThrow();
  expect(() => control.delegate(review.epoch)).toThrow();
  expect(control.reviewVersion()).toBe(version);
  control.finish(ticket, 'completed');
});
