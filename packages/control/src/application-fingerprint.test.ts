/**
 * T5 J-b: the operation identity. Ephemeral fingerprints are pinned to golden hashes captured
 * from develop's inline formula BEFORE durable existed, so they can never drift; durable uses its
 * own domain, so consent and replay can never cross requirements.
 */
import { canonicalJson } from '@agentbrowser/core';
import { describe, expect, it } from 'vitest';
import { applicationOperationFingerprint } from './application-authority.js';

const binding = {
  adapter: 'owned-counter',
  resource: 'account',
  generation: 'gen-1',
  tenant: 'owner',
};

describe('application operation fingerprint', () => {
  it.each([
    [
      'plain write',
      { operation: 'add', expectedVersion: 0 },
      canonicalJson(1),
      false,
      'a91c432af75363392f2c458455d113701c041c4534bd6ca05a458f6f8dab2439',
    ],
    [
      'protected write with token',
      { operation: 'submit', expectedVersion: 3, approvalToken: 'tok-1' },
      canonicalJson({ a: [1, 'x'] }),
      true,
      '1e71eefdcf5e9c0f93059260c6e724c1eb617c6364d2189a69c7885541161b98',
    ],
    [
      'protected without token',
      { operation: 'submit', expectedVersion: 3 },
      canonicalJson(null),
      true,
      'e445d52c1e95f807edb7cd5f449d0dbfdb70e58582988ccf7acf525abc16f67f',
    ],
    [
      'unprotected ignores token',
      { operation: 'add', expectedVersion: 7, approvalToken: 'tok-2' },
      canonicalJson('s'),
      false,
      '03a8cd241cb574aaeb2a78379ec197177d589b23cc713488bf56311a6414a5e6',
    ],
  ] as const)(
    'ephemeral %s is byte-identical to the pre-durable golden',
    (_name, request, input, protectedWrite, golden) => {
      expect(applicationOperationFingerprint(binding, request, input, protectedWrite)).toBe(golden);
    }
  );

  it('a durable request never shares an identity with the same ephemeral request', () => {
    const request = { operation: 'add', expectedVersion: 0 };
    const ephemeral = applicationOperationFingerprint(binding, request, canonicalJson(1), false);
    const durable = applicationOperationFingerprint(
      binding,
      { ...request, executionRequirement: 'durable' as const },
      canonicalJson(1),
      false
    );
    expect(durable).toMatch(/^[0-9a-f]{64}$/);
    expect(durable).not.toBe(ephemeral);
  });
});
