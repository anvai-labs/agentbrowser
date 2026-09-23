import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type ApplicationReviewSelector,
  type PreparedEvidenceReview,
  TrustedEvidenceSourceRegistry,
  TrustedVerifierRegistry,
  defineEvidenceSource,
  defineVerifier,
  runVerifiedOutcome,
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
import {
  type DraftAcceptance,
  type DraftSnapshot,
  createApplicationDraft,
} from './test-support/application-draft.js';

const SUBMISSION_VERIFIER = Object.freeze({
  id: 'synthetic.submission.accepted',
  version: '1',
});

interface SubmissionExpectation {
  operationId: string;
  tenant: string;
  resource: string;
  accepted: DraftSnapshot;
}

function submissionExpectation(input: unknown): SubmissionExpectation {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error();
  const value = input as Partial<SubmissionExpectation>;
  if (
    typeof value.operationId !== 'string' ||
    typeof value.tenant !== 'string' ||
    typeof value.resource !== 'string' ||
    !value.accepted ||
    typeof value.accepted !== 'object'
  )
    throw new Error();
  return structuredClone(value as SubmissionExpectation);
}

function submissionReceipt(input: unknown): DraftAcceptance {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error();
  return structuredClone(input as DraftAcceptance);
}

const acceptedSubmissionVerifier = defineVerifier({
  descriptor: {
    ...SUBMISSION_VERIFIER,
    inputSchemaId: 'synthetic.submission.expectation',
    evidenceSchemaId: 'synthetic.application.acceptance',
    requiredCapability: 'synthetic.submission.receipt',
    evidenceSource: 'synthetic.application.receipt',
    requiredLayer: 'G6',
    budget: {
      maxReads: 1,
      timeoutMs: 2_000,
      pollIntervalMs: 1,
      cleanupTimeoutMs: 100,
      maxEvidenceRefs: 1,
    },
    redaction: 'reference_only',
    unsupported: [],
    cleanup: 'not_needed',
  },
  parseInput: submissionExpectation,
  parseEvidence: submissionReceipt,
  predicate: (expected, actual) =>
    actual.contract.id === 'synthetic-application-acceptance' &&
    actual.contract.version === 1 &&
    typeof actual.submissionId === 'string' &&
    actual.submissionId.length > 0 &&
    actual.operationId === expected.operationId &&
    actual.tenant === expected.tenant &&
    actual.resource === expected.resource &&
    actual.intent === 'submit' &&
    actual.committedVersion === expected.accepted.version + 1 &&
    canonicalJson(actual.accepted) === canonicalJson(expected.accepted),
});

interface ExternalReceiptContext {
  client: AgentBrowserClient;
  sessionId: string;
  tenant: string;
  permissionGeneration: number;
}

function externalSubmissionEvidence(expected: SubmissionExpectation) {
  const verifierRegistry = new TrustedVerifierRegistry([acceptedSubmissionVerifier]);
  const evidenceSources = new TrustedEvidenceSourceRegistry<ExternalReceiptContext>([
    defineEvidenceSource({
      descriptor: {
        id: 'synthetic.application.receipt',
        capability: 'synthetic.submission.receipt',
        correlation: 'required',
        authorization: 'required',
      },
      authorize(request) {
        if (
          request.context.tenant !== expected.tenant ||
          request.correlationId !== expected.operationId ||
          request.verifier.id !== SUBMISSION_VERIFIER.id ||
          request.verifier.version !== SUBMISSION_VERIFIER.version ||
          canonicalJson(request.verifier.input) !== canonicalJson(expected)
        )
          return undefined;
        const generation = request.context.permissionGeneration;
        return {
          generation,
          currentGeneration: () => request.context.permissionGeneration,
        };
      },
      async read(context, _signal, operationId) {
        if (!operationId) throw new Error('Missing operation identity');
        const evidence = await context.client.sessions.applicationReceipt(
          context.sessionId,
          operationId
        );
        return {
          status: 'ready' as const,
          evidence,
          evidenceRefIds: ['synthetic_application_receipt'],
        };
      },
    }),
  ]);
  return { verifierRegistry, evidenceSources };
}

