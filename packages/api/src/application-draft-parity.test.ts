import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PlaywrightChromiumEngine } from '@agentbrowser/engine-playwright';
import { NetworkPolicy } from '@agentbrowser/policy';
import { expect, it } from 'vitest';
import { runAgentCli } from '../../../scripts/cli-outcome-acceptance.mjs';
import { buildServer } from './server.js';
import { startDraftFixture } from './test-support/application-draft-http.js';
import { type DraftSnapshot, createApplicationDraft } from './test-support/application-draft.js';

const cli = fileURLToPath(new URL('../../cli/dist/bin.js', import.meta.url));
const baseFields = {
  fullName: 'Synthetic Person',
  currentCompany: 'Current Co',
  previousCompany: 'Previous Co',
  preference: 'remote',
  relocation: null,
  referral: '',
  terms: true,
};
const bytes = Buffer.from('%PDF-1.4\nSynthetic draft\n%%EOF\n');
const digest = createHash('sha256').update(bytes).digest('hex');
const comparable = (state: DraftSnapshot) => ({
  contract: state.contract,
  job: state.job,
  destination: state.destination,
  intent: state.intent,
  fields: state.fields,
  complete: state.complete,
  missing: state.missing,
  attachment: state.attachment && {
    name: state.attachment.name,
    type: state.attachment.type,
    size: state.attachment.size,
    sha256: state.attachment.sha256,
  },
});
type Element = { ref: string; name?: string; role: string; value?: string; checked?: boolean };

