/**
 * T6 rollback and async/recycled-option coverage, against the REAL react-select (async variant
 * included), bundled at test start. The app reports its committed React state and any
 * submission to the fixture server, the independent oracle:
 *
 * | Case | Shape | Expected |
 * | --- | --- | --- |
 * | async options | `react-select/async`, options load 400 ms after typing | the exact option commits |
 * | recycled options | a MenuList that keys the options themselves by index, so React reuses option DOM nodes across filters | the exact option commits, never a stale node |
 * | never-loading options | a loader that never resolves | `uncertain`, nothing committed or submitted |
 * | partial effects | a later field's option never loads | earlier fields stay committed and are reported; nothing is undone or submitted |
 */
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PlaywrightChromiumEngine } from '@agentbrowser/engine-playwright';
import { NetworkPolicy } from '@agentbrowser/policy';
import { build } from 'esbuild';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from './server.js';

const APP = `
import { cloneElement, createElement as e, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import Select, { components } from 'react-select';
import AsyncSelect from 'react-select/async';
// "Chicago Heights" sorts first, so a prefix or first-match regression would pick it.
const cities = [
  { value: 'chh', label: 'Chicago Heights' },
  { value: 'chi', label: 'Chicago' },
  { value: 'bos', label: 'Boston' },
];
// Never resolves: no readiness budget can cover it.
const loadNever = () => new Promise(() => {});
const loadCities = (input) =>
  new Promise((resolve) =>
    setTimeout(
      () => resolve(cities.filter((c) => c.label.toLowerCase().includes(input.toLowerCase()))),
      400
    )
  );
const many = Array.from({ length: 50 }, (_, i) => ({ value: 'o' + i, label: 'Option ' + i }));
// Options keyed by index: React reuses the same option DOM nodes across filter changes and
// patches their text, so a stale node is possible (each node is tagged to prove reuse).
function RecyclingMenuList(props) {
  const items = [].concat(props.children).slice(0, 6);
  return e(components.MenuList, props, items.map((child, i) => cloneElement(child, { key: i })));
}
function App() {
  const [city, setCity] = useState(null);
  const [pick, setPick] = useState(null);
  const [slow, setSlow] = useState(null);
  useEffect(() => {
    fetch('/state', { method: 'POST', body: JSON.stringify({ city: city && city.label, pick: pick && pick.label, slow: slow && slow.label }) });
  }, [city, pick, slow]);
  return e('form', { onSubmit: (event) => { event.preventDefault(); fetch('/submitted', { method: 'POST' }); } },
    e('label', { htmlFor: 'city' }, 'Async City'),
    e(AsyncSelect, { inputId: 'city', classNamePrefix: 'select', loadOptions: loadCities, value: city, onChange: setCity }),
    e('label', { htmlFor: 'slow' }, 'Slow City'),
    e(AsyncSelect, { inputId: 'slow', classNamePrefix: 'select', loadOptions: loadNever, value: slow, onChange: setSlow }),
    e('label', { htmlFor: 'pick' }, 'Recycled Pick'),
    e(Select, { inputId: 'pick', classNamePrefix: 'select', options: many, value: pick, onChange: setPick, components: { MenuList: RecyclingMenuList } }),
    e('button', { type: 'submit' }, 'Submit'));
}
createRoot(document.getElementById('root')).render(e(App));
`;

let fixture: Server;
let bundle = '';
let state: { city: string | null; pick: string | null; slow?: string | null } = {
  city: null,
  pick: null,
};
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

beforeEach(() => {
  state = { city: null, pick: null, slow: null };
  submissions = 0;
});

const owner = { authorization: 'Bearer owner' };

