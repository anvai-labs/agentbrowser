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
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  bundleFixtureServer,
  type FixtureApp,
  openRealBrowserApp,
} from './test-support/real-browser-app.js';

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

let app: FixtureApp<{ city: string | null; pick: string | null; slow?: string | null }>;

beforeAll(async () => {
  app = await bundleFixtureServer({
    appSource: APP,
    initialState: { city: null, pick: null },
  });
}, 60_000);

afterAll(() => app.dispose());

beforeEach(() => {
  app.reset({ city: null, pick: null, slow: null });
});

async function openApp() {
  const { server, owner, url, pagePath } = await openRealBrowserApp('chromium', app.fixture);
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
      await expect.poll(() => app.state.city, { timeout: 5_000 }).toBe('Chicago');
      expect(app.submissions).toBe(0);
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
      await expect.poll(() => app.state.pick, { timeout: 5_000 }).toBe('Option 37');
      expect(app.submissions).toBe(0);
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
      expect(app.state).toEqual({ city: null, pick: 'Option 12', slow: null });
      expect(app.submissions).toBe(0);
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
      expect(app.state.slow ?? null).toBeNull();
      expect(app.submissions).toBe(0);
    } finally {
      await server.close();
    }
  }, 120_000);
});