it.each([false, true])(
  'qualifies independent UI/API draft parity (broken UI=%s)',
  async (brokenUi) => {
    const fields = {
      ...baseFields,
      preference: brokenUi ? 'remote' : 'hybrid',
      relocation: brokenUi ? null : true,
    };
    const filename = brokenUi ? 'resume.pdf' : 'candidate.pdf';
    const ui = createApplicationDraft({ id: 'ui' });
    const api = createApplicationDraft({ id: 'api' });
    const fixture = await startDraftFixture(ui, { brokenUi });
    const server = await buildServer({
      engine: new PlaywrightChromiumEngine(),
      networkPolicy: new NetworkPolicy({ blockLoopback: false, blockPrivateIPs: false }),
      apiKeys: new Map(
        ['owner', 'foreign'].map((tenant) => [
          createHash('sha256').update(tenant).digest('hex'),
          tenant,
        ])
      ),
      applicationAdapters: [api.adapter],
    });
    const directory = await mkdtemp(join(tmpdir(), 'draft-oracle-'));
    try {
      const file = join(directory, filename);
      await writeFile(file, bytes, { mode: 0o600 });
      await server.listen({ host: '127.0.0.1', port: 0 });
      const baseUrl = `http://127.0.0.1:${(server.server.address() as AddressInfo).port}`;
      const invoke = async (args: string[], operationId?: string, expectedExitCode = 0) =>
        runAgentCli(
          [
            process.execPath,
            cli,
            '--base-url',
            baseUrl,
            '--json',
            ...(operationId ? ['--operation-id', operationId] : []),
            ...args,
          ],
          { env: process.env, token: 'owner', expectedExitCode }
        );
      const headers = { authorization: 'Bearer owner' };
      const create = async () => {
        const response = await server.inject({
          method: 'POST',
          url: '/v1/sessions',
          headers,
          payload: { controlMode: 'delegated' },
        });
        expect(response.statusCode).toBe(201);
        return response.json().sessionId as string;
      };
      const sessionId = await create();
      const page = await server.inject({
        method: 'POST',
        url: `/v1/sessions/${sessionId}/pages`,
        headers: { ...headers, 'x-agentbrowser-operation-id': 'create-page' },
      });
      expect(page.statusCode).toBe(201);
      const pageId = page.json().pageId as string;
      const navigation = await server.inject({
        method: 'POST',
        url: `/v1/sessions/${sessionId}/pages/${pageId}/navigate`,
        headers: { ...headers, 'x-agentbrowser-operation-id': 'navigate' },
        payload: { url: fixture.url },
      });
      expect(navigation.statusCode).toBe(200);
      const observe = async (): Promise<Element[]> =>
        JSON.parse((await invoke(['observe', sessionId, pageId, '--include', 'fileInputs'])).stdout)
          .elements;
      const fill = await invoke(
        [
          'autofill',
          sessionId,
          pageId,
          JSON.stringify({
            fields: [
              { match: { dataAutomationId: 'fullName' }, value: fields.fullName, verify: 'exact' },
              {
                match: { dataAutomationId: 'currentCompany' },
                value: fields.currentCompany,
                verify: 'exact',
              },
              {
                match: { dataAutomationId: 'previousCompany' },
                value: fields.previousCompany,
                verify: 'exact',
              },
              {
                match: { label: 'Work preference' },
                option: { value: fields.preference },
                verify: 'exact',
              },
              ...(brokenUi
                ? []
                : [{ match: { label: 'Relocation' }, option: { value: 'yes' }, verify: 'exact' }]),
            ],
          }),
        ],
        'fill-ui'
      );
      expect(JSON.parse(fill.stdout).ok).toBe(true);
      const before = await observe();
      const terms = before.find(
        (element) => element.role === 'checkbox' && element.name === 'Accept terms'
      );
      if (!terms?.ref) throw new Error('Missing terms control');
      await invoke(['act', 'check', sessionId, pageId, terms.ref], 'terms-ui');
      const input = (await observe()).find((element) => element.role === 'fileinput');
      if (!input?.ref) throw new Error('Missing upload control');
      await invoke(
        [
          'act',
          'upload',
          sessionId,
          pageId,
          input.ref,
          file,
          '--sha256',
          digest,
          '--mime-type',
          'application/pdf',
        ],
        'upload-ui'
      );
      await expect.poll(() => ui.read().attachment?.sha256).toBe(digest);
      const visible = await observe();
      expect(visible.find((element) => element.name === 'Full name')?.value).toBe(fields.fullName);
      expect(
        visible.filter((element) => element.name === 'Company name').map((element) => element.value)
      ).toEqual([fields.currentCompany, fields.previousCompany]);
      expect(visible.find((element) => element.name === 'Accept terms')?.checked).toBe(true);
      const sync = visible.find((element) => element.name?.startsWith('Draft sync '));
      if (!sync?.name) throw new Error('Missing UI sync state');
      expect(JSON.parse(sync.name.slice('Draft sync '.length))).toMatchObject({
        pending: 0,
        failed: false,
        version: ui.read().version,
        preference: fields.preference,
        attachment: { name: filename, type: 'application/pdf', size: bytes.length },
      });

      const appSession = await create();
      await invoke(['application', 'bind', appSession, api.adapter.id, 'api']);
      const foreign = await server.inject({
        method: 'POST',
        url: `/v1/sessions/${appSession}/application/execute`,
        headers: { authorization: 'Bearer foreign' },
        payload: { operation: 'read', input: {} },
      });
      expect(foreign.statusCode).toBe(403);
      expect(api.read().version).toBe(0);
      const updated = await invoke(
        [
          'application',
          'execute',
          appSession,
          'update',
          JSON.stringify(fields),
          '--expected-version',
          '0',
        ],
        'update-api'
      );
      expect(JSON.parse(updated.stdout).status).toBe('committed');
      const uploaded = await invoke(
        [
          'application',
          'execute',
          appSession,
          'upload',
          JSON.stringify({
            name: filename,
            type: 'application/pdf',
            base64: bytes.toString('base64'),
          }),
          '--expected-version',
          '1',
        ],
        'upload-api'
      );
      expect(JSON.parse(uploaded.stdout).status).toBe('committed');
      const read = await invoke(['application', 'execute', appSession, 'read', '{}']);
      expect(JSON.parse(read.stdout).value).toEqual(api.read());
      expect(api.read().complete).toBe(true);
      const replay = await invoke(
        [
          'application',
          'execute',
          appSession,
          'upload',
          JSON.stringify({
            name: filename,
            type: 'application/pdf',
            base64: bytes.toString('base64'),
          }),
          '--expected-version',
          '1',
        ],
        'upload-api'
      );
      expect(JSON.parse(replay.stdout).replay).toBe(true);
      expect(api.read().version).toBe(2);
      const stale = await invoke(
        [
          'application',
          'execute',
          appSession,
          'update',
          JSON.stringify({ fullName: 'Stale' }),
          '--expected-version',
          '0',
        ],
        'stale-api'
      );
      expect(JSON.parse(stale.stdout)).toMatchObject({
        status: 'rejected',
        reason: 'VERSION_CONFLICT',
      });
      await invoke(
        ['application', 'execute', appSession, 'submit', '{}', '--expected-version', '2'],
        'submit-api',
        1
      );
      expect(api.read().version).toBe(2);
      if (brokenUi) {
        expect(ui.read().complete).toBe(false);
        expect(ui.read().missing).toContain('fullName');
        expect(comparable(ui.read())).not.toEqual(comparable(api.read()));
      } else {
        expect(ui.read().complete).toBe(true);
        expect(comparable(ui.read())).toEqual(comparable(api.read()));
        // An external edit makes the UI version stale. Its later visible edit must
        // surface a failed commit, never silently overwrite or retry against new state.
        ui.update(ui.read().version, { fullName: 'External edit' });
        const fullName = visible.find((element) => element.name === 'Full name');
        if (!fullName?.ref) throw new Error('Missing name control');
        await invoke(
          ['act', 'fill', sessionId, pageId, fullName.ref, 'Uncommitted edit'],
          'stale-ui'
        );
        await expect
          .poll(async () =>
            (await observe()).some((element) => element.name?.includes('"failed":true'))
          )
          .toBe(true);
        expect(ui.read().fields.fullName).toBe('External edit');
      }
    } finally {
      await server.close();
      await fixture.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
  60_000
);