async function openApp() {
  const server = await buildServer({
    engine: new PlaywrightChromiumEngine(),
    networkPolicy: new NetworkPolicy({ blockLoopback: false, blockPrivateIPs: false }),
    apiKeys: new Map([[createHash('sha256').update('owner').digest('hex'), 'tenant']]),
  });
  const url = `http://127.0.0.1:${(fixture.address() as AddressInfo).port}/`;
  const created = await server.inject({
    method: 'POST',
    url: '/v1/sessions',
    headers: owner,
    payload: {},
  });
  const path = `/v1/sessions/${created.json().sessionId}`;
  const page = await server.inject({ method: 'POST', url: `${path}/pages`, headers: owner });
  const pagePath = `${path}/pages/${page.json().pageId}`;
  const nav = await server.inject({
    method: 'POST',
    url: `${pagePath}/navigate`,
    headers: owner,
    payload: { url, waitUntil: 'networkidle' },
  });
  expect(nav.statusCode).toBe(200);
  const autofill = (
    operationId: string,
    fields: unknown[],
    policy: Record<string, number> = { settleMs: 50 }
  ) =>
    server.inject({
      method: 'POST',
      url: `${pagePath}/autofill`,
      headers: { ...owner, 'x-agentbrowser-operation-id': operationId },
      payload: { scope: { url }, fields, policy },
    });
  return { server, autofill };
}

describe('T6 async, recycled and partial-effect coverage (real react-select, Chromium)', () => {
  it('async options: with a readiness budget covering the load, the exact option commits (Chicago, not Chicago Heights)', async () => {
    const { server, autofill } = await openApp();
    try {
      // The options arrive 400 ms after typing: settleMs × maxReobserve must cover that.
      const response = await autofill(
        'async-city',
        [
          {
            match: { role: 'combobox', label: 'Async City' },
            strategy: 'react-select',
            option: { value: 'Chicago' },
          },
        ],
        { settleMs: 200, maxReobserve: 5 }
      );
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().receipts[0].status).toBe('verified');
      await expect.poll(() => state.city, { timeout: 5_000 }).toBe('Chicago');
      expect(submissions).toBe(0);
    } finally {
      await server.close();
    }
  }, 120_000);

  it('recycled options: the exact option commits although option nodes are reused', async () => {
    const { server, autofill } = await openApp();
    try {
      const response = await autofill('recycled-pick', [
        {
          match: { role: 'combobox', label: 'Recycled Pick' },
          strategy: 'react-select',
          option: { value: 'Option 37' },
        },
      ]);
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().receipts[0].status).toBe('verified');
      await expect.poll(() => state.pick, { timeout: 5_000 }).toBe('Option 37');
      expect(submissions).toBe(0);
    } finally {
      await server.close();
    }
  }, 120_000);

  it('partial effects: a later field whose option never loads leaves earlier ones committed and reported; nothing is undone', async () => {
    const { server, autofill } = await openApp();
    try {
      const response = await autofill('partial', [
        {
          match: { role: 'combobox', label: 'Recycled Pick' },
          strategy: 'react-select',
          option: { value: 'Option 12' },
        },
        {
          match: { role: 'combobox', label: 'Async City' },
          strategy: 'react-select',
          option: { value: 'Atlantis' },
        },
      ]);
      expect(response.statusCode, response.body).toBe(200);
      const receipts = response.json().receipts as Array<{ status: string }>;
      expect(receipts[0]?.status).toBe('verified');
      expect(receipts[1]).toMatchObject({
        status: 'uncertain',
        error: { code: 'TARGET_NOT_FOUND' },
      });
      // The earlier field's effect stands (reported verified), with no guessed compensation.
      await new Promise((settle) => setTimeout(settle, 600));
      expect(state).toEqual({ city: null, pick: 'Option 12', slow: null });
      expect(submissions).toBe(0);
    } finally {
      await server.close();
    }
  }, 120_000);

  it('options that never load fail safely: uncertain, nothing committed or submitted', async () => {
    const { server, autofill } = await openApp();
    try {
      const response = await autofill(
        'never-loads',
        [
          {
            match: { role: 'combobox', label: 'Slow City' },
            strategy: 'react-select',
            option: { value: 'Chicago' },
          },
        ],
        { settleMs: 200, maxReobserve: 5 }
      );
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().receipts[0]).toMatchObject({
        status: 'uncertain',
        error: { code: 'TARGET_NOT_FOUND' },
      });
      await new Promise((settle) => setTimeout(settle, 500));
      expect(state.slow ?? null).toBeNull();
      expect(submissions).toBe(0);
    } finally {
      await server.close();
    }
  }, 120_000);
});
