import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PlaywrightChromiumEngine } from '@agentbrowser/engine-playwright';
import { NetworkPolicy } from '@agentbrowser/policy';
import { expect, it } from 'vitest';
import { buildServer } from './server.js';
import { openHarness } from './test-support/coexistence-harness.js';

const transports: Array<'stdio' | 'victor'> = process.env.AGENTBROWSER_VICTOR_ROOT
  ? ['stdio', 'victor']
  : ['stdio'];
it.each(transports)(
  'fills repeated blocks and known React Select-style markup through one real %s MCP call',
  async (transport) => {
    let submissions = 0;
    const fixture = createServer((req, res) => {
      if (req.url === '/submit') submissions++;
      res.setHeader('content-type', 'text/html');
      res.end(`<!doctype html><form action="/submit">
      <fieldset id="old"><legend>Employment</legend><label>Company name<input id="past" oninput="document.querySelector('form').prepend(document.getElementById('current'))"></label></fieldset>
      <fieldset id="current"><legend>Employment</legend><label>Company name<input id="present"></label></fieldset>
      <label>Source<select><option value="">Choose</option><option value="board">Job Board</option></select></label>
      <label for="city">Location (City)</label>
      <div class="select__value-container" id="city-container"><input id="city" role="combobox" aria-autocomplete="list"></div>
      <div id="city-menu"></div>
      <label for="country">Country Phone Code</label>
      <div class="select__value-container" id="country-container"><input id="country" role="combobox" aria-autocomplete="list"></div>
      <div id="country-menu"></div>
      <label for="query-only">Query-only City</label>
      <div class="select__value-container"><input id="query-only" role="combobox" aria-autocomplete="list"></div>
      <div id="query-only-menu"></div>
      <label for="bounded-country">Bounded Country</label>
      <div class="select__value-container"><input id="bounded-country" role="combobox" aria-autocomplete="list"></div>
      <div id="bounded-country-menu"></div>
      <button>Submit</button></form>
      <script>
        const mountOption = (inputId, menuId, expected, commit) => {
          const input = document.getElementById(inputId);
          const menu = document.getElementById(menuId);
          input.addEventListener('input', () => {
            menu.replaceChildren();
            if (input.value !== expected) return;
            const option = document.createElement('div');
            option.role = 'option';
            option.textContent = expected;
            option.addEventListener('click', () => {
              input.value = '';
              menu.replaceChildren();
              commit(input.parentElement, expected);
            });
            menu.append(option);
          });
        };
        mountOption('city', 'city-menu', 'Chicago', (container, value) => {
          const committed = document.createElement('div');
          committed.className = 'select__single-value';
          committed.textContent = value;
          container.prepend(committed);
        });
        mountOption('country', 'country-menu', 'United States of America', (container, value) => {
          const committed = document.createElement('div');
          committed.className = 'select__multi-value__label';
          committed.textContent = value;
          container.prepend(committed);
        });
        mountOption('query-only', 'query-only-menu', 'Chicago', (_container, value) => {
          document.getElementById('query-only').value = value;
        });
        mountOption('bounded-country', 'bounded-country-menu', 'US', (container, value) => {
          for (let index = 0; index < 33; index++) {
            const committed = document.createElement('div');
            committed.className = 'select__multi-value__label';
            committed.textContent = index === 0 ? value : 'existing-' + index;
            container.prepend(committed);
          }
        });
      </script>`);
    });
    await new Promise<void>((r) => fixture.listen(0, '127.0.0.1', r));
    const ownerHeaders = { authorization: 'Bearer owner' };
    const server = await buildServer({
      engine: new PlaywrightChromiumEngine(),
      networkPolicy: new NetworkPolicy({ blockLoopback: false, blockPrivateIPs: false }),
      apiKeys: new Map([[createHash('sha256').update('owner').digest('hex'), 'tenant']]),
    });
    let bridge: Awaited<ReturnType<typeof openHarness>> | undefined;
    try {
      await server.listen({ host: '127.0.0.1', port: 0 });
      const session = await server.inject({
        method: 'POST',
        url: '/v1/sessions',
        headers: ownerHeaders,
        payload: { controlMode: 'delegated' },
      });
      const sessionId = session.json().sessionId;
      const path = `/v1/sessions/${sessionId}`;
      const page = await server.inject({
        method: 'POST',
        url: `${path}/pages`,
        headers: { ...ownerHeaders, 'x-agentbrowser-operation-id': 'create' },
      });
      const pageId = page.json().pageId;
      const nav = await server.inject({
        method: 'POST',
        url: `${path}/pages/${pageId}/navigate`,
        headers: { ...ownerHeaders, 'x-agentbrowser-operation-id': 'nav' },
        payload: { url: `http://127.0.0.1:${(fixture.address() as AddressInfo).port}/` },
      });
      expect(nav.statusCode).toBe(200);
      const review = await server.inject({
        method: 'POST',
        url: `${path}/control/prepare-resume`,
        headers: ownerHeaders,
      });
      const grant = await server.inject({
        method: 'POST',
        url: `${path}/control/delegate`,
        headers: ownerHeaders,
        payload: { epoch: review.json().epoch },
      });
      bridge = await openHarness({
        transport,
        baseUrl: `http://127.0.0.1:${(server.server.address() as AddressInfo).port}`,
        sessionId,
        token: grant.json().token,
        requestTimeoutMs: 30_000,
      });
      const args = {
        pageId,
        operationId: 'fill-once',
        fields: [
          { match: { label: 'Company name', block: { id: 'old' } }, value: 'Previous employer' },
          { match: { label: 'Company name', block: { id: 'current' } }, value: 'Current employer' },
          { match: { label: 'Source' }, option: { value: 'board' } },
          {
            match: { role: 'combobox', label: 'Location (City)' },
            option: { value: 'Chicago' },
            strategy: 'react-select',
          },
          {
            match: { role: 'combobox', label: 'Country Phone Code' },
            option: { value: 'United States of America' },
            strategy: 'chip-multiselect',
          },
        ],
        policy: { settleMs: 25 },
      };
      const response = (await bridge.request('tools/call', {
        name: 'browser_autofill',
        arguments: args,
      })) as { isError?: boolean; content: Array<{ text: string }> };
      expect(response.isError, JSON.stringify(response)).not.toBe(true);
      const reportText = response.content[0]?.text;
      if (!reportText) throw new Error('Autofill response did not include a report');
      const report = JSON.parse(reportText);
      expect(report, JSON.stringify(report)).toMatchObject({
        ok: true,
        receipts: [
          { status: 'verified', actual: 'Previous employer' },
          { status: 'verified', actual: 'Current employer' },
          { status: 'verified', actual: 'board' },
          { status: 'verified', actual: '' },
          { status: 'verified', actual: '' },
        ],
      });
      expect(report.snapshot.artifactId).toBeTruthy();
      expect(report.snapshot.inline).toBeUndefined();
      expect(report.elapsedMs).toBeLessThan(240000);
      const queryOnlyResponse = (await bridge.request('tools/call', {
        name: 'browser_autofill',
        arguments: {
          pageId,
          operationId: 'query-only-does-not-commit',
          fields: [
            {
              match: { role: 'combobox', label: 'Query-only City' },
              option: { value: 'Chicago' },
              strategy: 'react-select',
            },
          ],
          policy: { settleMs: 25 },
        },
      })) as { isError?: boolean; content: Array<{ text: string }> };
      expect(queryOnlyResponse.isError).toBe(true);
      expect(JSON.parse(queryOnlyResponse.content[0]?.text ?? 'null')).toMatchObject({
        ok: false,
        receipts: [
          {
            status: 'failed',
            verified: false,
            actual: 'Chicago',
            error: { code: 'VALUE_MISMATCH' },
          },
        ],
      });
      const incompleteChipResponse = (await bridge.request('tools/call', {
        name: 'browser_autofill',
        arguments: {
          pageId,
          operationId: 'incomplete-chip-evidence',
          fields: [
            {
              match: { role: 'combobox', label: 'Bounded Country' },
              option: { value: 'US' },
              strategy: 'chip-multiselect',
            },
          ],
          policy: { settleMs: 25 },
        },
      })) as { isError?: boolean; content: Array<{ text: string }> };
      expect(incompleteChipResponse.isError).toBe(true);
      expect(JSON.parse(incompleteChipResponse.content[0]?.text ?? 'null')).toMatchObject({
        ok: false,
        receipts: [
          {
            status: 'failed',
            verified: false,
            actual: '',
            error: { code: 'VALUE_MISMATCH' },
          },
        ],
      });
      const duplicate = (await bridge.request('tools/call', {
        name: 'browser_autofill',
        arguments: args,
      })) as { isError?: boolean; content: Array<{ text: string }> };
      expect(JSON.stringify(duplicate)).toContain('OPERATION_RECORDED');
      expect(submissions).toBe(0);
    } finally {
      await bridge?.close();
      await server.close();
      await new Promise<void>((r, reject) => fixture.close((e) => (e ? reject(e) : r())));
    }
  },
  45000
);
