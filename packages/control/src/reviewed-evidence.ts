import type {
  ApprovalActionRequest,
  ApprovalGate,
  ApprovalReviewBinding,
} from '@agentbrowser/core';
import { canonicalJson } from '@agentbrowser/core';
import {
  CONTROL_OPERATION_ID,
  type OperatorApprovalView,
  parseOperatorApprovalView,
} from '@agentbrowser/protocol';
import type { EvidencePermission } from './outcome-runner.js';
import {
  prepareEvidencePermission,
  snapshotAuthorizationInput,
  synchronousResult,
} from './trusted-callback.js';

export const NATIVE_FORM_REVIEW_TYPE = 'agentbrowser.native-form-review.v1';

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const UNAVAILABLE = 'Evidence review unavailable';

export interface EvidenceReviewSource {
  /** Stable unique ID for this permission-owner incarnation; changes on owner replacement. */
  readonly ownerId: string;
  readonly contract: Readonly<{ id: string; version: string }>;
  readonly permission: EvidencePermission;
  assertAuthorized(): void;
  collect(signal: AbortSignal): unknown | Promise<unknown>;
}

export interface PreparedEvidenceReview {
  /** Recheck the captured owner after consumption, inside the original admission only. */
  assertCurrent(signal: AbortSignal): void;
  generate(signal: AbortSignal): Promise<OperatorApprovalView>;
  get(tokenId: string, signal: AbortSignal): Promise<OperatorApprovalView | undefined>;
  decide(
    tokenId: string,
    decision: 'approve' | 'deny',
    signal: AbortSignal
  ): Promise<OperatorApprovalView | undefined>;
  consume(tokenId: string, signal: AbortSignal): Promise<boolean>;
}

/** Public-safe selector for resolving a stored native-form review through trusted config. */
export interface EvidenceReviewSelector {
  readonly pageId: string;
  readonly application?: ApplicationReviewSelector;
  readonly source: Readonly<{
    ownerId: string;
    contract: Readonly<{ id: string; version: string }>;
  }>;
}

export interface ApplicationReviewSelector {
  readonly adapter: string;
  readonly resource: string;
  readonly bindingGeneration: string;
  readonly operation: string;
  readonly operationId: string;
  readonly expectedVersion: number;
}

export interface PrepareEvidenceReviewOptions {
  readonly gate: ApprovalGate;
  readonly context: ApprovalReviewBinding;
  readonly pageId: string;
  readonly action: Record<string, unknown>;
  readonly source: EvidenceReviewSource;
  assertAuthority(): void;
  assertDisclosureSafe(value: unknown): void;
  trackRead<T>(read: () => Promise<T>): Promise<T>;
  readonly lifecycleSignal?: AbortSignal;
}

function unavailable(): Error {
  return new Error(UNAVAILABLE);
}

function snapshot<T>(value: T): T {
  const detached = snapshotAuthorizationInput(value);
  canonicalJson(detached);
  return detached as T;
}

function dataProperties(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw unavailable();
  const own = Object.getOwnPropertyDescriptors(value);
  if (
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(own).some((key) => typeof key !== 'string' || !keys.includes(key)) ||
    keys.some((key) => !own[key]?.enumerable || !Object.hasOwn(own[key], 'value'))
  )
    throw unavailable();
  return Object.fromEntries(keys.map((key) => [key, own[key]?.value]));
}

