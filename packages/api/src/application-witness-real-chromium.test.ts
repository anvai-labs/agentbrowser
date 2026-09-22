import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type ApplicationAuthority,
  type ApplicationRequest,
  type PreparedEvidenceReview,
  TrustedEvidenceSourceRegistry,
} from '@agentbrowser/control';
import { canonicalJson } from '@agentbrowser/core';
import type { EnginePage } from '@agentbrowser/engine';
import { PlaywrightChromiumEngine } from '@agentbrowser/engine-playwright';
import { NetworkPolicy } from '@agentbrowser/policy';
import type { Page } from 'playwright';
import { expect, it, vi } from 'vitest';
import { runAgentCli } from '../../../scripts/cli-outcome-acceptance.mjs';
import { AgentBrowserClient } from '../../sdk-typescript/src/client.js';
import { buildServer } from './server.js';
import {
  AgentBrowserService,
  type ServiceDependencies,
  type ServiceOutcomeEvidenceContext,
} from './service.js';
import { createDraftWitnessCollector } from './test-support/application-draft-evidence.js';
import { startDraftFixture } from './test-support/application-draft-http.js';
import { createApplicationDraft } from './test-support/application-draft.js';

async function fixture(
  options: {
    brokenUi?: boolean;
    beforeUploadCommit?: () => Promise<void>;
    review?: boolean;
    submit?: boolean;
  } = {}
) {
  const draft = createApplicationDraft({ id: 'live-witness' });
  if (options.brokenUi) draft.update(0, { fullName: 'Old committed name' });
  const http = await startDraftFixture(draft, options);
  const directory = await mkdtemp(join(tmpdir(), 'native-witness-'));
  const filename = join(directory, 'resume.pdf');
  await writeFile(filename, 'original bytes', { mode: 0o600 });
  const engine = new PlaywrightChromiumEngine();
  let raw: EnginePage | undefined;
  const createSession = engine.createSession.bind(engine);
  vi.spyOn(engine, 'createSession').mockImplementation(async (request) => {
    const session = await createSession(request);
    const newPage = session.newPage.bind(session);
    vi.spyOn(session, 'newPage').mockImplementation(async (request) => {
      raw = await newPage(request);
      return raw;
    });
    return session;
  });
  let registry: TrustedEvidenceSourceRegistry<ServiceOutcomeEvidenceContext> | undefined;
  let permittedSession = '';
  let permissionGeneration = 1;
  const permissionOwnerId = randomUUID();
  let permitted = true;
  const verifier = { id: 'synthetic-draft-witness', version: 'v1', input: {} };
  let resolveReview: ServiceDependencies['evidenceReviewProvider'];
  const resolutions = vi.fn((request: Parameters<NonNullable<typeof resolveReview>>[0]) =>
    resolveReview?.(request)
  );
  const server = await buildServer({
    apiKeys: new Map(
      ['owner', 'other'].map((key) => [createHash('sha256').update(key).digest('hex'), key])
    ),
    evidenceReviewProvider: resolutions,
    engine,
    networkPolicy: new NetworkPolicy({ blockLoopback: false, blockPrivateIPs: false }),
    applicationAdapters: [
      options.submit
        ? {
            ...draft.adapter,
            operations: { ...draft.adapter.operations, submit: draft.submissionOperation },
          }
        : draft.adapter,
    ],
    evidenceSourceRegistryProvider(builder) {
      registry = new TrustedEvidenceSourceRegistry([
        builder.applicationRead({
          descriptor: { id: 'draft', capability: 'application.draft' },
          request: { operation: 'read', input: {} },
          authorize(request) {
            if (
              !permitted ||
              request.identity.sessionId !== permittedSession ||
              request.identity.adapter !== draft.adapter.id ||
              request.identity.resource !== 'live-witness' ||
              request.identity.operation !== 'read' ||
              request.correlationId !== 'witness-check' ||
              canonicalJson(request.verifier) !== canonicalJson(verifier)
            )
              return undefined;
            return {
              generation: permissionGeneration,
              currentGeneration: () => permissionGeneration,
            };
          },
        }),
      ]);
      return registry;
    },
  });
  const close = async () => {
    await server.close();
    await http.close();
    await rm(directory, { recursive: true, force: true });
  };
  try {
    // Capture the server-owned service only in this test; production has no raw-service hook.
    let captured: AgentBrowserService | undefined;
    const original = AgentBrowserService.prototype.createSession;
    const capture = vi
      .spyOn(AgentBrowserService.prototype, 'createSession')
      .mockImplementation(function (this: AgentBrowserService, request) {
        captured = this;
        return original.call(this, request);
      });
    let sessionId: string;
    try {
      const created = await server.inject({
        method: 'POST',
        url: '/v1/sessions',
        headers: { authorization: 'Bearer owner' },
        payload: {
          controlMode: 'delegated',
          headless: true,
          ...(options.review ? { policy: { approval: { review: 'operator' } } } : {}),
        },
      });
      expect(created.statusCode).toBe(201);
      sessionId = created.json().sessionId;
    } finally {
      capture.mockRestore();
    }
    assert(captured);
    const service = captured;
    permittedSession = sessionId;
    const operator = { actor: 'operator' as const, tenant: 'owner' };
    const run = async <T>(callback: () => Promise<T>): Promise<T> => {
      const result = await service.authority.run(sessionId, operator, {}, callback);
      if (result && typeof result === 'object' && 'replay' in result)
        throw new Error('Unexpected replay');
      return result as T;
    };
    service.applicationBind(sessionId, operator, {
      adapter: draft.adapter.id,
      resource: 'live-witness',
    });
    const { pageId } = await run(() => service.createPage(sessionId, { url: http.url }));
    assert(raw);
    const backing = (raw as EnginePage & { backingPage(): Page }).backingPage();
    const expectedPage = await run(async () => {
      const reader = service.prepareNativeFormReadInScope(sessionId, pageId);
      const native = await reader.read();
      return {
        ...reader.identity,
        url: new URL(http.url).href,
        documentId: native.documentId,
        formNodeId: native.form.nodeId,
        controls: Object.fromEntries(
          native.controls.map(({ id, nodeId, blockId }) => [id, { nodeId, blockId }])
        ),
      };
    });
    const snapshot = draft.read();
    const expectedApplication = {
      id: snapshot.id,
      incarnation: snapshot.incarnation,
      job: snapshot.job,
      destination: snapshot.destination,
      intent: snapshot.intent,
    };
    const fill = await run(() =>
      service.autofill(sessionId, pageId, {
        fields: [
          { match: { dataAutomationId: 'fullName' }, value: 'Synthetic Person', verify: 'exact' },
          { match: { dataAutomationId: 'currentCompany' }, value: 'Current Co', verify: 'exact' },
          { match: { dataAutomationId: 'previousCompany' }, value: 'Previous Co', verify: 'exact' },
          { match: { label: 'Work preference' }, option: { value: 'remote' }, verify: 'exact' },
        ],
        policy: { settleMs: 0 },
      })
    );
    expect(fill.ok).toBe(true);
    const act = async (role: string, action: 'check' | 'upload') =>
      run(async () => {
        const observed = await service.observe(sessionId, pageId, { include: ['fileInputs'] });
        const target = observed.elements.find((element) => element.role === role);
        assert(target);
        const result = await service.act(sessionId, pageId, {
          action,
          target: { ref: target.ref },
          ...(action === 'upload' ? { paths: [filename] } : {}),
        });
        expect(result).toMatchObject({ status: 'success' });
      });
    await act('checkbox', 'check');
    await act('fileinput', 'upload');
    const diagnostics = async () =>
      JSON.parse(
        (await backing.locator('#sync').textContent())?.slice('Draft sync '.length) ?? '{}'
      );
    await expect.poll(diagnostics).toMatchObject({ pending: 0, failed: false });
    assert(registry);
    const sources = registry;
    const prepareCollector = (afterFirstNative?: () => void) => {
      const signal = new AbortController().signal;
      const application = sources.prepareRead(
        'draft',
        'application.draft',
        { sessionId, pageId, signal },
        'witness-check',
        verifier
      );
      assert(application);
      const page = service.prepareNativeFormReadInScope(sessionId, pageId);
      const reader = afterFirstNative
        ? {
            ...page,
            read: vi.fn(page.read).mockImplementationOnce(async (...args) => {
              const value = await page.read(...args);
              afterFirstNative();
              return value;
            }),
          }
        : page;
      const collector = createDraftWitnessCollector({
        application,
        page: reader,
        expected: { page: expectedPage, application: expectedApplication },
      });
      return { collector, application, page };
    };
    const collect = (afterFirstNative?: () => void) =>
      run(async () => {
        const { collector } = prepareCollector(afterFirstNative);
        const result = await collector(new AbortController().signal);
        expect(service.authority.didDispatchInScope(sessionId)).toBe(false);
        return result;
      });
    let submissionAction: Record<string, unknown> | undefined;
    const composition = () => {
      const { collector, application, page } = prepareCollector();
      return {
        action: submissionAction ?? {
          intent: 'draft',
          destination: expectedApplication.destination,
          job: expectedApplication.job,
        },
        source: {
          ownerId: permissionOwnerId,
          contract: { id: 'synthetic-native-draft', version: '1' },
          permission: {
            generation: permissionGeneration,
            currentGeneration: () => permissionGeneration,
          },
          assertAuthorized() {
            application.assertAuthorized();
            page.assertAuthority();
          },
          collect: collector,
        },
      };
    };
    resolveReview = (request) => {
      if (
        request.identity.tenant !== 'owner' ||
        request.identity.sessionId !== sessionId ||
        request.identity.sessionIncarnation !== expectedPage.sessionIncarnation ||
        request.identity.pageId !== pageId ||
        request.source.ownerId !== permissionOwnerId ||
        request.source.contract.id !== 'synthetic-native-draft' ||
        request.source.contract.version !== '1'
      )
        return undefined;
      return composition();
    };
    const review = <T>(callback: (prepared: PreparedEvidenceReview) => Promise<T>) =>
      run(async () => {
        const prepared = service.prepareEvidenceReviewInScope(sessionId, pageId, composition());
        const result = await callback(prepared);
        expect(service.authority.didDispatchInScope(sessionId)).toBe(false);
        return result;
      });
    // Successful C3b integration is internal; the public wire surface remains gated.
    const applicationAuthority = (
      service as unknown as { applicationAuthority: ApplicationAuthority }
    ).applicationAuthority;
    const generateSubmission = () =>
      run(async () => {
        const expected = draft.read();
        const request: ApplicationRequest = {
          operation: 'submit',
          operationId: 'reviewed-submit',
          expectedVersion: expected.version,
          input: { intent: 'submit', expected },
        };
        const prepared = service.prepareApplicationSubmissionReviewInScope(
          sessionId,
          pageId,
          request,
          composition().source
        );
        const token = await prepared.generate(new AbortController().signal);
        submissionAction = structuredClone(
          (token.action.parameters as { action: Record<string, unknown> }).action
        );
        return { request, token };
      });
    return {
      draft,
      http,
      server,
      sessionId,
      resolutions,
      dispatch: vi.spyOn(raw, 'act'),
      service,
      backing,
      collect,
      review,
      run,
      generateSubmission,
      executeSubmission: (request: ApplicationRequest, tokenId: string) =>
        applicationAuthority.execute(sessionId, operator, { ...request, approvalToken: tokenId }),
      setPermission(allowed: boolean) {
        permitted = allowed;
        permissionGeneration++;
      },
      diagnostics,
      close,
      upload: () => act('fileinput', 'upload'),
    };
  } catch (error) {
    await close();
    throw error;
  }
}

