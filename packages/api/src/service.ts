/**
 * AgentBrowserService - the composition root
 *
 * Wires the real stack together: SessionCoordinator for lifecycle, an
 * injected BrowserEngine, ObservationNormalizer for semantic observations,
 * ActionExecutor for ref-based actions, NetworkPolicy for navigation egress
 * (SSRF defense on by default), and the ApprovalGate for high-risk elements.
 *
 * The service is the revision authority: it stamps normalized refs and
 * validates staleness in its own revision space, and projects engine action
 * effects into that space. Element refs are scoped to session + page and are
 * only accepted as refs - never selectors.
 */

import {
  ActionExecutor,
  ApprovalGate,
  ObservationNormalizer,
  SecretManager,
  SessionCoordinator,
} from '@agentbrowser/core';
import type { BrowserEngine, EnginePage } from '@agentbrowser/engine';
import type { EngineSession, EngineSessionOptions } from '@agentbrowser/engine';
import { NetworkPolicy } from '@agentbrowser/policy';
import type {
  ArtifactRef,
  ObservationRequest,
  PageElement,
  PageState,
  ScreenshotRequest,
} from '@agentbrowser/protocol';

/** Typed failure carrying a protocol error code. */
export class ServiceError extends Error {
  constructor(
    public code: string,
    message: string,
    public retryable = false,
    public details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'ServiceError';
  }
}

export interface ServiceSessionRequest {
  tenantId?: string;
  engine?: string;
  ttlMs?: number;
  idleTimeoutMs?: number;
  viewport?: { width: number; height: number };
  locale?: string;
  timezoneId?: string;
  headless?: boolean;
}

export interface ServiceSessionView {
  sessionId: string;
  status: string;
  engine: { name: string; version: string };
  createdAt: string;
  ttlMs: number;
  idleTimeoutMs: number;
}

export interface ServicePageView {
  pageId: string;
  sessionId: string;
  status: string;
  url?: string;
  title?: string;
}

export interface ServiceActRequest {
  action: string;
  target?: { ref: string } | undefined;
  value?: string | undefined;
  key?: string | undefined;
  direction?: 'up' | 'down' | 'left' | 'right' | undefined;
  amount?: number | undefined;
  observe?: 'after' | 'none' | undefined;
  expectedRevision?: number | undefined;
  approvalToken?: string | undefined;
}

export interface ServiceActResult {
  status: 'success';
  actionId: string;
  newRevision: number;
  observation?: PageState | undefined;
}

export interface ServiceDependencies {
  engine: BrowserEngine;
  coordinator?: SessionCoordinator;
  normalizer?: ObservationNormalizer;
  executor?: ActionExecutor;
  networkPolicy?: NetworkPolicy;
  approvalGate?: ApprovalGate;
  /** Secret registry; values are redacted from every service output. */
  secretManager?: SecretManager;
}

/** Risk classes that require an approval token before the action runs. */
const HIGH_RISK_EFFECTS = new Set([
  'transaction',
  'account-security',
  'external-message',
  'destructive',
]);

const REF_PATTERN = /^e(\d+)_(\d+)$/;

interface PageContext {
  sessionId: string;
  enginePage: EnginePage;
  revision: number;
  /** The last observation handed to a client, in service revision space. */
  lastObservation?:
    | {
        revision: number;
        /** normalized ref -> engine ref */
        refMap: Map<string, string>;
        byRef: Map<string, PageElement>;
      }
    | undefined;
}

/** Observation options as they arrive from a route body (possibly undefined). */
export type PartialObservation = {
  mode?: ObservationRequest['mode'] | undefined;
  maxElements?: number | undefined;
  maxBytes?: number | undefined;
};

export class AgentBrowserService {
  private readonly engine: BrowserEngine;
  private readonly coordinator: SessionCoordinator;
  private readonly normalizer: ObservationNormalizer;
  private readonly executor: ActionExecutor;
  private readonly networkPolicy: NetworkPolicy;
  private readonly approvalGate: ApprovalGate;
  private readonly secretManager: SecretManager;
  private readonly pages = new Map<string, PageContext>();
  private pageCounter = 0;