/** Reserved application actions must be complete; they never fall back to generic routing. */
export function selectApplicationReview(value: unknown): ApplicationReviewSelector | undefined {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const type = Object.getOwnPropertyDescriptor(value, 'type');
    if (type && !Object.hasOwn(type, 'value')) throw unavailable();
    if (type?.value !== 'application-submit') return undefined;
    const action = dataProperties(snapshot(value), [
      'type',
      'intent',
      'tenant',
      'sessionId',
      'sessionIncarnation',
      'adapter',
      'resource',
      'bindingGeneration',
      'operation',
      'operationId',
      'expectedVersion',
      'input',
    ]);
    if (
      action.type !== 'application-submit' ||
      action.intent !== 'submit' ||
      !['adapter', 'resource', 'operation', 'operationId'].every(
        (key) => typeof action[key] === 'string' && CONTROL_OPERATION_ID.test(action[key])
      ) ||
      !['tenant', 'sessionId', 'sessionIncarnation', 'bindingGeneration'].every(
        (key) =>
          typeof action[key] === 'string' && action[key].length > 0 && action[key].length <= 255
      ) ||
      typeof action.expectedVersion !== 'number' ||
      !Number.isSafeInteger(action.expectedVersion) ||
      action.expectedVersion < 0
    )
      throw unavailable();
    return snapshot({
      adapter: action.adapter,
      resource: action.resource,
      bindingGeneration: action.bindingGeneration,
      operation: action.operation,
      operationId: action.operationId,
      expectedVersion: action.expectedVersion,
    }) as ApplicationReviewSelector;
  } catch {
    throw unavailable();
  }
}

/** Capture the original source once; wrappers retain callback receivers and sticky permission. */
export function captureEvidenceReviewSource(value: unknown): EvidenceReviewSource {
  try {
    const own = dataProperties(value, [
      'ownerId',
      'contract',
      'permission',
      'assertAuthorized',
      'collect',
    ]);
    const contract = dataProperties(own.contract, ['id', 'version']);
    const authorize = own.assertAuthorized;
    const collect = own.collect;
    if (
      typeof own.ownerId !== 'string' ||
      !/^[!-~]{1,255}$/.test(own.ownerId) ||
      typeof contract.id !== 'string' ||
      !IDENTIFIER.test(contract.id) ||
      typeof contract.version !== 'string' ||
      !IDENTIFIER.test(contract.version) ||
      typeof authorize !== 'function' ||
      typeof collect !== 'function'
    )
      throw unavailable();
    const capturedContract = snapshot({ id: contract.id, version: contract.version });
    const permission = prepareEvidencePermission(own.permission);
    return Object.freeze({
      ownerId: own.ownerId,
      contract: capturedContract,
      permission: Object.freeze({
        generation: permission.generation,
        currentGeneration() {
          permission.assertAuthorized();
          return permission.generation;
        },
      }),
      assertAuthorized: () => Reflect.apply(authorize, value, []),
      collect: (signal: AbortSignal) => Reflect.apply(collect, value, [signal]),
    });
  } catch {
    throw unavailable();
  }
}

/** Extract only non-private routing identity from a reserved reviewed action. */
export function selectEvidenceReview(value: unknown): EvidenceReviewSelector | undefined {
  try {
    const action = dataProperties(value, ['type', 'pageId', 'parameters']);
    if (
      action.type !== NATIVE_FORM_REVIEW_TYPE ||
      typeof action.pageId !== 'string' ||
      action.pageId.length < 1 ||
      action.pageId.length > 255
    )
      return undefined;
    const parameters = dataProperties(action.parameters, ['action', 'source', 'witness']);
    const application = selectApplicationReview(parameters.action);
    const source = dataProperties(parameters.source, [
      'ownerId',
      'contract',
      'permissionGeneration',
    ]);
    const contract = dataProperties(source.contract, ['id', 'version']);
    if (
      typeof source.ownerId !== 'string' ||
      !/^[!-~]{1,255}$/.test(source.ownerId) ||
      typeof source.permissionGeneration !== 'number' ||
      !Number.isSafeInteger(source.permissionGeneration) ||
      source.permissionGeneration < 0 ||
      typeof contract.id !== 'string' ||
      !IDENTIFIER.test(contract.id) ||
      typeof contract.version !== 'string' ||
      !IDENTIFIER.test(contract.version)
    )
      return undefined;
    return snapshot({
      pageId: action.pageId,
      ...(application ? { application } : {}),
      source: {
        ownerId: source.ownerId,
        contract: { id: contract.id, version: contract.version },
      },
    });
  } catch {
    return undefined;
  }
}

/**
 * Compose one admission-owned evidence review through ApprovalGate's existing
 * reviewed-token store. This helper owns no token state and dispatches no action.
 */
