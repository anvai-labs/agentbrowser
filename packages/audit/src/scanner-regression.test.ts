import { type Server, createServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type ScannerBaseline,
  type ScannerScanResult,
  ZapClient,
  compareScannerFindings,
} from './scanner-regression.js';

const cleanup: Array<Promise<void>> = [];
const servers: Array<Server> = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    cleanup.push(new Promise<void>((done) => server.close(() => done())));
  }
  await Promise.all(cleanup.splice(0));
});

/** A fixture emulating the ZAP JSON API surface the adapter uses.
 * vulnerable: the scan finds a seeded SQL-injection alert on the target.
 * fixed: the same scan completes with zero alerts.
 * never-completes: status sticks below 100 (budget gate).
 * Each fixture records newSession calls for the cleanup gate. */
async function startZapFixture(mode: 'vulnerable' | 'fixed' | 'never-completes'): Promise<{
  port: number;
  newSessionCalls: () => number;
}> {
  let newSessionCalls = 0;
  const scanStartUrls: string[] = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const send = (value: unknown) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(value));
    };
    if (url.pathname === '/JSON/core/view/version/') {
      send({ version: '2.14.0-fixture' });
      return;
    }
    if (url.pathname === '/JSON/core/action/newSession/') {
      newSessionCalls += 1;
      send({ Result: 'OK' });
      return;
    }
    if (url.pathname === '/JSON/ascan/action/scan/') {
      scanStartUrls.push(url.searchParams.get('url') ?? '');
      send({ scan: '7' });
      return;
    }
    if (url.pathname === '/JSON/ascan/view/status/') {
      send({ status: mode === 'never-completes' ? '42' : '100' });
      return;
    }
    if (url.pathname === '/JSON/core/view/alerts/') {
      if (mode === 'fixed') {
        send({ alerts: [] });
        return;
      }
      send({
        alerts: [
          {
            pluginId: '40018',
            url: 'http://target.testhost.example/item?id=1',
            param: 'id',
            // Real ZAP serializes risk as the capitalized NAME, not a number.
            risk: 'High',
            name: 'SQL Injection',
          },
          {
            // An out-of-scope host the scanner also probed: the adapter
            // must drop and count this one.
            pluginId: '10038',
            url: 'http://off-scope.testhost.example/csp',
            param: '',
            risk: '1',
            name: 'CSP Header Not Set',
          },
        ],
      });
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  return {
    port: (server.address() as { port: number }).port,
    newSessionCalls: () => newSessionCalls,
    scanStartUrls: () => scanStartUrls,
  };
}

const TARGET = 'http://target.testhost.example/item';
const SCOPE = ['target.testhost.example'];

function clientFor(
  port: number,
  overrides?: Partial<{ pollBudgetMs: number; pollIntervalMs: number }>
): ZapClient {
  return new ZapClient({
    baseUrl: `http://127.0.0.1:${port}`,
    allowedHosts: SCOPE,
    pollBudgetMs: overrides?.pollBudgetMs ?? 5_000,
    pollIntervalMs: overrides?.pollIntervalMs ?? 20,
    fetchImpl: fetch,
  });
}

