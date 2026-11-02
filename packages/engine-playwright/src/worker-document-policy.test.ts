import { expect, it } from 'vitest';
import { denyWorkersInDocument } from './worker-document-policy.js';

it('adds an independent enforced worker policy without relaxing or mutating site restrictions', () => {
  const original = {
    'Content-Security-Policy': "default-src 'self'; script-src 'none'",
    'content-type': 'text/html',
  };
  expect(denyWorkersInDocument(original)).toEqual({
    ...original,
    'Content-Security-Policy': "default-src 'self'; script-src 'none', worker-src 'none'",
  });
  expect(original['Content-Security-Policy']).toBe("default-src 'self'; script-src 'none'");
  expect(denyWorkersInDocument({})).toEqual({ 'content-security-policy': "worker-src 'none'" });
});

it('refuses a native response when worker CSP installation fails and records failure, never success', async () => {
  const { BodyRedirectGuard } = await import('./body-redirect-guard.js');
  const outcomes: Array<{ type: string; data: Record<string, unknown> }> = [];
  const sent: Array<{ method: string; params: unknown }> = [];
  const guard = new BodyRedirectGuard({ on() {}, pages: () => [] } as any, {
    blockDocumentWorkers: true,
    maxHops: 10,
    verdictOf: async () => ({ verdict: 'allow' }),
    onBlocked() {},
    onOutcome: (outcome) => outcomes.push(outcome),
  });
  const chain = {
    networkId: 'network',
    key: 'POST https://app.test/',
    current: { method: 'POST', url: 'https://app.test/' },
    headers: {},
    hops: 0,
    seen: new Set(['https://app.test/']),
  };
  const target = {
    chains: new Map([['network', chain]]),
    unclaimed: new Map(),
    cdp: {
      send: async (method: string, params: unknown) => {
        sent.push({ method, params });
        if (method === 'Fetch.takeResponseBodyAsStream') return { stream: 'body' };
        if (method === 'IO.read') return { data: '', eof: true };
        if (method === 'Fetch.fulfillRequest') throw new Error('CDP header override failed');
      },
    },
  };
  await (guard as any).paused(target, {
    requestId: 'request',
    networkId: 'network',
    resourceType: 'Document',
    request: { method: 'POST', url: 'https://app.test/' },
    responseStatusCode: 200,
    responseHeaders: [{ name: 'Content-Security-Policy', value: "img-src 'none'" }],
  });
  expect(sent.find((entry) => entry.method === 'Fetch.fulfillRequest')).toMatchObject({
    method: 'Fetch.fulfillRequest',
    params: {
      body: '',
      responseHeaders: [
        { name: 'Content-Length', value: '0' },
        { name: 'Content-Security-Policy', value: "img-src 'none', worker-src 'none'" },
      ],
    },
  });
  expect(sent.at(-1)?.method).toBe('Fetch.failRequest');
  // No header override was ever applied to this chain, so the fail-closed
  // outcome names the response pipeline, not a header-policy failure.
  expect(outcomes).toEqual([
    expect.objectContaining({
      type: 'request.failed',
      data: expect.objectContaining({ detail: 'RESPONSE_UNCHECKABLE' }),
    }),
  ]);
  expect(target.chains.size).toBe(0);
});
