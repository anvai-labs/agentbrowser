import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { checkRoleAccess, type RoleAccessCheckOptions } from './role-access-check.js';

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((done) => {
          server.closeAllConnections();
          server.close(() => done());
        })
    )
  );
});

/** A role/business-logic fixture pair: invoices owned by alice or bob, addressed by id.
 * vulnerable: any authenticated identity reads any invoice (IDOR).
 * fixed: only the owner reads an invoice; others get 404 (no existence oracle).
 * Every request's identity headers are recorded for the no-leak gate. */
async function startInvoiceFixture(mode: 'vulnerable' | 'fixed') {
  const invoices: Record<string, { owner: string; marker: string }> = {
    '1001': { owner: 'alice', marker: 'ALICE-PRIVATE-7f3a' },
    '2002': { owner: 'bob', marker: 'BOB-PRIVATE-91c4' },
  };
  const seen: Array<{ path: string; identity: string | undefined; headers: string[] }> = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const identity = request.headers['x-test-identity'] as string | undefined;
    seen.push({
      path: url.pathname,
      identity,
      headers: Object.keys(request.headers).filter((name) => name.startsWith('x-test-')),
    });
    const match = /^\/invoices\/(\d+)$/.exec(url.pathname);
    const invoice = match ? invoices[match[1] ?? ''] : undefined;
    if (identity === undefined) {
      response.writeHead(401).end();
      return;
    }
    if (invoice === undefined || (mode === 'fixed' && invoice.owner !== identity)) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ id: match?.[1], owner: invoice.owner, note: invoice.marker }));
  });
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return { port: address.port, seen };
}

const options = (port: number): RoleAccessCheckOptions => ({
  allowedHosts: [`127.0.0.1:${port}`],
  identities: {
    alice: { 'x-test-identity': 'alice' },
    bob: { 'x-test-identity': 'bob' },
  },
  resources: [
    { url: `http://127.0.0.1:${port}/invoices/1001`, owner: 'alice', marker: 'ALICE-PRIVATE-7f3a' },
    { url: `http://127.0.0.1:${port}/invoices/2002`, owner: 'bob', marker: 'BOB-PRIVATE-91c4' },
  ],
  now: () => new Date('2026-10-15T10:00:00.000Z'),
});

describe('role/business-logic fixture pair (T7 slice 3)', () => {
  it('vulnerable: each cross-identity read is a CONFIRMED broken-access-control finding with evidence', async () => {
    const fixture = await startInvoiceFixture('vulnerable');
    const result = await checkRoleAccess(options(fixture.port));
    expect(result.findings).toHaveLength(2);
    for (const finding of result.findings) {
      expect(finding.status).toBe('confirmed');
      expect(finding.risk).toBe('high');
      // Independent evidence: the non-owner received the owner's private marker.
      expect(finding.evidence.method).toBe('independent-reproduction');
      expect(finding.evidence.observation).toMatch(/owner's private marker/);
      // Read-only probe: nothing to clean up, and that is recorded explicitly.
      expect(finding.evidence.cleanup).toEqual({
        required: false,
        performed: false,
        note: 'read-only GET probe; no state created',
      });
    }
    expect(result.findings.map((finding) => `${finding.actor}->${finding.owner}`).sort()).toEqual([
      'alice->bob',
      'bob->alice',
    ]);
    // The finding never carries the private marker itself.
    expect(JSON.stringify(result.findings)).not.toMatch(/PRIVATE-/);
  });

  it('fixed: the same check finds nothing, and the owner controls still pass', async () => {
    const fixture = await startInvoiceFixture('fixed');
    const result = await checkRoleAccess(options(fixture.port));
    expect(result.findings).toEqual([]);
    expect(result.ownerControls).toEqual({ passed: 2, failed: 0 });
  });

  it('identities do not leak: every request carries exactly one identity, the intended one', async () => {
    const fixture = await startInvoiceFixture('vulnerable');
    await checkRoleAccess(options(fixture.port));
    for (const request of fixture.seen) {
      expect(request.headers).toEqual(['x-test-identity']);
      expect(['alice', 'bob']).toContain(request.identity);
    }
    // Owner control + one cross read per resource.
    expect(fixture.seen).toHaveLength(4);
  });

  it('a resource outside the allowed hosts is refused before any request', async () => {
    const fixture = await startInvoiceFixture('vulnerable');
    const scoped = options(fixture.port);
    await expect(
      checkRoleAccess({
        ...scoped,
        resources: [{ url: 'http://elsewhere.example/invoices/1', owner: 'alice', marker: 'X-1' }],
      })
    ).rejects.toThrow(/SCOPE_HOST_DENIED/);
    expect(fixture.seen).toHaveLength(0);
  });

  it('an owner that cannot read its own resource invalidates the fixture instead of passing', async () => {
    const fixture = await startInvoiceFixture('fixed');
    await expect(
      checkRoleAccess({
        ...options(fixture.port),
        resources: [
          { url: `http://127.0.0.1:${fixture.port}/invoices/1001`, owner: 'bob', marker: 'B' },
        ],
      })
    ).rejects.toThrow(/FIXTURE_INVALID/);
  });
});