  constructor(deps: ServiceDependencies) {
    this.engine = deps.engine;
    this.coordinator =
      deps.coordinator ?? new SessionCoordinator({ cleanupCheckIntervalMs: 3_600_000 });
    this.normalizer = deps.normalizer ?? new ObservationNormalizer();
    this.executor = deps.executor ?? new ActionExecutor(this.normalizer);
    // SSRF defenses are on by default (ADR-006): loopback, private ranges and
    // cloud metadata endpoints are blocked unless a policy is injected.
    this.networkPolicy =
      deps.networkPolicy ??
      new NetworkPolicy({ blockLoopback: true, blockPrivateIPs: true, blockMetadata: true });
    this.approvalGate = deps.approvalGate ?? new ApprovalGate({ cleanupIntervalMs: 3_600_000 });
    // An empty registry redacts nothing; a populated one is enforced at every
    // output boundary (observations, error messages, error details).
    this.secretManager = deps.secretManager ?? new SecretManager();
  }

  // ---- sessions -----------------------------------------------------------

  async createSession(request: ServiceSessionRequest): Promise<ServiceSessionView> {
    const engineRequest: EngineSessionOptions & { engine: 'auto' } = { engine: 'auto' };
    if (request.viewport !== undefined) engineRequest.viewport = request.viewport;
    if (request.locale !== undefined) engineRequest.locale = request.locale;
    if (request.timezoneId !== undefined) engineRequest.timezoneId = request.timezoneId;
    if (request.headless !== undefined) engineRequest.headless = request.headless;

    let session: import('@agentbrowser/protocol').SessionResponse;
    try {
      session = await this.coordinator.create(
        {
          ...engineRequest,
          ...(request.ttlMs !== undefined ? { ttlMs: request.ttlMs } : {}),
          ...(request.idleTimeoutMs !== undefined ? { idleTimeoutMs: request.idleTimeoutMs } : {}),
        },
        this.engine
      );
    } catch (error) {
      throw this.mapError(error);
    }

    return {
      sessionId: session.sessionId,
      status: 'ready',
      engine: { name: session.engine.name, version: session.engine.version },
      createdAt: session.createdAt,
      ttlMs: session.ttlMs,
      idleTimeoutMs: session.idleTimeoutMs,
    };
  }

  getSession(sessionId: string): ServiceSessionView | undefined {
    const context = this.coordinator.get(sessionId);
    if (!context) {
      return undefined;
    }
    return {
      sessionId: context.id,
      status: context.state.toLowerCase(),
      engine: { name: context.metadata.engineName, version: this.engine.version },
      createdAt: new Date(context.metadata.createdAt).toISOString(),
      ttlMs: context.metadata.ttlMs,
      idleTimeoutMs: context.metadata.idleTimeoutMs,
    };
  }

  listSessions(): ServiceSessionView[] {
    return this.coordinator.getAllSessions().map((metadata) => ({
      sessionId: metadata.id,
      status: metadata.state.toLowerCase(),
      engine: { name: metadata.engineName, version: this.engine.version },
      createdAt: new Date(metadata.createdAt).toISOString(),
      ttlMs: metadata.ttlMs,
      idleTimeoutMs: metadata.idleTimeoutMs,
    }));
  }

  async closeSession(sessionId: string): Promise<void> {
    try {
      await this.coordinator.close(sessionId);
    } catch (error) {
      throw this.mapError(error);
    }
    for (const [pageId, page] of this.pages) {
      if (page.sessionId === sessionId) {
        this.pages.delete(pageId);
      }
    }
  }

  // ---- pages --------------------------------------------------------------

  async createPage(sessionId: string): Promise<ServicePageView> {
    const session = this.requireSession(sessionId);
    this.coordinator.updateActivity(sessionId);

    const enginePage = await session.engineSession.newPage();
    const pageId = `pg_${++this.pageCounter}_${enginePage.id}`;
    this.pages.set(pageId, { sessionId, enginePage, revision: 1 });

    return { pageId, sessionId, status: 'ready' };
  }

  getPage(sessionId: string, pageId: string): ServicePageView | undefined {
    const page = this.pages.get(pageId);
    if (!page || page.sessionId !== sessionId) {
      return undefined;
    }
    return { pageId, sessionId, status: 'active' };
  }

