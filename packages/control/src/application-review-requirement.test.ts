/**
 * T5 J-b: the review intent (what the operator consents to) names a durable requirement, and an
 * ephemeral intent — explicit or omitted — is canonically identical to the pre-durable intent.
 */
import { canonicalJson } from '@agentbrowser/core';
import { afterEach, expect, it, vi } from 'vitest';
import { ApplicationAuthority, defineApplicationOperation } from './application-authority.js';
import { SessionAuthority } from './session-authority.js';

const operator = { actor: 'operator' as const, tenant: 'owner' };
const owners: SessionAuthority[] = [];
afterEach(() => {
  for (const owner of owners.splice(0)) owner.remove('s');
});

async function intentsFor(requirements: Array<'ephemeral' | 'durable' | undefined>) {
  const authority = new SessionAuthority();
  owners.push(authority);
  authority.register('s', 'owner', new AbortController().signal);
  const app = new ApplicationAuthority(
    authority,
    [
      {
        id: 'app',
        authorize: () => true,
        receipt: async () => null,
        operations: {
          submit: defineApplicationOperation({
            mode: 'write',
            review: 'operator-submit',
            parse: () => null,
            execute: async () => ({ status: 'committed' as const, value: 1 }),
          }),
        },
      },
    ],
    { consentPolicy: vi.fn(() => ({ consume: vi.fn(async () => true), assertCurrent: vi.fn() })) }
  );
  app.bind('s', operator, { adapter: 'app', resource: 'account' });
  const planned = (executionRequirement?: 'ephemeral' | 'durable') => ({
    operation: 'submit',
    input: { name: 'Synthetic' },
    operationId: 'submit-1',
    expectedVersion: 0,
    ...(executionRequirement !== undefined ? { executionRequirement } : {}),
  });
  return authority.run('s', operator, { id: 'review', fingerprint: 'review' }, async () =>
    requirements.map(
      (requirement) => app.prepareOperationReviewInScope('s', planned(requirement)).action
    )
  );
}

it('a durable review intent names the requirement the operator consents to', async () => {
  const [durable] = await intentsFor(['durable']);
  expect(durable).toMatchObject({ executionRequirement: 'durable', operation: 'submit' });
});

it('explicit ephemeral and omitted intents are identical and carry no requirement', async () => {
  const [omitted, explicit, durable] = await intentsFor([undefined, 'ephemeral', 'durable']);
  expect(omitted).not.toHaveProperty('executionRequirement');
  expect(canonicalJson(explicit)).toBe(canonicalJson(omitted));
  expect(canonicalJson(durable)).not.toBe(canonicalJson(omitted));
});
