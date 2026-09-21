import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { type IncomingMessage, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PlaywrightChromiumEngine } from '@agentbrowser/engine-playwright';
import { NetworkPolicy } from '@agentbrowser/policy';
import { expect, it } from 'vitest';
import { runAgentCli } from '../../../scripts/cli-outcome-acceptance.mjs';
import { buildServer } from './server.js';

const cli = fileURLToPath(new URL('../../cli/dist/bin.js', import.meta.url));

async function readFixtureJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > 4096) throw new Error('Fixture request exceeded its bound');
    chunks.push(bytes);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
}

it('qualifies a mapped application draft and digest-checked PDF upload without submitting', async () => {
  const fields = new Map<string, string>();
  const uploads: Array<Record<string, unknown>> = [];
  let submissions = 0;
  const fixture = createServer(async (request, response) => {
    try {
      if (request.method === 'POST' && request.url === '/draft-field') {
        const value = await readFixtureJson(request);
        if (typeof value.name === 'string' && typeof value.value === 'string')
          fields.set(value.name, value.value);
        response.end('recorded');
        return;
      }
      if (request.method === 'POST' && request.url === '/upload-observation') {
        uploads.push(await readFixtureJson(request));
        response.end('recorded');
        return;
      }
      if (request.method === 'POST' && request.url === '/submit') {
        submissions += 1;
        response.end('submitted');
        return;
      }
      response.setHeader('content-type', 'text/html');
      response.end(`<!doctype html>
        <form action="/submit" method="post" enctype="multipart/form-data">
          <label>Full name<input id="full-name" name="fullName"></label>
          <label>Work preference<select id="preference" name="preference">
            <option value="">Choose</option><option value="remote">Remote</option>
          </select></label>
          <label>Resume<input id="resume" name="resume" type="file" accept="application/pdf,.pdf"></label>
          <button type="submit">Submit application</button>
        </form>
        <script>
          const record = (name, value) => fetch('/draft-field', {
            method: 'POST', headers: {'content-type': 'application/json'},
            body: JSON.stringify({name, value})
          });
          document.getElementById('full-name').addEventListener('input', event =>
            record('fullName', event.target.value));
          document.getElementById('preference').addEventListener('change', event =>
            record('preference', event.target.value));
          document.getElementById('resume').addEventListener('change', async event => {
            const file = event.target.files && event.target.files[0];
            if (!file) return;
            const bytes = await file.arrayBuffer();
            const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
            const sha256 = Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
            await fetch('/upload-observation', {
              method: 'POST', headers: {'content-type': 'application/json'},
              body: JSON.stringify({name: file.name, size: file.size, type: file.type, sha256})
            });
          });
        </script>`);
    } catch {
      response.statusCode = 400;
      response.end('invalid fixture request');
    }
  });
  await new Promise<void>((resolve) => fixture.listen(0, '127.0.0.1', resolve));
  const fixtureUrl = `http://127.0.0.1:${(fixture.address() as AddressInfo).port}/`;
  const server = await buildServer({
    engine: new PlaywrightChromiumEngine(),
    networkPolicy: new NetworkPolicy({ blockLoopback: false, blockPrivateIPs: false }),
    apiKeys: new Map([[createHash('sha256').update('owner').digest('hex'), 'tenant']]),
    approvalPolicy: {
      rules: [
        {
          hostname: '127.0.0.1',
          action: 'click',
          name: 'Submit application',
          effect: 'transaction',
          decision: 'deny',
        },
      ],
    },
  });
  const directory = await mkdtemp(join(tmpdir(), 'agentbrowser-application-draft-'));
  const resumePath = join(directory, 'resume.pdf');
  const reviewedBytes = Buffer.from('%PDF-1.4\nsynthetic resume\n%%EOF\n');
  const changedBytes = Buffer.from('%PDF-1.4\nsynthetic Resume\n%%EOF\n');
  expect(changedBytes.length).toBe(reviewedBytes.length);
  const reviewedSha256 = createHash('sha256').update(reviewedBytes).digest('hex');
  try {
    await server.listen({ host: '127.0.0.1', port: 0 });
    const baseUrl = `http://127.0.0.1:${(server.server.address() as AddressInfo).port}`;
    const ownerHeaders = { authorization: 'Bearer owner' };
    const created = await server.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: ownerHeaders,
      payload: { controlMode: 'delegated' },
    });
    expect(created.statusCode).toBe(201);
    const sessionId = created.json().sessionId as string;
    const sessionPath = `/v1/sessions/${sessionId}`;
    const page = await server.inject({
      method: 'POST',
      url: `${sessionPath}/pages`,
      headers: { ...ownerHeaders, 'x-agentbrowser-operation-id': 'create-draft-page' },
    });
    expect(page.statusCode).toBe(201);
    const pageId = page.json().pageId as string;
    const navigation = await server.inject({
      method: 'POST',
      url: `${sessionPath}/pages/${pageId}/navigate`,
      headers: { ...ownerHeaders, 'x-agentbrowser-operation-id': 'navigate-draft' },
      payload: { url: fixtureUrl },
    });
    expect(navigation.statusCode).toBe(200);
    const review = await server.inject({
      method: 'POST',
      url: `${sessionPath}/control/prepare-resume`,
      headers: ownerHeaders,
    });
    const delegated = await server.inject({
      method: 'POST',
      url: `${sessionPath}/control/delegate`,
      headers: ownerHeaders,
      payload: { epoch: review.json().epoch },
    });
    expect(delegated.statusCode).toBe(200);
    const token = delegated.json().token as string;
    const invoke = (
      args: string[],
      options: { operationId?: string; stdin?: string; expectedExitCode?: number } = {}
    ) =>
      runAgentCli(
        [
          process.execPath,
          cli,
          '--base-url',
          baseUrl,
          '--json',
          ...(options.operationId ? ['--operation-id', options.operationId] : []),
          ...args,
        ],
        {
          env: process.env,
          token,
          ...(options.stdin !== undefined ? { stdin: options.stdin } : {}),
          ...(options.expectedExitCode !== undefined
            ? { expectedExitCode: options.expectedExitCode }
            : {}),
        }
      );

    const mapping = {
      schemaVersion: 1,
      id: 'synthetic-application-draft',
      revision: '1',
      scope: { url: fixtureUrl },
      fields: [
        {
          match: { label: 'Full name' },
          strategy: 'native-input',
          valueKey: 'fullName',
          input: 'value',
        },
        {
          match: { label: 'Work preference' },
          strategy: 'native-select',
          valueKey: 'preference',
          input: 'option',
        },
      ],
    };
    const prepared = await invoke(['form', 'prepare', JSON.stringify(mapping), '-'], {
      stdin: JSON.stringify({ fullName: 'Synthetic Applicant', preference: 'remote' }),
    });
    expect(prepared.stderr).toBe('');
    const filled = await invoke(['autofill', sessionId, pageId, '-'], {
      operationId: 'fill-draft',
      stdin: prepared.stdout,
    });
    expect(JSON.parse(filled.stdout)).toMatchObject({
      ok: true,
      receipts: [{ status: 'verified' }, { status: 'verified' }],
    });
    await expect
      .poll(() => Object.fromEntries(fields))
      .toEqual({
        fullName: 'Synthetic Applicant',
        preference: 'remote',
      });

    const observed = await invoke(['observe', sessionId, pageId, '--include', 'fileInputs']);
    const elements = JSON.parse(observed.stdout).elements as Array<{
      ref: string;
      role: string;
      name?: string;
    }>;
    const fileRef = elements.find((element) => element.role === 'fileinput')?.ref;
    if (!fileRef) throw new Error('Synthetic application file input was not observed');

    await writeFile(resumePath, changedBytes, { mode: 0o600 });
    const mismatch = await invoke(
      [
        'act',
        'upload',
        sessionId,
        pageId,
        fileRef,
        resumePath,
        '--sha256',
        reviewedSha256,
        '--mime-type',
        'application/pdf',
      ],
      { operationId: 'upload-mismatch', expectedExitCode: 1 }
    );
    expect(mismatch.stderr).toMatch(/INVALID_REQUEST|SHA-256|digest/iu);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(uploads).toEqual([]);

    await writeFile(resumePath, reviewedBytes, { mode: 0o600 });
    const uploaded = await invoke(
      [
        'act',
        'upload',
        sessionId,
        pageId,
        fileRef,
        resumePath,
        '--sha256',
        reviewedSha256,
        '--mime-type',
        'application/pdf',
      ],
      { operationId: 'upload-reviewed' }
    );
    expect(JSON.parse(uploaded.stdout)).toMatchObject({
      status: 'success',
      result: {
        success: true,
        files: [
          {
            name: 'resume.pdf',
            size: reviewedBytes.length,
            sha256: reviewedSha256,
          },
        ],
        inputFiles: ['resume.pdf'],
      },
    });
    await expect
      .poll(() => uploads)
      .toEqual([
        {
          name: 'resume.pdf',
          size: reviewedBytes.length,
          type: 'application/pdf',
          sha256: reviewedSha256,
        },
      ]);

    const afterUpload = await invoke(['observe', sessionId, pageId]);
    const submitRef = (
      JSON.parse(afterUpload.stdout).elements as Array<{
        ref: string;
        role: string;
        name?: string;
      }>
    ).find((element) => element.role === 'button' && element.name === 'Submit application')?.ref;
    if (!submitRef) throw new Error('Synthetic application submit button was not observed');
    const denied = await invoke(['act', 'click', sessionId, pageId, submitRef], {
      operationId: 'submit-denied',
      expectedExitCode: 1,
    });
    expect(denied.stderr).toContain('POLICY_DENIED');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(submissions).toBe(0);
    expect(uploads).toHaveLength(1);
  } finally {
    await server.close();
    fixture.closeAllConnections();
    await new Promise<void>((resolve) => fixture.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
}, 45_000);