describe('scanner-regression adapter (T7 slice 3)', () => {
  it('gate 1: the vulnerable fixture yields the seeded finding with the scanner version recorded', async () => {
    const fixture = await startZapFixture('vulnerable');
    const result: ScannerScanResult = await clientFor(fixture.port).scan(TARGET);
    expect(result.scannerVersion).toBe('2.14.0-fixture');
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({
      pluginId: 40018,
      url: 'http://target.testhost.example/item?id=1',
      parameter: 'id',
      risk: 'high',
      name: 'SQL Injection',
    });
    // The scan-start request carried the target (a dropped url parameter
    // would 400 on a real ZAP).
    expect(fixture.scanStartUrls()).toEqual([TARGET]);
    // The out-of-scope alert was dropped and counted, not surfaced.
    expect(result.droppedOutOfScope).toBe(1);
  });

  it('gate 2: the fixed fixture differs — same scan, zero findings', async () => {
    const vulnerable = await startZapFixture('vulnerable');
    const fixed = await startZapFixture('fixed');
    const vulnerableResult = await clientFor(vulnerable.port).scan(TARGET);
    const fixedResult = await clientFor(fixed.port).scan(TARGET);
    expect(vulnerableResult.findings.length).toBe(1);
    expect(fixedResult.findings).toEqual([]);
    // And the comparison semantics see the difference.
    const comparison = compareScannerFindings(fixedResult, {
      formatVersion: 1,
      findings: vulnerableResult.findings.map((finding) => ({ ...finding })),
      capturedAt: '2026-10-03T00:00:00.000Z',
    });
    // Nothing present: 'clean', with the previously-seen finding resolved.
    expect(comparison.verdict).toBe('clean');
    expect(comparison.resolved).toEqual([
      `${vulnerableResult.findings[0]?.pluginId}::${vulnerableResult.findings[0]?.url}::id`,
    ]);
  });

  it('gate 3: an out-of-scope scan target is refused typed; the empty scope refuses everything', async () => {
    const fixture = await startZapFixture('vulnerable');
    const refused = new ZapClient({
      baseUrl: `http://127.0.0.1:${fixture.port}`,
      allowedHosts: SCOPE,
      fetchImpl: fetch,
    });
    await expect(refused.scan('http://off-scope.testhost.example/')).rejects.toMatchObject({
      code: 'POLICY_DENIED',
    });
    // An empty scope refuses at construction — before any target is sent.
    expect(
      () =>
        new ZapClient({
          baseUrl: `http://127.0.0.1:${fixture.port}`,
          allowedHosts: [],
          fetchImpl: fetch,
        })
    ).toThrowError(/empty engagement scope/);
  });

  it('gate 4: acknowledged findings are within baseline; a new finding regresses; resolved are reported', async () => {
    const fixture = await startZapFixture('vulnerable');
    const client = clientFor(fixture.port);
    const first: ScannerScanResult = await client.scan(TARGET);
    const baseline: ScannerBaseline = {
      formatVersion: 1,
      // Deep copy: the comparison must not alias the live result array.
      findings: first.findings.map((finding) => ({ ...finding })),
      capturedAt: '2026-10-03T00:00:00.000Z',
    };
    const same = compareScannerFindings(first, baseline);
    expect(same.verdict).toBe('within-baseline');
    expect(same.newFindings).toEqual([]);

    // A new finding (different plugin) on the same target regresses.
    (first as { findings: ScannerScanResult['findings'] }).findings.push({
      pluginId: 10098,
      url: 'http://target.testhost.example/item',
      parameter: null,
      risk: 'medium',
      name: 'Cross-Domain Misconfiguration',
    });
    const withNew: ScannerScanResult = { ...first, findings: [...first.findings] };
    const regressed = compareScannerFindings(withNew, baseline);
    expect(regressed.verdict).toBe('regression');
    expect(regressed.newFindings).toHaveLength(1);
    expect(regressed.resolved).toEqual([]);
  });

  it('gate 5: a scan that outlives its budget fails typed and the adapter stops the runaway scan', async () => {
    const fixture = await startZapFixture('never-completes');
    const client = clientFor(fixture.port, { pollBudgetMs: 200, pollIntervalMs: 20 });
    await expect(client.scan(TARGET)).rejects.toMatchObject({ code: 'SCAN_BUDGET_EXHAUSTED' });
    // Cleanup is part of the contract.
    await client.newSession();
    expect(fixture.newSessionCalls()).toBe(1);
  });

  it('gate 6: invalid scope entries are refused at construction', () => {
    expect(
      () =>
        new ZapClient({
          baseUrl: 'http://127.0.0.1:1',
          allowedHosts: ['../escape'],
          fetchImpl: fetch,
        })
    ).toThrowError(/is not a host/);
  });

  it('gate 7: still no new runtime dependencies — the adapter imports only its sibling module', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(new URL('./scanner-regression.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/require\(|node:child_process|node:sqlite/);
  });
});
