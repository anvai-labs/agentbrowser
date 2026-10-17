import { Value } from '@sinclair/typebox/value';
import { expect, it } from 'vitest';
import {
  ActionNavigationObservationSchema,
  parseActionNavigationObservation,
} from './action-navigation.js';
import { SCOPE_DENIAL_CODES } from './navigation-failure.js';

const observation = {
  status: 'blocked',
  reason: 'egress_policy',
  scope: 'SCOPE_HOST_DENIED',
  observedDuring: 'action',
};
it.each(SCOPE_DENIAL_CODES)('projects only bounded navigation facts for %s', (scope) => {
  const input = {
    ...observation,
    scope,
    url: 'https://private.invalid/?synthetic=hidden',
    headers: { authorization: 'fixture-marker' },
  };
  expect(Value.Check(ActionNavigationObservationSchema, input)).toBe(false);
  expect(parseActionNavigationObservation(input)).toEqual({ ...observation, scope });
});
it.each([
  null,
  [],
  {},
  { ...observation, scope: 'SCOPE_INVENTED' },
  { ...observation, scope: {} },
  { ...observation, status: 'success' },
  { ...observation, observedDuring: 'before_action' },
])('omits malformed observations', (input) => {
  expect(parseActionNavigationObservation(input)).toBeUndefined();
});
it('reads each fact once and omits throwing getters', () => {
  let reads = 0;
  expect(
    parseActionNavigationObservation({
      ...observation,
      get scope() {
        return ++reads === 1 ? 'SCOPE_PATH_DENIED' : 'fixture-marker';
      },
    })
  ).toEqual({ ...observation, scope: 'SCOPE_PATH_DENIED' });
  expect(reads).toBe(1);
  expect(
    parseActionNavigationObservation({
      ...observation,
      get scope() {
        throw new Error('fixture-marker');
      },
    })
  ).toBeUndefined();
});
