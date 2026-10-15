/**
 * T6 W1: the `react-select` and `chip-multiselect` strategies against the REAL react-select
 * library (pinned test-only devDependency, bundled at test start), not hand-written markup that
 * imitates it. The app reports its committed React state and any form submission to the fixture
 * server, which is the independent oracle; autofill receipts are checked against it.
 */
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PlaywrightChromiumEngine } from '@agentbrowser/engine-playwright';
import { NetworkPolicy } from '@agentbrowser/policy';
import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from './server.js';

const APP = `
import { createElement as e, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import Select from 'react-select';
const cities = [
  { value: 'chi', label: 'Chicago' },
  { value: 'bos', label: 'Boston' },
  { value: 'chh', label: 'Chicago Heights' },
];
const codes = [
  { value: 'us', label: 'United States of America' },
  { value: 'ca', label: 'Canada' },
];
function App() {
  const [city, setCity] = useState(null);
  const [selected, setSelected] = useState([]);
  useEffect(() => {
    fetch('/state', {
      method: 'POST',
      body: JSON.stringify({ city: city && city.label, codes: selected.map((o) => o.label) }),
    });
  }, [city, selected]);
  return e('form', { onSubmit: (event) => { event.preventDefault(); fetch('/submitted', { method: 'POST' }); } },
    e('label', { htmlFor: 'city' }, 'Location (City)'),
    e(Select, { inputId: 'city', classNamePrefix: 'select', options: cities, value: city, onChange: setCity }),
    e('label', { htmlFor: 'country' }, 'Country Phone Code'),
    e(Select, { inputId: 'country', classNamePrefix: 'select', isMulti: true, options: codes, value: selected, onChange: setSelected }),
    e('button', { type: 'submit' }, 'Submit'));
}
createRoot(document.getElementById('root')).render(e(App));
`;

let fixture: Server;
let bundle = '';
let state: { city: string | null; codes: string[] } = { city: null, codes: [] };
let submissions = 0;

beforeAll(async () => {
  const result = await build({
    stdin: { contents: APP, resolveDir: import.meta.dirname, loader: 'js' },
    bundle: true,
    write: false,
    format: 'iife',
    minify: true,
    define: { 'process.env.NODE_ENV': '"production"' },
    logLevel: 'silent',
  });
  bundle = result.outputFiles[0]?.text ?? '';
  fixture = createServer((request, response) => {
    if (request.url === '/bundle.js') {
      response.setHeader('content-type', 'text/javascript');
      response.end(bundle);
      return;
    }
    if (request.url === '/state' || request.url === '/submitted') {
      let body = '';
      request.on('data', (chunk) => {
        body += chunk;
      });
      request.on('end', () => {
        if (request.url === '/state') state = JSON.parse(body);
        else submissions += 1;
        response.end('ok');
      });
      return;
    }
    response.setHeader('content-type', 'text/html');
    response.end('<!doctype html><div id="root"></div><script src="/bundle.js"></script>');
  });
  await new Promise<void>((resolve) => fixture.listen(0, '127.0.0.1', resolve));
}, 60_000);

afterAll(async () => {
  fixture.closeAllConnections();
  await new Promise<void>((resolve) => fixture.close(() => resolve()));
});