it('inspects and decides qualified draft evidence through REST, SDK and compiled CLI without dispatch', async () => {
  const f = await fixture({ review: true });
  const signal = new AbortController().signal;
  const headers = { authorization: 'Bearer owner' };
  try {
    const token = await f.review((review) => review.generate(signal));
    const path = `/v1/sessions/${f.sessionId}/approvals/${token.tokenId}`;
    const get = () => f.server.inject({ method: 'GET', url: path, headers });
    const inspected = await get();
    expect(inspected.statusCode).toBe(200);
    expect(inspected.headers['cache-control']).toBe('no-store');
    expect(inspected.json()).toEqual(token);
    await f.server.listen({ host: '127.0.0.1', port: 0 });
    const baseUrl = `http://127.0.0.1:${(f.server.server.address() as AddressInfo).port}`;
    const client = new AgentBrowserClient({ baseUrl, apiKey: 'owner' });
    expect(await client.sessions.approval(f.sessionId, token.tokenId)).toEqual(token);
    const cli = fileURLToPath(new URL('../../cli/dist/bin.js', import.meta.url));
    const invoke = (args: string[]) =>
      runAgentCli([process.execPath, cli, '--base-url', baseUrl, ...args], {
        env: process.env,
        token: 'owner',
      });
    const text = await invoke(['session', 'approval', f.sessionId, token.tokenId]);
    expect(text.stdout.trim()).toBe(`${token.tokenId}: pending`);
    expect(text.stderr).toBe('');
    const json = await invoke(['--json', 'session', 'approval', f.sessionId, token.tokenId]);
    expect(JSON.parse(json.stdout)).toEqual(token);
    const approved = await invoke([
      '--json',
      '--operation-id',
      'public-evidence-approve',
      'session',
      'approval-decide',
      f.sessionId,
      token.tokenId,
      '--decision',
      'approve',
    ]);
    expect(JSON.parse(approved.stdout)).toMatchObject({
      tokenId: token.tokenId,
      status: 'approved',
      action: token.action,
    });
    expect((await client.sessions.approval(f.sessionId, token.tokenId)).status).toBe('approved');
    f.setPermission(false);
    expect((await get()).statusCode).toBe(404);
    const replay = await f.server.inject({
      method: 'POST',
      url: path,
      headers: { ...headers, 'x-agentbrowser-operation-id': 'public-evidence-approve' },
      payload: { decision: 'approve' },
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({ replay: true });
    expect(replay.body).not.toContain('Synthetic Person');
    expect(replay.json()).not.toHaveProperty('action');
    expect(replay.json()).not.toHaveProperty('witness');
    f.setPermission(true);
    expect((await get()).statusCode).toBe(404);
    expect(await f.review((review) => review.consume(token.tokenId, signal))).toBe(false);
    const fresh = await f.review((review) => review.generate(signal));
    expect(
      (await client.sessions.decideApproval(f.sessionId, fresh.tokenId, 'approve')).status
    ).toBe('approved');
    await f.backing.locator('#referral').fill('Updated after review');
    await expect.poll(f.diagnostics).toMatchObject({ pending: 0, failed: false });
    expect(await f.review((review) => review.consume(fresh.tokenId, signal))).toBe(false);
    expect(f.dispatch).not.toHaveBeenCalled();
    expect(f.http.submissionAttempts()).toBe(0);
  } finally {
    await f.close();
  }
}, 30000);

it('refuses foreign and delegated evidence review before invoking the trusted resolver', async () => {
  const f = await fixture({ review: true });
  try {
    const token = await f.review((review) => review.generate(new AbortController().signal));
    const path = `/v1/sessions/${f.sessionId}`;
    const url = `${path}/approvals/${token.tokenId}`;
    for (const method of ['GET', 'POST'] as const) {
      const foreign = await f.server.inject({
        method,
        url,
        headers: {
          authorization: 'Bearer other',
          'x-agentbrowser-operation-id': `foreign-${method}`,
        },
        ...(method === 'POST' ? { payload: { decision: 'approve' } } : {}),
      });
      expect(foreign.statusCode).toBe(403);
    }
    const owner = { authorization: 'Bearer owner' };
    const review = await f.server.inject({
      method: 'POST',
      url: `${path}/control/prepare-resume`,
      headers: owner,
    });
    const grant = await f.server.inject({
      method: 'POST',
      url: `${path}/control/delegate`,
      headers: owner,
      payload: { epoch: review.json().epoch, mode: 'forms' },
    });
    expect(grant.statusCode).toBe(200);
    for (const method of ['GET', 'POST'] as const) {
      const denied = await f.server.inject({
        method,
        url,
        headers: {
          authorization: `Bearer ${grant.json().token}`,
          'x-agentbrowser-operation-id': `delegated-${method}`,
        },
        ...(method === 'POST' ? { payload: { decision: 'approve' } } : {}),
      });
      expect(denied.statusCode).toBe(403);
    }
    expect(f.resolutions).not.toHaveBeenCalled();
    expect(f.dispatch).not.toHaveBeenCalled();
    expect(f.http.submissionAttempts()).toBe(0);
  } finally {
    await f.close();
  }
}, 30000);

it('reviews and consumes the complete real draft witness across operator admissions without submission', async () => {
  const f = await fixture({ review: true });
  const signal = new AbortController().signal;
  try {
    const token = await f.review((review) => review.generate(signal));
    expect(token.action.parameters).toMatchObject({ witness: { application: f.draft.read() } });
    expect((await f.review((review) => review.get(token.tokenId, signal)))?.status).toBe('pending');
    expect(
      (await f.review((review) => review.decide(token.tokenId, 'approve', signal)))?.status
    ).toBe('approved');
    expect(await f.review((review) => review.consume(token.tokenId, signal))).toBe(true);
    expect(await f.review((review) => review.consume(token.tokenId, signal))).toBe(false);
    expect(f.http.submissionAttempts()).toBe(0);
  } finally {
    await f.close();
  }
}, 30000);

it('refuses old consent after both app and UI commit a new answer, and refuses uncommitted file replacement', async () => {
  const f = await fixture({ review: true });
  const signal = new AbortController().signal;
  try {
    const token = await f.review((review) => review.generate(signal));
    await f.review((review) => review.decide(token.tokenId, 'approve', signal));
    await f.backing.locator('#referral').fill('New independently committed answer');
    await expect.poll(f.diagnostics).toMatchObject({ pending: 0, failed: false });
    await expect(f.collect()).resolves.toBeDefined();
    expect(await f.review((review) => review.consume(token.tokenId, signal))).toBe(false);
    const replacement = await f.review((review) => review.generate(signal));
    await f.review((review) => review.decide(replacement.tokenId, 'approve', signal));
    await f.backing.locator('#resume').evaluate((node) => {
      const input = node as HTMLInputElement;
      const original = input.files?.[0];
      if (!original) throw new Error('Fixture file');
      const files = new DataTransfer();
      files.items.add(
        new File(['replaced bytes'], original.name, {
          type: original.type,
          lastModified: original.lastModified,
        })
      );
      input.files = files.files;
    });
    await expect(
      f.review((review) => review.consume(replacement.tokenId, signal))
    ).rejects.toThrow();
    expect(f.http.submissionAttempts()).toBe(0);
  } finally {
    await f.close();
  }
}, 30000);

it('requires current draft-source permission to disclose evidence and rejects revoke/regrant resurrection', async () => {
  const f = await fixture({ review: true });
  const signal = new AbortController().signal;
  try {
    const token = await f.review((review) => review.generate(signal));
    await f.review((review) => review.decide(token.tokenId, 'approve', signal));
    f.setPermission(false);
    await expect(f.review((review) => review.get(token.tokenId, signal))).rejects.toThrow();
    f.setPermission(true);
    expect(await f.review((review) => review.get(token.tokenId, signal))).toBeUndefined();
    expect(
      await f.review((review) => review.decide(token.tokenId, 'approve', signal))
    ).toBeUndefined();
    expect(await f.review((review) => review.consume(token.tokenId, signal))).toBe(false);
    expect(f.http.submissionAttempts()).toBe(0);
  } finally {
    await f.close();
  }
}, 30000);

it('collects a private complete witness from the same application and actual service-filled browser form', async () => {
  const f = await fixture();
  try {
    const witness = await f.collect();
    expect(witness.application).toEqual(f.draft.read());
    expect(
      witness.page.controls.find((control) => control.id === 'resume')?.files?.[0]?.sha256
    ).toBe(f.draft.read().attachment?.sha256);
    expect(f.http.submissionAttempts()).toBe(0);
  } finally {
    await f.close();
  }
}, 30000);

it('rejects complete app data when a broken UI handler leaves different committed and visible answers', async () => {
  const f = await fixture({ brokenUi: true });
  try {
    expect(f.draft.read().complete).toBe(true);
    expect(await f.diagnostics()).toMatchObject({ pending: 0, failed: false });
    await expect(f.collect()).rejects.toThrow('Draft witness unavailable');
    expect(f.http.submissionAttempts()).toBe(0);
  } finally {
    await f.close();
  }
}, 30000);

it('rejects fieldset swaps, hidden drift and same-name same-size File replacement without an application commit', async () => {
  const f = await fixture();
  try {
    await f.collect();
    const swapCompanies = () =>
      f.backing.evaluate(() => {
        const current = document.querySelector('#currentCompany');
        const previous = document.querySelector('#previousCompany');
        if (!current || !previous) throw new Error('fixture controls');
        const marker = document.createComment('swap');
        current.replaceWith(marker);
        previous.replaceWith(current);
        marker.replaceWith(previous);
      });
    await swapCompanies();
    await expect(f.collect()).rejects.toThrow();
    await swapCompanies();
    await f.collect();
    await f.backing.locator('#source').evaluate((node) => {
      (node as HTMLInputElement).value = 'changed';
    });
    await expect(f.collect()).rejects.toThrow();
    await f.backing.locator('#source').evaluate((node) => {
      (node as HTMLInputElement).value = 'direct';
    });
    const original = f.draft.read();
    await f.backing.locator('#resume').evaluate((node) => {
      const input = node as HTMLInputElement;
      const previous = input.files?.[0];
      if (!previous) throw new Error('fixture file');
      const data = new DataTransfer();
      data.items.add(
        new File(['replaced bytes'], previous.name, {
          type: previous.type,
          lastModified: previous.lastModified,
        })
      );
      input.files = data.files;
    });
    expect(f.draft.read()).toEqual(original);
    await expect(f.collect()).rejects.toThrow();
    expect(f.http.submissionAttempts()).toBe(0);
  } finally {
    await f.close();
  }
}, 30000);

it('refuses owner drift during collection and refuses a new document after same-URL reload', async () => {
  const f = await fixture();
  try {
    await expect(
      f.collect(() => f.draft.update(f.draft.read().version, { referral: 'external' }))
    ).rejects.toThrow();
    await f.backing.reload();
    await expect(f.collect()).rejects.toThrow();
    expect(f.http.submissionAttempts()).toBe(0);
  } finally {
    await f.close();
  }
}, 30000);

it('refuses pending uploads and failed commits while independent owner data is complete', async () => {
  let armed = false;
  let release = () => {};
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const f = await fixture({
    beforeUploadCommit: async () => {
      if (armed) await blocked;
    },
  });
  try {
    armed = true;
    await f.backing.locator('#resume').evaluate((node) => {
      (node as HTMLInputElement).value = '';
    });
    await f.upload();
    await expect.poll(f.diagnostics).toMatchObject({ pending: 1, failed: false });
    expect(f.draft.read().complete).toBe(true);
    await expect(f.collect()).rejects.toThrow();
    release();
    await expect.poll(f.diagnostics).toMatchObject({ pending: 0, failed: false });
    f.draft.update(f.draft.read().version, { referral: 'external writer' });
    await f.backing.locator('#referral').fill('stale UI write');
    await expect.poll(f.diagnostics).toMatchObject({ pending: 0, failed: true });
    await expect(f.collect()).rejects.toThrow();
    expect(f.http.submissionAttempts()).toBe(0);
  } finally {
    release();
    await f.close();
  }
}, 30000);

it.each([false, true])(
  'enforces consent against qualified native/app evidence (edit after review: %s)',
  async (edit) => {
    const f = await fixture({ review: true, submit: true });
    try {
      const { request, token } = await f.generateSubmission();
      await f.run(() => f.service.decideApproval(f.sessionId, token.tokenId, 'approve'));
      if (edit) {
        await f.backing.locator('[data-automation-id="fullName"]').fill('Changed after review');
        await expect.poll(f.diagnostics).toMatchObject({ pending: 0, failed: false });
        await expect(f.executeSubmission(request, token.tokenId)).rejects.toBeDefined();
        expect(f.draft.submissionCount()).toBe(0);
      } else {
        expect(await f.executeSubmission(request, token.tokenId)).toMatchObject({
          status: 'committed',
        });
        expect(f.draft.submissionCount()).toBe(1);
        expect(f.draft.acceptedAttachment()).toEqual(Buffer.from('original bytes'));
        expect(f.draft.receipt('reviewed-submit')).toMatchObject({
          intent: 'submit',
          accepted: { fields: { fullName: 'Synthetic Person' } },
        });
        expect(await f.executeSubmission(request, token.tokenId)).toMatchObject({ replay: true });
        expect(f.draft.submissionCount()).toBe(1);
      }
      expect(f.http.submissionAttempts()).toBe(0);
    } finally {
      await f.close();
    }
  },
  30000
);