  async closePage(sessionId: string, pageId: string): Promise<void> {
    const page = this.requirePage(sessionId, pageId);
    this.coordinator.updateActivity(sessionId);

    await page.enginePage.close();
    this.pages.delete(pageId);
  }

  // ---- navigation ---------------------------------------------------------

  async navigate(
    sessionId: string,
    pageId: string,
    request: { url: string; waitUntil?: 'load' | 'domcontentloaded' | 'networkidle' | undefined }
  ): Promise<{ status: string; url: string; redirectChain: string[] }> {
    const page = this.requirePage(sessionId, pageId);
    this.coordinator.updateActivity(sessionId);

    const url = request.url;
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new ServiceError('INVALID_REQUEST', `Invalid URL: ${url.slice(0, 100)}`, false);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new ServiceError(
        'POLICY_DENIED',
        `Navigation accepts http(s) URLs only; '${parsed.protocol}' is not permitted.`,
        false,
        { url: redactUrl(url) }
      );
    }

    const hostname = this.hostnameOf(url);
    try {
      await this.networkPolicy.checkRequest({ hostname, url });
    } catch (error) {
      throw this.mapError(error);
    }

    const result = await page.enginePage.navigate({
      url,
      ...(request.waitUntil !== undefined ? { waitUntil: request.waitUntil } : {}),
    });
    page.revision += 1;
    page.lastObservation = undefined;

