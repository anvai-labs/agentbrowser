#!/usr/bin/env node
/** T6 slice 3 evidence: measure merged (frame-traversing) observation latency
 * and element counts against a frameless top-level baseline over the same
 * fixture content. Deterministic local servers; no accounts.
 *
 * Run: node scripts/measure-frame-observation.mjs [--runs 5]
 * Output: JSON measurements on stdout (pipe to a file for the evidence record).
 */
import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';
import { PlaywrightChromiumEngine } from '../packages/engine-playwright/dist/index.js';

const runs = Math.max(1, Number(process.argv[2] ?? 5) || 5);

const mainBody = `
<button>Main Action</button>
<iframe src="/frame-a" name="frame-a" title="Frame A"></iframe>
<iframe src="/frame-b" name="frame-b" title="Frame B"></iframe>
<iframe srcdoc="<button>Srcdoc Action</button>" title="Srcdoc"></iframe>
<iframe src="/nested" name="nested" title="Nested"></iframe>`;
const frameA = '<button onclick="this.textContent=\'DONE-A\'">Frame A Action</button>';
const frameB = '<button onclick="this.textContent=\'DONE-B\'">Frame B Action</button>';
const nestedOuter = '<iframe src="/nested-inner" name="inner" title="Inner"></iframe>';
const nestedInner = '<button onclick="this.textContent=\'DONE-N\'">Nested Action</button>';

const server = createServer((request, response) => {
  const path = request.url ?? '/';
  const bodies = {
    '/frame-a': `<button>Frame A Action</button>`,
    '/frame-b': `<button>Frame B Action</button>`,
    '/nested': nestedOuter,
    '/nested-inner': nestedInner,
    '/baseline': '<button>Main Action</button>',
  };
  response.writeHead(200, { 'content-type': 'text/html' });
  response.end(bodies[path] ?? mainBody);
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const baseUrl = `http://127.0.0.1:${port}`;

const measure = async (label, url) => {
  const engine = new PlaywrightChromiumEngine();
  try {
    const session = await engine.createSession({ headless: true });
    const page = await session.newPage();
    // Warm the page (load + one observation) before timing, so the numbers
    // reflect steady-state observation cost, not first-navigation JIT.
    await page.navigate({ url });
    await page.observe({ mode: 'interactive' });
    const samples = [];
    for (let index = 0; index < runs; index += 1) {
      const start = performance.now();
      const observation = await page.observe({ mode: 'interactive' });
      samples.push({
        ms: Math.round((performance.now() - start) * 10) / 10,
        elements: observation.elements.length,
      });
    }
    await session.close().catch(() => {});
    const latencies = samples.map((s) => s.ms);
    return {
      label,
      runs,
      medianMs: latencies.sort((a, b) => a - b)[Math.floor(runs / 2)],
      maxMs: Math.max(...latencies),
      elements: samples[0].elements,
    };
  } finally {
    await engine.close().catch(() => {});
  }
};

try {
  const baseline = await measure('top-level-only baseline (no frames)', `${baseUrl}/baseline`);
  const merged = await measure('merged multi-frame observation', `${baseUrl}/`);
  const report = {
    measuredAt: new Date().toISOString(),
    runs,
    baseline,
    merged,
    overheadMs: merged.medianMs - baseline.medianMs,
    overheadRatio: Math.round((merged.medianMs / baseline.medianMs) * 100) / 100,
  };
  console.log(JSON.stringify(report, null, 2));
  writeFileSync('/tmp/frame-observation-measurements.json', JSON.stringify(report, null, 2));
} finally {
  server.closeAllConnections();
  server.close();
}
