import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

// Runs in a child with an isolated cwd and only the production deployment import.
const [entry, executablePath, fixtureUrl] = process.argv.slice(2);
const { FirefoxBiDiEngine } = await import(pathToFileURL(entry).href);
const engine = new FirefoxBiDiEngine({ executablePath });
try {
  assert.equal((await engine.capabilities()).supportsCdp, false);
  const session = await engine.createSession({});
  const page = await session.newPage();
  await page.navigate({ url: fixtureUrl });
  let button;
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    button = (await page.observe({ mode: 'interactive' })).elements.find(e => e.name === 'Add' && e.enabled);
    if (button) break;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.ok(button?.ref, 'Real fixture button must be observable');
  await page.act({ type: 'click', target: { ref: button.ref } });
  // This read does not drive the UI. Parent independently checks its application ledger.
  let state;
  while (Date.now() < deadline) {
    state = await (await fetch(`${fixtureUrl}/state`)).json();
    if (state.version === 1) break;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.deepEqual(state, { version: 1, total: 1 });
  const capture = await page.screenshot({ maskSensitive: false });
  assert.equal(Buffer.from(capture.bytesBase64, 'base64').subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
} finally { await engine.close(); }