    return { status: result.status, url: result.url, redirectChain: result.redirectChain };
  }

  // ---- observation --------------------------------------------------------

  async observe(
    sessionId: string,
    pageId: string,
    request: PartialObservation
  ): Promise<PageState> {
    const page = this.requirePage(sessionId, pageId);
    this.coordinator.updateActivity(sessionId);

    const observationRequest: ObservationRequest = {
      ...(request.mode !== undefined ? { mode: request.mode } : {}),
      ...(request.maxElements !== undefined ? { maxElements: request.maxElements } : {}),
    };
    const raw = await page.enginePage.observe(observationRequest);

    const observation = this.normalizer.normalize(raw, {
      ...(request.mode !== undefined ? { mode: request.mode } : {}),
      ...(request.maxElements !== undefined ? { maxElements: request.maxElements } : {}),
      revision: page.revision,
      sessionId,
      pageId,
    });

    // Bridge normalized refs back to engine refs so actions can resolve them.
    const refMap = new Map<string, string>();
    const byRef = new Map<string, PageElement>();
    observation.elements.forEach((element, index) => {
      byRef.set(element.ref, element);
      const engineRef = raw.elements[index]?.ref;
      if (engineRef !== undefined) {
        refMap.set(element.ref, engineRef);
      }
    });
    page.lastObservation = { revision: page.revision, refMap, byRef };

    // A secret value that reached the page (a sensitive fill) must never be
    // echoed back to a client.
    return this.secretManager.redact(observation);
  }

  // ---- actions ------------------------------------------------------------

  async act(
    sessionId: string,
    pageId: string,
    request: ServiceActRequest
  ): Promise<ServiceActResult> {
    const page = this.requirePage(sessionId, pageId);
    this.coordinator.updateActivity(sessionId);

    const ref = request.target?.ref;
    if (ref !== undefined) {
      if (!REF_PATTERN.test(ref)) {
        throw new ServiceError(
          'INVALID_REQUEST',
          `Invalid element reference '${ref}'. Expected e<revision>_<ordinal>, such as e1_0.`,
          false,
          { ref }
        );
      }
      if (!page.lastObservation) {
        throw new ServiceError(
          'INVALID_REQUEST',
          'Observe the page before acting: element refs are minted by observation.',
          false
        );
      }
    }

    await this.checkApproval(sessionId, page, request);

    // The adapter projects the engine into service revision space: refs are
    // translated before they reach the engine, and action effects come back
    // stamped with the service's revision rather than the engine's counter.
    // A fill value may be a vault reference: resolve it here, at the last
    // moment, so only the engine ever sees the raw secret.
    const actRequest: ServiceActRequest = { ...request };
    if (
      actRequest.action === 'fill' &&
      actRequest.value !== undefined &&
      this.secretManager.isReference(actRequest.value)
    ) {
      try {
        actRequest.value = await this.secretManager.resolve(actRequest.value);
      } catch (error) {
        const secretError = error as { name?: string; code?: string; message?: string };
        throw this.redactedError(
          secretError?.name === 'SecretError' && secretError.code
            ? new ServiceError(secretError.code, secretError.message ?? 'secret error', false)
            : new ServiceError('INTERNAL', String(error))
        );
      }
    }

    const adapter = new RefTranslatingPage(page.enginePage, page);
    const result = await this.executor.execute(
      {
        pageId,
        expectedRevision: actRequest.expectedRevision ?? page.revision,
        action: this.toProtocolAction(actRequest),
      },
      {
        enginePage: adapter,
        observation: this.lastObservationOf(page),
        currentRevision: page.revision,
      }
    );

    if (result.error) {
      throw this.redactedError(
        new ServiceError(
          result.error.code,
          result.error.message,
          result.error.retryable,
          result.error.details
        )
      );
    }

    page.revision = result.newRevision;

    // A requested post-action observation goes through the service's own
    // observe(), so its refs are minted, mapped and immediately actionable.
    let observation: PageState | undefined;
    if (request.observe === 'after') {
      observation = await this.observe(sessionId, pageId, { mode: 'interactive' });
    }

    return {
      status: 'success',
      actionId: result.actionId,
      newRevision: result.newRevision,
      observation,
    };
  }

  // ---- screenshots --------------------------------------------------------

  async screenshot(
    sessionId: string,
    pageId: string,
    request: ScreenshotRequest
  ): Promise<ArtifactRef> {
    const page = this.requirePage(sessionId, pageId);
    this.coordinator.updateActivity(sessionId);

    const artifact = await page.enginePage.screenshot(request);
    return {
      artifactId: artifact.artifactId,
      type: 'screenshot',
      contentType: artifact.contentType,
      sizeBytes: artifact.sizeBytes,
      url: artifact.url,
    };
  }

  // ---- shutdown -----------------------------------------------------------

  async shutdown(): Promise<void> {
    await this.coordinator.shutdown();
    this.pages.clear();
    await this.approvalGate.shutdown();
    await this.engine.close();
  }

  // ---- internals ----------------------------------------------------------

  private requireSession(sessionId: string) {
    const session = this.coordinator.get(sessionId);
    if (!session) {
      throw new ServiceError('SESSION_NOT_FOUND', `Session ${sessionId} does not exist.`);
    }
    return session;
  }

  private requirePage(sessionId: string, pageId: string): PageContext {
    const page = this.pages.get(pageId);
    if (!page || page.sessionId !== sessionId) {
      throw new ServiceError('NOT_FOUND', `Page ${pageId} does not exist in session ${sessionId}.`);
    }
    return page;
  }

  /** Gate high-risk elements behind single-use approval tokens (ADR-007). */
  private async checkApproval(
    sessionId: string,
    page: PageContext,
    request: ServiceActRequest
  ): Promise<void> {
    const ref = request.target?.ref;
    if (ref === undefined || !page.lastObservation) {
      return;
    }

    const element = page.lastObservation.byRef.get(ref);
    const risk = element?.risk;
    if (risk === undefined || !HIGH_RISK_EFFECTS.has(risk)) {
      return;
    }

    const approvalRequest = {
      sessionId,
      action: {
        type: request.action,
        effect: risk,
        target: { ref },
        ...(request.value !== undefined ? { value: request.value } : {}),
      },
    };

    if (request.approvalToken !== undefined) {
      const valid = await this.approvalGate.validateApprovalToken(
        request.approvalToken,
        approvalRequest
      );
      if (valid) {
        await this.approvalGate.useApprovalToken(request.approvalToken);
        return;
      }
      // Invalid, expired, burned or mismatched token: fall through to a fresh
      // denial with a new token.
    }

    const token = await this.approvalGate.generateApprovalToken(approvalRequest);
    throw new ServiceError(
      'APPROVAL_REQUIRED',
      `Action targets an element classified '${risk}' and needs an approval token.`,
      false,
      { tokenId: token.tokenId, effect: risk, ref }
    );
  }

  private toProtocolAction(request: ServiceActRequest) {
    const action: Record<string, unknown> = { type: request.action };
    if (request.target !== undefined) action.target = { ref: request.target.ref };
    if (request.value !== undefined) action.value = request.value;
    if (request.key !== undefined) action.key = request.key;
    if (request.direction !== undefined) action.direction = request.direction;
    if (request.amount !== undefined) action.amount = request.amount;
    return action as unknown as Parameters<ActionExecutor['execute']>[0]['action'];
  }

  private lastObservationOf(page: PageContext): PageState {
    // The executor needs an observation for fingerprint checks; a synthetic
    // empty one is safe because untargeted actions skip those checks and
    // targeted ones were gated above (which requires a real observation).
    return (
      (page.lastObservation && {
        sessionId: '',
        pageId: '',
        revision: page.lastObservation.revision,
        url: '',
        title: '',
        status: 'interactive' as const,
        elements: Array.from(page.lastObservation.byRef.values()),
        truncated: false,
        untrustedContent: true,
      }) ?? {
        sessionId: '',
        pageId: '',
        revision: page.revision,
        url: '',
        title: '',
        status: 'interactive' as const,
        elements: [],
        truncated: false,
        untrustedContent: true,
      }
    );
  }

  private hostnameOf(url: string): string {
    try {
      return new URL(url).hostname;
    } catch {
      return '';
    }
  }

  /** Strip registered secret values from an error before it leaves the service. */
  private redactedError(error: ServiceError): ServiceError {
    return new ServiceError(
      error.code,
      this.secretManager.redact(error.message),
      error.retryable,
      error.details !== undefined ? this.secretManager.redact(error.details) : undefined
    );
  }

  private mapError(error: unknown): ServiceError {
    if (error instanceof ServiceError) {
      return this.redactedError(error);
    }
    const message = error instanceof Error ? error.message : String(error);
    const code =
      error instanceof Error && 'code' in error ? String((error as { code: string }).code) : '';

    if (code === 'QUOTA_EXCEEDED') {
      return new ServiceError('QUOTA_EXCEEDED', message);
    }
    if (message === 'SESSION_NOT_FOUND') {
      return new ServiceError('SESSION_NOT_FOUND', 'Session does not exist.');
    }
    if (code === 'POLICY_DENIED') {
      return new ServiceError(
        'POLICY_DENIED',
        message,
        false,
        (error as { details?: Record<string, unknown> }).details
      );
    }
    return new ServiceError('INTERNAL', message);
  }
}

