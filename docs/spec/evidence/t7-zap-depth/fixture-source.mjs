#!/usr/bin/env node
/**
 * T7 depth: a recorded run of the ZAP adapter against a REAL OWASP ZAP daemon and a local,
 * deliberately vulnerable fixture. Run by the dispatch-only `zap-depth.yml` workflow (a
 * digest-pinned ZAP container on the host network); also runnable locally the same way.
 *
 *   docker run -d --rm --network host --name zap \
 *     zaproxy/zap-stable@sha256:<digest> zap.sh -daemon -host 127.0.0.1 -port 8090 \
 *     -config api.disablekey=true -config api.addrs.addr.name=127.0.0.1 -config api.addrs.addr.regex=false
 *   pnpm -r build
 *   node scripts/zap-depth-run.mjs --zap http://127.0.0.1:8090 --out zap-depth
 *
 * Writes, per the T7 recorded-run norm (so the table is re-verifiable, not transcribed):
 *   result.json        scanner version, normalized findings, dropped-out-of-scope count, verdict
 *   raw-alerts.json    the scanner's alerts for the fixture origin, sanitized (no headers/bodies)
 *   fixture-source.mjs this script (it contains the fixture)
 * Exits 0 only if the seeded reflected XSS (pluginId 40012, high, parameter `name`) was found and
 * every finding stayed `suspected` (a scanner alert is a claim, never a confirmation).
 */
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ZapClient } from '../packages/audit/dist/index.js';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
};
const zapUrl = flag('--zap', 'http://127.0.0.1:8090').replace(/\/+$/, '');
const outDir = flag('--out', 'zap-depth');
const budgetMs = Number(flag('--budget-ms', '900000'));

// ------------------------------------------------------------------ the vulnerable fixture
// Reflects `name` unescaped and sends no security headers: the seeded findings.
const fixture = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://fixture.invalid');
  if (url.pathname === '/') {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end(
      '<!doctype html><title>ZAP depth fixture</title><a href="/greet?name=visitor">greet</a>'
    );
    return;
  }
  if (url.pathname === '/greet') {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end(
      `<!doctype html><title>Greeting</title><p>Hello ${url.searchParams.get('name') ?? ''}</p>`
    );
    return;
  }
  response.writeHead(404, { 'content-type': 'text/plain' });
  response.end('not found');
});

async function zap(path, parameters = {}) {
  const query = new URLSearchParams({ zapapiformat: 'JSON', ...parameters });
  const response = await fetch(`${zapUrl}${path}?${query}`);
  const text = await response.text();
  if (!response.ok) throw new Error(`ZAP ${path} failed (${response.status}): ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

async function waitForZap() {
  const deadline = Date.now() + 180_000;
  for (;;) {
    try {
      return (await zap('/JSON/core/view/version/')).version;
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise((done) => setTimeout(done, 2_000));
    }
  }
}

await new Promise((done) => fixture.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${fixture.address().port}`;
const target = `${origin}/greet?name=visitor`;
mkdirSync(outDir, { recursive: true });
let exitCode = 1;
try {
  const version = await waitForZap();
  console.log(`ZAP ${version} ready; fixture at ${origin}`);
  // The scanner refuses a URL that is not in its sites tree (url_not_found): the adapter does
  // not automate this setup step, so the run enters the target through ZAP first.
  await zap('/JSON/core/action/accessUrl/', { url: `${origin}/`, followRedirects: 'false' });
  await zap('/JSON/core/action/accessUrl/', { url: target, followRedirects: 'false' });

  const client = new ZapClient({
    baseUrl: zapUrl,
    allowedHosts: [new URL(origin).host],
    pollBudgetMs: budgetMs,
    pollIntervalMs: 2_000,
  });
  const result = await client.scan(target);

  const raw = await zap('/JSON/core/view/alerts/', { baseurl: origin, start: '0', count: '500' });
  const sanitized = (raw.alerts ?? []).map((alert) => ({
    pluginId: alert.pluginId,
    alert: alert.alert ?? alert.name,
    risk: alert.risk,
    confidence: alert.confidence,
    url: alert.url,
    param: alert.param,
    attack: alert.attack,
    evidence: typeof alert.evidence === 'string' ? alert.evidence.slice(0, 200) : undefined,
    cweid: alert.cweid,
  }));

  const seeded = result.findings.find(
    (finding) =>
      finding.pluginId === 40012 && finding.risk === 'high' && finding.parameter === 'name'
  );
  const allSuspected = result.findings.every((finding) => finding.status === 'suspected');
  const verdict = seeded !== undefined && allSuspected ? 'pass' : 'fail';
  exitCode = verdict === 'pass' ? 0 : 1;

  writeFileSync(
    join(outDir, 'result.json'),
    `${JSON.stringify(
      {
        recordedAt: new Date().toISOString(),
        scanner: { name: 'OWASP ZAP', version: result.scannerVersion },
        target,
        verdict,
        seededFound: seeded !== undefined,
        allSuspected,
        droppedOutOfScope: result.droppedOutOfScope,
        findings: result.findings,
      },
      null,
      2
    )}\n`
  );
  writeFileSync(join(outDir, 'raw-alerts.json'), `${JSON.stringify(sanitized, null, 2)}\n`);
  copyFileSync(fileURLToPath(import.meta.url), join(outDir, 'fixture-source.mjs'));

  console.log(`${result.findings.length} findings, ${result.droppedOutOfScope} dropped; verdict ${verdict}`);
  for (const finding of result.findings)
    console.log(`  ${finding.risk.padEnd(13)} ${finding.pluginId} ${finding.name} [${finding.parameter ?? ''}] ${finding.status}`);
} finally {
  fixture.close();
}
process.exit(exitCode);