async function fixture(
  options: {
    brokenUi?: boolean;
    beforeUploadCommit?: () => Promise<void>;
    loseSubmitReturn?: boolean;
    providerNativeReader?: boolean;
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
  const submissionOperation = options.loseSubmitReturn
    ? {
        mode: draft.submissionOperation.mode,
        review: draft.submissionOperation.review,
        prepare(input: unknown) {
          const execute = draft.submissionOperation.prepare(input);
          return async (scope: Parameters<typeof execute>[0]) => {
            const result = await execute(scope);
            if (result.status === 'committed') throw new Error('Synthetic response lost');
            return result;
          };
        },
      }
    : draft.submissionOperation;
  type ReviewProvider = NonNullable<ServiceDependencies['evidenceReviewProvider']>;
  let resolveReview: ReviewProvider;
  const resolutions = vi.fn(
    (request: Parameters<ReviewProvider>[0], context: Parameters<ReviewProvider>[1]) =>
      resolveReview?.(request, context)
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
            operations: { ...draft.adapter.operations, submit: submissionOperation },
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
    let captured: AgentBrowserService | undefined;
    let sessionId: string;
    let baseUrl: string | undefined;
    let client: AgentBrowserClient | undefined;
    const sessionRequest = {
      controlMode: 'delegated' as const,
      headless: true,
      ...(options.review ? { policy: { approval: { review: 'operator' as const } } } : {}),
    };
    if (options.providerNativeReader) {
      await server.listen({ host: '127.0.0.1', port: 0 });
      baseUrl = `http://127.0.0.1:${(server.server.address() as AddressInfo).port}`;
      client = new AgentBrowserClient({ baseUrl, apiKey: 'owner' });
      sessionId = (await client.sessions.create(sessionRequest)).sessionId;
    } else {
      // Internal-owner tests keep their direct seam; public qualification never installs this spy.
      const original = AgentBrowserService.prototype.createSession;
      const capture = vi
        .spyOn(AgentBrowserService.prototype, 'createSession')
        .mockImplementation(function (this: AgentBrowserService, request) {
          captured = this;
          return original.call(this, request);
        });
      try {
        const created = await server.inject({
          method: 'POST',
          url: '/v1/sessions',
          headers: { authorization: 'Bearer owner' },
          payload: sessionRequest,
        });
        expect(created.statusCode).toBe(201);
        sessionId = created.json().sessionId;
      } finally {
        capture.mockRestore();
      }
    }
    const internalService = () => {
      assert(captured);
      return captured;
    };
    permittedSession = sessionId;
    const operator = { actor: 'operator' as const, tenant: 'owner' };
    const run = async <T>(callback: () => Promise<T>): Promise<T> => {
      const service = internalService();
      const result = await service.authority.run(sessionId, operator, {}, callback);
      if (result && typeof result === 'object' && 'replay' in result)
        throw new Error('Unexpected replay');
      return result as T;
    };
    if (client)
      await client.sessions.applicationBind(sessionId, {
        adapter: draft.adapter.id,
        resource: 'live-witness',
      });
    else
      internalService().applicationBind(sessionId, operator, {
        adapter: draft.adapter.id,
        resource: 'live-witness',
      });
    const { pageId } = client
      ? await client.sessions.createPage(sessionId, { url: http.url })
      : await run(() => internalService().createPage(sessionId, { url: http.url }));
    assert(raw);
    const backing = (raw as EnginePage & { backingPage(): Page }).backingPage();
    const expectedPage = client
      ? undefined
      : await run(async () => {
          const service = internalService();
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
    const autofillRequest = {
      fields: [
        { match: { dataAutomationId: 'fullName' }, value: 'Synthetic Person', verify: 'exact' },
        { match: { dataAutomationId: 'currentCompany' }, value: 'Current Co', verify: 'exact' },
        { match: { dataAutomationId: 'previousCompany' }, value: 'Previous Co', verify: 'exact' },
        { match: { label: 'Work preference' }, option: { value: 'remote' }, verify: 'exact' },
      ],
      policy: { settleMs: 0 },
    };
    const fill = client
      ? await client.sessions.autofill(sessionId, pageId, autofillRequest)
      : await run(() => internalService().autofill(sessionId, pageId, autofillRequest));
    expect(fill.ok).toBe(true);
    const act = async (role: string, action: 'check' | 'upload') =>
      client
        ? (async () => {
            const observed = await client.sessions.observe(sessionId, pageId, {
              include: ['fileInputs'],
            });
            const target = observed.elements.find((element) => element.role === role);
            assert(target);
            const result = await client.sessions.executeAction(sessionId, pageId, {
              action,
              target: { ref: target.ref },
              ...(action === 'upload' ? { paths: [filename] } : {}),
            });
            expect(result).toMatchObject({ status: 'success' });
          })()
        : run(async () => {
            const service = internalService();
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
      assert(expectedPage);
      const signal = new AbortController().signal;
      const application = sources.prepareRead(
        'draft',
        'application.draft',
        { sessionId, pageId, signal },
        'witness-check',
        verifier
      );
      assert(application);
      const page = internalService().prepareNativeFormReadInScope(sessionId, pageId);
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
        expect(internalService().authority.didDispatchInScope(sessionId)).toBe(false);
        return result;
      });
    const composition = () => {
      const { collector, application, page } = prepareCollector();
      return {
        action: {
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
    const sourceHint = Object.freeze({
      ownerId: permissionOwnerId,
      contract: Object.freeze({ id: 'synthetic-native-draft', version: '1' }),
    });
    const applicationReviewRequest = (operationId: string) => {
      const expected = draft.read();
      return {
        pageId,
        source: sourceHint,
        request: {
          operation: 'submit',
          operationId,
          expectedVersion: expected.version,
          input: { intent: 'submit', expected },
        },
      };
    };
    type ExpectedPage = Parameters<typeof createDraftWitnessCollector>[0]['expected']['page'];
    let providerExpectedPage: ExpectedPage | undefined;
    const providerComposition = (nativeForm: Parameters<ReviewProvider>[1]['nativeForm']) => {
      const signal = new AbortController().signal;
      const application = sources.prepareRead(
        'draft',
        'application.draft',
        { sessionId, pageId, signal },
        'witness-check',
        verifier
      );
      assert(application);
      const collector = async (collectSignal: AbortSignal) => {
        let pinned = providerExpectedPage;
        if (!pinned) {
          const native = await nativeForm.read(collectSignal);
          pinned = {
            ...nativeForm.identity,
            url: new URL(http.url).href,
            documentId: native.documentId,
            formNodeId: native.form.nodeId,
            controls: Object.fromEntries(
              native.controls.map(({ id, nodeId, blockId }) => [id, { nodeId, blockId }])
            ),
          };
        }
        const read = createDraftWitnessCollector({
          application,
          page: nativeForm,
          expected: { page: pinned, application: expectedApplication },
        });
        const result = await read(collectSignal);
        providerExpectedPage ??= structuredClone(pinned);
        return result;
      };
      return {
        source: {
          ownerId: permissionOwnerId,
          contract: { id: 'synthetic-native-draft', version: '1' },
          permission: {
            generation: permissionGeneration,
            currentGeneration: () => permissionGeneration,
          },
          assertAuthorized() {
            application.assertAuthorized();
            nativeForm.assertAuthority();
          },
          collect: collector,
        },
      };
    };
    resolveReview = (request, context) => {
      if (
        request.identity.tenant !== 'owner' ||
        request.identity.sessionId !== sessionId ||
        request.identity.pageId !== pageId ||
        context.nativeForm.identity.sessionId !== request.identity.sessionId ||
        context.nativeForm.identity.pageId !== request.identity.pageId ||
        context.nativeForm.identity.sessionIncarnation !== request.identity.sessionIncarnation ||
        request.source.ownerId !== permissionOwnerId ||
        request.source.contract.id !== 'synthetic-native-draft' ||
        request.source.contract.version !== '1'
      )
        return undefined;
      const selected = (
        request as typeof request & { application?: Readonly<ApplicationReviewSelector> }
      ).application;
      if (options.providerNativeReader) {
        if (!selected) return undefined;
        const current = draft.read();
        if (
          selected.adapter !== draft.adapter.id ||
          selected.resource !== 'live-witness' ||
          selected.operation !== 'submit' ||
          selected.expectedVersion !== current.version
        )
          return undefined;
        const configured = providerComposition(context.nativeForm);
        return {
          source: configured.source,
          action: {
            type: 'application-submit',
            intent: 'submit',
            tenant: 'owner',
            sessionId,
            sessionIncarnation: request.identity.sessionIncarnation,
            adapter: selected.adapter,
            resource: selected.resource,
            bindingGeneration: selected.bindingGeneration,
            operation: selected.operation,
            operationId: selected.operationId,
            expectedVersion: selected.expectedVersion,
            input: { intent: 'submit', expected: current },
          },
        };
      }
      assert(expectedPage);
      if (request.identity.sessionIncarnation !== expectedPage.sessionIncarnation) return undefined;
      if (!selected) return composition();
      const current = draft.read();
      if (
        selected.adapter !== draft.adapter.id ||
        selected.resource !== 'live-witness' ||
        selected.operation !== 'submit' ||
        selected.expectedVersion !== current.version
      )
        return undefined;
      const configured = composition();
      return {
        source: configured.source,
        action: {
          type: 'application-submit',
          intent: 'submit',
          tenant: 'owner',
          sessionId,
          sessionIncarnation: expectedPage.sessionIncarnation,
          adapter: selected.adapter,
          resource: selected.resource,
          bindingGeneration: selected.bindingGeneration,
          operation: selected.operation,
          operationId: selected.operationId,
          expectedVersion: selected.expectedVersion,
          input: { intent: 'submit', expected: current },
        },
      };
    };
    const review = <T>(callback: (prepared: PreparedEvidenceReview) => Promise<T>) =>
      run(async () => {
        const service = internalService();
        const prepared = service.prepareEvidenceReviewInScope(sessionId, pageId, composition());
        const result = await callback(prepared);
        expect(service.authority.didDispatchInScope(sessionId)).toBe(false);
        return result;
      });
    return {
      draft,
      http,
      server,
      sessionId,
      resolutions,
      dispatch: vi.spyOn(raw, 'act'),
      get service() {
        return internalService();
      },
      baseUrl,
      client,
      backing,
      collect,
      review,
      run,
      sourceHint,
      applicationReviewRequest,
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

async function publicApplicationSurface(f: Awaited<ReturnType<typeof fixture>>) {
  if (!f.baseUrl) await f.server.listen({ host: '127.0.0.1', port: 0 });
  const baseUrl = `http://127.0.0.1:${(f.server.server.address() as AddressInfo).port}`;
  const client = new AgentBrowserClient({ baseUrl, apiKey: 'owner' });
  const cli = fileURLToPath(new URL('../../cli/dist/bin.js', import.meta.url));
  const invoke = (
    args: string[],
    options: { operationId?: string; expectedExitCode?: number } = {}
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
        token: 'owner',
        ...(options.expectedExitCode !== undefined
          ? { expectedExitCode: options.expectedExitCode }
          : {}),
      }
    );
  return { baseUrl, client, invoke };
}

function executeReviewedSubmission(
  f: Awaited<ReturnType<typeof fixture>>,
  invoke: Awaited<ReturnType<typeof publicApplicationSurface>>['invoke'],
  body: ReturnType<typeof f.applicationReviewRequest>,
  approvalToken: string
) {
  return invoke(
    [
      'application',
      'execute',
      f.sessionId,
      body.request.operation,
      JSON.stringify(body.request.input),
      '--expected-version',
      String(body.request.expectedVersion),
      '--approval-token',
      approvalToken,
    ],
    { operationId: body.request.operationId }
  );
}

it('creates, inspects, approves and qualifies a protected application submission through the public CLI', async () => {
  const f = await fixture({ review: true, submit: true, providerNativeReader: true });
  try {
    const { client, invoke } = await publicApplicationSurface(f);
    const first = f.applicationReviewRequest('public-reviewed-submit');
    const created = JSON.parse(
      (await invoke(['application', 'review', f.sessionId, JSON.stringify(first)])).stdout
    );
    expect(created).toMatchObject({ status: 'pending' });
    await expect(
      client.sessions.operation(f.sessionId, first.request.operationId)
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(f.draft.submissionCount()).toBe(0);

    // One real permission owner can independently reconstruct more than one planned operation.
    const second = f.applicationReviewRequest('public-reviewed-submit-two');
    const secondToken = await client.sessions.applicationReview(f.sessionId, second);
    expect(secondToken).toMatchObject({ status: 'pending' });
    expect(secondToken.tokenId).not.toBe(created.tokenId);
    await expect(
      client.sessions.operation(f.sessionId, second.request.operationId)
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(f.draft.submissionCount()).toBe(0);

    const inspected = JSON.parse(
      (await invoke(['session', 'approval', f.sessionId, created.tokenId])).stdout
    );
    expect(inspected).toEqual(created);
    const approved = JSON.parse(
      (
        await invoke(
          ['session', 'approval-decide', f.sessionId, created.tokenId, '--decision', 'approve'],
          { operationId: 'approve-public-reviewed-submit' }
        )
      ).stdout
    );
    expect(approved).toMatchObject({ tokenId: created.tokenId, status: 'approved' });

    const expected: SubmissionExpectation = {
      operationId: first.request.operationId,
      tenant: 'owner',
      resource: 'live-witness',
      accepted: first.request.input.expected,
    };
    const { verifierRegistry, evidenceSources } = externalSubmissionEvidence(expected);
    const context: ExternalReceiptContext = {
      client,
      sessionId: f.sessionId,
      tenant: 'owner',
      permissionGeneration: 1,
    };
    const qualified = await runVerifiedOutcome({
      verifierRegistry,
      evidenceSources,
      verifier: { ...SUBMISSION_VERIFIER, input: expected },
      context,
      evidenceCorrelationId: expected.operationId,
      execute: async () =>
        JSON.parse((await executeReviewedSubmission(f, invoke, first, created.tokenId)).stdout),
      executionFailed: (result) =>
        !result ||
        typeof result !== 'object' ||
        (result as { status?: unknown }).status !== 'committed',
      assertAuthority: () => undefined,
      didDispatch: () => f.draft.submissionCount() === 1,
      testedSeam: 'application',
    });
    expect(qualified).toMatchObject({
      outcome: {
        availability: 'available',
        execution: 'completed',
        verification: {
          status: 'passed',
          requiredLayer: 'G6',
          achievedLayer: 'G6',
          evidenceRefIds: ['synthetic_application_receipt'],
        },
        testedSeam: 'application',
      },
      result: { status: 'committed' },
    });
    expect(f.draft.submissionCount()).toBe(1);
    expect(f.draft.acceptedAttachment()).toEqual(Buffer.from('original bytes'));

    const receipt = await client.sessions.applicationReceipt(f.sessionId, expected.operationId);
    const acceptedAttachment = expected.accepted.attachment;
    assert(acceptedAttachment);
    for (const wrong of [
      { ...expected, operationId: 'wrong-operation' },
      { ...expected, accepted: { ...expected.accepted, incarnation: 'wrong-incarnation' } },
      { ...expected, accepted: { ...expected.accepted, destination: 'https://wrong.test/' } },
      {
        ...expected,
        accepted: {
          ...expected.accepted,
          attachment: { ...acceptedAttachment, sha256: '0'.repeat(64) },
        },
      },
      { ...expected, accepted: { ...expected.accepted, version: expected.accepted.version + 1 } },
    ])
      expect(
        verifierRegistry.evaluate(
          SUBMISSION_VERIFIER.id,
          SUBMISSION_VERIFIER.version,
          wrong,
          receipt,
          ['synthetic_application_receipt']
        )
      ).toMatchObject({ status: 'failed', achievedLayer: 'G6' });

    const replay = JSON.parse(
      (await executeReviewedSubmission(f, invoke, first, created.tokenId)).stdout
    );
    expect(replay).toMatchObject({ replay: true, operation: { status: 'completed' } });
    expect(f.draft.submissionCount()).toBe(1);
    expect(secondToken.status).toBe('pending');
    const applicationSelections = f.resolutions.mock.calls
      .map(
        ([request]) =>
          (request as typeof request & { application?: ApplicationReviewSelector }).application
      )
      .filter((value): value is ApplicationReviewSelector => value !== undefined);
    expect(new Set(applicationSelections.map((value) => value.operationId))).toEqual(
      new Set([first.request.operationId, second.request.operationId])
    );
  } finally {
    await f.close();
  }
}, 60_000);

it('keeps a lost public execution unknown and records separate named receipt reconciliation', async () => {
  const f = await fixture({
    review: true,
    submit: true,
    providerNativeReader: true,
    loseSubmitReturn: true,
  });
  try {
    const { client, invoke } = await publicApplicationSurface(f);
    const body = f.applicationReviewRequest('public-lost-submit');
    const token = JSON.parse(
      (await invoke(['application', 'review', f.sessionId, JSON.stringify(body)])).stdout
    );
    await invoke(
      ['session', 'approval-decide', f.sessionId, token.tokenId, '--decision', 'approve'],
      { operationId: 'approve-public-lost-submit' }
    );
    const expected: SubmissionExpectation = {
      operationId: body.request.operationId,
      tenant: 'owner',
      resource: 'live-witness',
      accepted: body.request.input.expected,
    };
    const { verifierRegistry, evidenceSources } = externalSubmissionEvidence(expected);
    const context: ExternalReceiptContext = {
      client,
      sessionId: f.sessionId,
      tenant: 'owner',
      permissionGeneration: 1,
    };
    const original = await runVerifiedOutcome({
      verifierRegistry,
      evidenceSources,
      verifier: { ...SUBMISSION_VERIFIER, input: expected },
      context,
      evidenceCorrelationId: expected.operationId,
      execute: () => executeReviewedSubmission(f, invoke, body, token.tokenId),
      assertAuthority: () => undefined,
      didDispatch: () => f.draft.submissionCount() === 1,
      testedSeam: 'application',
    });
    expect(original).toEqual({
      outcome: {
        availability: 'available',
        execution: 'unknown',
        verification: {
          status: 'unknown',
          verifier: SUBMISSION_VERIFIER,
          requiredLayer: 'G6',
          evidenceRefIds: [],
        },
        cleanup: 'not_needed',
        testedSeam: 'application',
      },
    });
    expect(await client.sessions.operation(f.sessionId, expected.operationId)).toMatchObject({
      status: 'outcome_unknown',
      dispatched: true,
    });
    expect(f.draft.submissionCount()).toBe(1);

    // This is a separate fresh observation. It does not rewrite the original unknown execution.
    const read = await evidenceSources.read(
      'synthetic.application.receipt',
      'synthetic.submission.receipt',
      context,
      new AbortController().signal,
      expected.operationId,
      { ...SUBMISSION_VERIFIER, input: expected }
    );
    expect(read.status).toBe('ready');
    assert(read.status === 'ready');
    expect(
      verifierRegistry.evaluate(
        SUBMISSION_VERIFIER.id,
        SUBMISSION_VERIFIER.version,
        expected,
        read.evidence,
        read.evidenceRefIds
      )
    ).toMatchObject({ status: 'passed', achievedLayer: 'G6' });
    expect(original.outcome.execution).toBe('unknown');
    expect(original.outcome.verification.status).toBe('unknown');
    expect(f.draft.acceptedAttachment()).toEqual(Buffer.from('original bytes'));

    const replay = JSON.parse(
      (await executeReviewedSubmission(f, invoke, body, token.tokenId)).stdout
    );
    expect(replay).toMatchObject({ replay: true, operation: { status: 'outcome_unknown' } });
    expect(f.draft.submissionCount()).toBe(1);
  } finally {
    await f.close();
  }
}, 60_000);

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

it.each([
  [
    'visible committed answer',
    async (f: Awaited<ReturnType<typeof fixture>>) => {
      await f.backing.locator('[data-automation-id="fullName"]').fill('Changed after review');
      await expect.poll(f.diagnostics).toMatchObject({ pending: 0, failed: false });
    },
  ],
  [
    'hidden native answer',
    async (f: Awaited<ReturnType<typeof fixture>>) => {
      await f.backing.locator('#source').evaluate((node) => {
        (node as HTMLInputElement).value = 'changed after review';
      });
    },
  ],
  [
    'same-metadata file bytes',
    async (f: Awaited<ReturnType<typeof fixture>>) => {
      await f.backing.locator('#resume').evaluate((node) => {
        const input = node as HTMLInputElement;
        const previous = input.files?.[0];
        if (!previous) throw new Error('fixture file');
        const replacement = new DataTransfer();
        replacement.items.add(
          new File(['replaced bytes'], previous.name, {
            type: previous.type,
            lastModified: previous.lastModified,
          })
        );
        input.files = replacement.files;
      });
    },
  ],
])(
  'refuses a public protected submission after review when %s drifts',
  async (_name, mutate) => {
    const f = await fixture({ review: true, submit: true, providerNativeReader: true });
    try {
      const { client, invoke } = await publicApplicationSurface(f);
      const body = f.applicationReviewRequest(`public-consent-drift-${randomUUID()}`);
      const token = JSON.parse(
        (await invoke(['application', 'review', f.sessionId, JSON.stringify(body)])).stdout
      );
      await invoke(
        ['session', 'approval-decide', f.sessionId, token.tokenId, '--decision', 'approve'],
        { operationId: `approve-public-consent-drift-${randomUUID()}` }
      );

      await mutate(f);
      await expect(executeReviewedSubmission(f, invoke, body, token.tokenId)).rejects.toBeDefined();
      expect(await client.sessions.operation(f.sessionId, body.request.operationId)).toMatchObject({
        status: 'failed',
        dispatched: false,
      });
      expect(f.draft.submissionCount()).toBe(0);
      expect(f.http.submissionAttempts()).toBe(0);
    } finally {
      await f.close();
    }
  },
  60_000
);