/** Redact credentials from a URL before it enters an error payload. */
function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.origin + parsed.pathname;
  } catch {
    return '<invalid url>';
  }
}

/**
 * Projects the engine page into service space: normalized refs are translated
 * to engine refs on the way in, and action effects come back stamped with the
 * service's revision counter instead of the engine's.
 */
class RefTranslatingPage implements EnginePage {
  readonly id: string;

  constructor(
    private readonly inner: EnginePage,
    private readonly page: PageContext
  ) {
    this.id = inner.id;
  }

  async resolve(target: { ref: string }) {
    const engineRef = this.page.lastObservation?.refMap.get(target.ref);
    if (engineRef === undefined) {
      throw new Error(`Element not found: ${target.ref}`);
    }
    return this.inner.resolve({ ref: engineRef });
  }

  async act(action: { type: string; target?: { ref: string }; [key: string]: unknown }) {
    const oldRevision = this.page.revision;
    const projected = { ...action };
    if (action.target !== undefined) {
      const engineRef = this.page.lastObservation?.refMap.get(action.target.ref);
      if (engineRef !== undefined) {
        projected.target = { ref: engineRef };
      }
    }
    const effect = await this.inner.act(projected);
    const newRevision = action.type === 'navigate' ? this.page.revision : this.page.revision + 1;
    return { ...effect, oldRevision, newRevision };
  }

  async navigate(request: { url: string; waitUntil?: string }) {
    return this.inner.navigate(request as never);
  }

  async observe(request: ObservationRequest) {
    return this.inner.observe(request);
  }

  async extract(request: never) {
    return this.inner.extract(request);
  }

  async screenshot(request: ScreenshotRequest) {
    return this.inner.screenshot(request);
  }

  async *events() {
    yield* this.inner.events();
  }

  async close() {
    await this.inner.close();
  }
}

// EngineSession is referenced through the coordinator's SessionContext.
export type { EngineSession };
