import type { EvidenceState } from '@agentbrowser/engine';
import { expect, it } from 'vitest';
import { evidenceOrigins, evidenceStateDigest, filterEvidenceState } from './evidence-state.js';

const scope = { allowedHosts: ['app.test'], allowedSchemes: ['https'], allowedPorts: [443] };
it('keeps Domain cookies for an authorized bare subtree and refuses a broader parent for a child grant', () => {
  const state: EvidenceState = {
    cookies: [{ name: 'sid', value: 'private-cookie', domain: '.example.com', path: '/api' }],
    origins: [],
  };
  expect(
    filterEvidenceState(state, { allowedHosts: ['example.com'] }, ['https://app.example.com'])
      .cookies
  ).toEqual(state.cookies);
  expect(
    filterEvidenceState(state, { allowedHosts: ['app.example.com'] }, ['https://app.example.com'])
      .cookies
  ).toEqual([]);
  expect(
    filterEvidenceState(
      state,
      { allowedHosts: ['example.com'], excludeHosts: ['blocked.example.com'] },
      ['https://app.example.com']
    ).cookies
  ).toEqual([]);
});
it('admits only exact program origins and refuses URL credentials, asset origins and other ports', () => {
  expect(evidenceOrigins(['https://app.test'], scope)).toEqual(['https://app.test']);
  expect(evidenceOrigins(['https://app.test'], { ...scope, allowedSchemes: ['HTTPS'] })).toEqual([
    'https://app.test',
  ]);
  for (const origin of [
    'http://app.test',
    'https://app.test:444',
    'https://cdn.test',
    'https://u:p@app.test',
    'https://app.test/path',
  ])
    expect(() => evidenceOrigins([origin], scope)).toThrow();
});
it('preserves cookie attributes, filters other origins and does not narrow Domain cookies', () => {
  const state: EvidenceState = {
    cookies: [
      {
        name: 'auth',
        value: 'private-auth-token',
        domain: 'app.test',
        path: '/',
        secure: true,
        httpOnly: true,
        sameSite: 'Strict',
      },
      { name: 'parent', value: 'private-parent-token', domain: '.app.test', path: '/' },
      { name: 'outside', value: 'outside-secret', domain: 'other.test', path: '/' },
    ],
    origins: [
      {
        origin: 'https://app.test',
        localStorage: [{ name: 'token', value: 'private-storage-token' }],
      },
      { origin: 'http://app.test', localStorage: [{ name: 'token', value: 'insecure-token' }] },
    ],
  };
  const result = filterEvidenceState(state, scope, ['https://app.test']);
  expect(result.cookies).toEqual([state.cookies[0]]);
  expect(result.origins).toEqual([state.origins[0]]);
  const digest = evidenceStateDigest(result);
  expect(JSON.stringify(digest)).not.toMatch(/private-|token|auth/);
  expect(digest.sha256).toMatch(/^[a-f0-9]{64}$/);
});
it('bounds captured state and refuses partitioned or invalid browser output', () => {
  expect(() =>
    filterEvidenceState(
      {
        cookies: [
          {
            name: 'c',
            value: 'v',
            domain: 'app.test',
            path: '/',
            partitionKey: 'https://app.test',
          },
        ],
        origins: [],
      } as never,
      scope,
      ['https://app.test']
    )
  ).toThrow();
  expect(() =>
    filterEvidenceState(
      {
        cookies: [],
        origins: [
          {
            origin: 'https://app.test',
            localStorage: [{ name: 'x', value: 'z'.repeat(1024 * 1024) }],
          },
        ],
      },
      scope,
      ['https://app.test']
    )
  ).toThrow();
});