export function prepareEvidenceReview(
  options: PrepareEvidenceReviewOptions
): PreparedEvidenceReview {
  try {
    // Capture every mutable composition reference before the permission callback runs.
    const gate = options.gate;
    const contextInput = options.context;
    const pageId = options.pageId;
    const actionInput = options.action;
    const sourceInput = options.source;
    const assertAuthorityCallback = options.assertAuthority;
    const assertDisclosureSafeCallback = options.assertDisclosureSafe;
    const trackReadCallback = options.trackRead;
    const lifecycleSignal = options.lifecycleSignal;
    const generateReviewedApproval = gate.generateReviewedApproval;
    const getReviewedApproval = gate.getReviewedApproval;
    const decideReviewedApproval = gate.decideReviewedApproval;
    const consumeReviewedApproval = gate.consumeReviewedApproval;

    if (
      !gate ||
      typeof generateReviewedApproval !== 'function' ||
      typeof getReviewedApproval !== 'function' ||
      typeof decideReviewedApproval !== 'function' ||
      typeof consumeReviewedApproval !== 'function' ||
      typeof assertAuthorityCallback !== 'function' ||
      typeof assertDisclosureSafeCallback !== 'function' ||
      typeof trackReadCallback !== 'function' ||
      typeof pageId !== 'string' ||
      pageId.length < 1 ||
      pageId.length > 255 ||
      (lifecycleSignal !== undefined && !(lifecycleSignal instanceof AbortSignal))
    )
      throw unavailable();

    const context = snapshot(contextInput);
    const action = snapshot(actionInput);
    if (!action || typeof action !== 'object' || Array.isArray(action)) throw unavailable();
    const source = captureEvidenceReviewSource(sourceInput);
    const assertSourceCallback = source.assertAuthorized;
    const collectCallback = source.collect;
    const permission = prepareEvidencePermission(source.permission);
    const sourceBinding = snapshot({
      ownerId: source.ownerId,
      contract: source.contract,
      permissionGeneration: permission.generation,
    });
    const actionFingerprint = canonicalJson(action);
    const sourceFingerprint = canonicalJson(sourceBinding);

    const invokeSync = (callback: unknown, receiver: unknown, args: readonly unknown[] = []) => {
      if (typeof callback !== 'function') throw unavailable();
      return synchronousResult(Reflect.apply(callback, receiver, args));
    };
    const combinedSignal = (signal: AbortSignal): AbortSignal => {
      if (!(signal instanceof AbortSignal)) throw unavailable();
      return lifecycleSignal ? AbortSignal.any([signal, lifecycleSignal]) : signal;
    };
    let ownerRevoked = false;
    const assertOwner = (): void => {
      if (ownerRevoked) throw unavailable();
      try {
        invokeSync(assertAuthorityCallback, options);
        invokeSync(assertSourceCallback, source);
        permission.assertAuthorized();
        invokeSync(assertSourceCallback, source);
        invokeSync(assertAuthorityCallback, options);
        // Either callback may revoke the generation after its earlier check.
        permission.assertAuthorized();
      } catch {
        ownerRevoked = true;
        throw unavailable();
      }
    };
    const guard = (signal?: AbortSignal): void => {
      if (signal?.aborted) throw unavailable();
      assertOwner();
      if (signal?.aborted) throw unavailable();
    };
    const fail = (): never => {
      try {
        assertOwner();
      } catch {
        // The owner failure is latched; diagnostics remain static.
      }
      throw unavailable();
    };
    const disclose = (reviewAction: unknown, signal: AbortSignal): void => {
      guard(signal);
      invokeSync(assertDisclosureSafeCallback, options, [reviewAction]);
      guard(signal);
    };
    const reviewAction = (witness: unknown): ApprovalActionRequest =>
      snapshot({
        type: NATIVE_FORM_REVIEW_TYPE,
        pageId,
        parameters: { action, source: sourceBinding, witness },
      });
    const reviewedRequest = (witness: unknown) =>
      snapshot({
        request: { sessionId: context.sessionId, action: reviewAction(witness) },
        context,
      });

    const validateView = (value: unknown): OperatorApprovalView | undefined => {
      try {
        const view = parseOperatorApprovalView(value);
        const candidate = dataProperties(view.action, ['type', 'pageId', 'parameters']);
        if (candidate.type !== NATIVE_FORM_REVIEW_TYPE || candidate.pageId !== pageId)
          return undefined;
        const parameters = dataProperties(candidate.parameters, ['action', 'source', 'witness']);
        if (
          canonicalJson(parameters.action) !== actionFingerprint ||
          canonicalJson(parameters.source) !== sourceFingerprint
        )
          return undefined;
        return view;
      } catch {
        return undefined;
      }
    };

    const collect = async (signal: AbortSignal): Promise<unknown> => {
      const activeSignal = combinedSignal(signal);
      guard(activeSignal);
      const value = await Reflect.apply(trackReadCallback, options, [
        async () => {
          guard(activeSignal);
          const collected = await Reflect.apply(collectCallback, source, [activeSignal]);
          guard(activeSignal);
          const witness = snapshot(collected);
          if (
            !witness ||
            typeof witness !== 'object' ||
            Array.isArray(witness) ||
            Object.getPrototypeOf(witness) !== Object.prototype
          )
            throw unavailable();
          guard(activeSignal);
          return witness;
        },
      ]);
      guard(activeSignal);
      return value;
    };

    const prepared: PreparedEvidenceReview = {
      assertCurrent(signal) {
        guard(combinedSignal(signal));
      },
      async generate(signal) {
        try {
          const activeSignal = combinedSignal(signal);
          const bound = reviewedRequest(await collect(activeSignal));
          disclose(bound.request.action, activeSignal);
          const generated = await Reflect.apply(generateReviewedApproval, gate, [
            bound.request,
            bound.context,
          ]);
          guard(activeSignal);
          const view = validateView(generated);
          if (!view) throw unavailable();
          disclose(view.action, activeSignal);
          return view;
        } catch {
          return fail();
        }
      },
      async get(tokenId, signal) {
        try {
          const activeSignal = combinedSignal(signal);
          guard(activeSignal);
          if (typeof tokenId !== 'string' || tokenId.length < 1 || tokenId.length > 128)
            return undefined;
          const current = await Reflect.apply(getReviewedApproval, gate, [tokenId, context]);
          guard(activeSignal);
          if (current === undefined) return undefined;
          const view = validateView(current);
          if (!view) return undefined;
          disclose(view.action, activeSignal);
          return view;
        } catch {
          return fail();
        }
      },
      async decide(tokenId, decision, signal) {
        try {
          const activeSignal = combinedSignal(signal);
          guard(activeSignal);
          if (
            typeof tokenId !== 'string' ||
            tokenId.length < 1 ||
            tokenId.length > 128 ||
            (decision !== 'approve' && decision !== 'deny')
          )
            return undefined;
          const current = await Reflect.apply(getReviewedApproval, gate, [tokenId, context]);
          guard(activeSignal);
          if (!validateView(current)) return undefined;
          disclose((current as OperatorApprovalView).action, activeSignal);
          const decided = await Reflect.apply(decideReviewedApproval, gate, [
            tokenId,
            context,
            decision,
          ]);
          guard(activeSignal);
          if (decided === undefined) return undefined;
          const view = validateView(decided);
          if (!view) return undefined;
          disclose(view.action, activeSignal);
          return view;
        } catch {
          return fail();
        }
      },
      async consume(tokenId, signal) {
        try {
          const activeSignal = combinedSignal(signal);
          guard(activeSignal);
          if (typeof tokenId !== 'string' || tokenId.length < 1 || tokenId.length > 128)
            return false;
          const bound = reviewedRequest(await collect(activeSignal));
          disclose(bound.request.action, activeSignal);
          const consumed = await Reflect.apply(consumeReviewedApproval, gate, [
            tokenId,
            bound.request,
            bound.context,
          ]);
          guard(activeSignal);
          return consumed === true;
        } catch {
          return fail();
        }
      },
    };
    guard(lifecycleSignal);
    return Object.freeze(prepared);
  } catch {
    throw unavailable();
  }
}