// T6 W3b: the same qualification on every engine the Playwright engine drives. The widget
// evidence (owned popups, committed membership, chip remove controls) is captured in the page,
// so it must hold on Firefox and WebKit too, not only Chromium.
describe.each(['chromium', 'firefox', 'webkit'] as const)('%s', (browser) => {
  it('fills a real react-select single and multi select; the app state agrees and nothing submits', async () => {
    expect(bundle.length).toBeGreaterThan(10_000);
    const owner = { authorization: 'Bearer owner' };
    const server = await buildServer({
      engine: new PlaywrightChromiumEngine({ browser }),
      networkPolicy: new NetworkPolicy({ blockLoopback: false, blockPrivateIPs: false }),
      apiKeys: new Map([[createHash('sha256').update('owner').digest('hex'), 'tenant']]),
    });
    try {
      const url = `http://127.0.0.1:${(fixture.address() as AddressInfo).port}/`;
      const sessionId = (
        await server.inject({ method: 'POST', url: '/v1/sessions', headers: owner, payload: {} })
      ).json().sessionId as string;
      const path = `/v1/sessions/${sessionId}`;
      const pageId = (
        await server.inject({ method: 'POST', url: `${path}/pages`, headers: owner })
      ).json().pageId as string;
      const nav = await server.inject({
        method: 'POST',
        url: `${path}/pages/${pageId}/navigate`,
        headers: owner,
        payload: { url, waitUntil: 'networkidle' },
      });
      expect(nav.statusCode).toBe(200);

      const autofill = await server.inject({
        method: 'POST',
        url: `${path}/pages/${pageId}/autofill`,
        headers: { ...owner, 'x-agentbrowser-operation-id': 'fill-real-react-select' },
        payload: {
          scope: { url },
          fields: [
            {
              match: { role: 'combobox', label: 'Location (City)' },
              strategy: 'react-select',
              option: { value: 'Chicago' },
            },
            {
              match: { role: 'combobox', label: 'Country Phone Code' },
              strategy: 'chip-multiselect',
              option: { value: 'United States of America' },
            },
          ],
          policy: { settleMs: 50 },
        },
      });
      expect(autofill.statusCode, autofill.body).toBe(200);
      const report = autofill.json();
      expect(report.receipts.map((receipt: { status: string }) => receipt.status)).toEqual([
        'verified',
        'verified',
      ]);
      // The independent oracle: the real component state, reported by the app itself.
      await expect
        .poll(() => state, { timeout: 5_000 })
        .toEqual({
          city: 'Chicago',
          codes: ['United States of America'],
        });
      // The exact option was chosen ("Chicago", not "Chicago Heights"), and committing never
      // submitted the form (no stray Enter).
      expect(submissions).toBe(0);

      // An internal line break in option.value would be typed as Enter mid-query (a trailing one is
      // trimmed before typing anyway): refused before any dispatch.
      const refused = await server.inject({
        method: 'POST',
        url: `${path}/pages/${pageId}/autofill`,
        headers: { ...owner, 'x-agentbrowser-operation-id': 'fill-newline' },
        payload: {
          scope: { url },
          fields: [
            {
              match: { role: 'combobox', label: 'Location (City)' },
              strategy: 'react-select',
              option: { value: 'Bos\nzz' },
            },
          ],
        },
      });
      expect(refused.statusCode).toBe(400);
      expect(refused.json().error.message).toMatch(/line break/);
      await new Promise((settle) => setTimeout(settle, 300));
      expect(state).toEqual({ city: 'Chicago', codes: ['United States of America'] });
      expect(submissions).toBe(0);
    } finally {
      await server.close();
    }
  }, 120_000);

  it('writes an exact chip set on the real react-select: removes, adds, reports partial effects (W2)', async () => {
    const owner = { authorization: 'Bearer owner' };
    const server = await buildServer({
      engine: new PlaywrightChromiumEngine({ browser }),
      networkPolicy: new NetworkPolicy({ blockLoopback: false, blockPrivateIPs: false }),
      apiKeys: new Map([[createHash('sha256').update('owner').digest('hex'), 'tenant']]),
    });
    try {
      const url = `http://127.0.0.1:${(fixture.address() as AddressInfo).port}/`;
      const sessionId = (
        await server.inject({ method: 'POST', url: '/v1/sessions', headers: owner, payload: {} })
      ).json().sessionId as string;
      const path = `/v1/sessions/${sessionId}`;
      const pageId = (
        await server.inject({ method: 'POST', url: `${path}/pages`, headers: owner })
      ).json().pageId as string;
      await server.inject({
        method: 'POST',
        url: `${path}/pages/${pageId}/navigate`,
        headers: owner,
        payload: { url, waitUntil: 'networkidle' },
      });
      await expect.poll(() => state, { timeout: 5_000 }).toEqual({ city: null, codes: [] });
      let operation = 0;
      const exact = async (values: string[]) => {
        const response = await server.inject({
          method: 'POST',
          url: `${path}/pages/${pageId}/autofill`,
          headers: { ...owner, 'x-agentbrowser-operation-id': `exact-${++operation}` },
          payload: {
            scope: { url },
            fields: [
              {
                match: { role: 'combobox', label: 'Country Phone Code' },
                strategy: 'chip-multiselect',
                options: { values, mode: 'exact' },
              },
            ],
            policy: { settleMs: 50 },
          },
        });
        expect(response.statusCode, response.body).toBe(200);
        return response.json().receipts[0];
      };

      // Empty → both (adds only).
      let receipt = await exact(['United States of America', 'Canada']);
      expect(receipt).toMatchObject({
        status: 'verified',
        effects: { removed: [], added: ['United States of America', 'Canada'] },
      });
      await expect
        .poll(() => [...state.codes].sort(), { timeout: 5_000 })
        .toEqual(['Canada', 'United States of America']);

      // Both → {Canada}: one verified removal through the chip's own remove control.
      receipt = await exact(['Canada']);
      expect(receipt).toMatchObject({
        status: 'verified',
        effects: { removed: ['United States of America'], added: [] },
      });
      await expect.poll(() => state.codes, { timeout: 5_000 }).toEqual(['Canada']);

      // Already exact: nothing dispatched beyond verification, no effects.
      receipt = await exact(['Canada']);
      expect(receipt.status).toBe('verified');
      expect(receipt.effects).toBeUndefined();

      // {Canada} → {} (remove only).
      receipt = await exact([]);
      expect(receipt).toMatchObject({
        status: 'verified',
        effects: { removed: ['Canada'], added: [] },
      });
      await expect.poll(() => state.codes, { timeout: 5_000 }).toEqual([]);

      // A failure part-way reports exactly the effects that happened, and nothing is undone.
      await exact(['Canada']);
      receipt = await exact(['United States of America', 'Atlantis']);
      expect(receipt.status).toBe('uncertain');
      expect(receipt.effects).toEqual({ removed: ['Canada'], added: ['United States of America'] });
      await expect
        .poll(() => state.codes, { timeout: 5_000 })
        .toEqual(['United States of America']);

      // The single-select combobox has no proven membership: refused before any dispatch.
      const single = await server.inject({
        method: 'POST',
        url: `${path}/pages/${pageId}/autofill`,
        headers: { ...owner, 'x-agentbrowser-operation-id': 'exact-single' },
        payload: {
          fields: [
            {
              match: { role: 'combobox', label: 'Location (City)' },
              strategy: 'chip-multiselect',
              options: { values: ['Boston'], mode: 'exact' },
            },
          ],
          policy: { settleMs: 50 },
        },
      });
      expect(single.json().receipts[0]).toMatchObject({ status: 'failed' });
      expect(single.json().receipts[0].effects).toBeUndefined();
      expect(state.city).toBeNull();
      expect(submissions).toBe(0);
    } finally {
      await server.close();
    }
  }, 180_000);
});
