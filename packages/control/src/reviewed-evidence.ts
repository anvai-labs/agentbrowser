import type {
  ApprovalActionRequest,
  ApprovalGate,
  ApprovalReviewBinding,
} from '@agentbrowser/core';
import { canonicalJson } from '@agentbrowser/core';
import { type OperatorApprovalView, parseOperatorApprovalView } from '@agentbrowser/protocol';
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
  readonly source: Readonly<{
    ownerId: string;
    contract: Readonly<{ id: string; version: string }>;
  }>;
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
    keys.some((key) => !own[key] || !Object.hasOwn(own[key], 'value'))
  )
    throw unavailable();
  return Object.fromEntries(keys.map((key) => [key, own[key]?.value]));
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
    const source = options.source;
    const assertAuthorityCallback = options.assertAuthority;
    const assertDisclosureSafeCallback = options.assertDisclosureSafe;
    const trackReadCallback = options.trackRead;
    const lifecycleSignal = options.lifecycleSignal;
    const generateReviewedApproval = gate.generateReviewedApproval;
    const getReviewedApproval = gate.getReviewedApproval;
    const decideReviewedApproval = gate.decideReviewedApproval;
    const consumeReviewedApproval = gate.consumeReviewedApproval;

    const sourceOwn = dataProperties(source, [
      'ownerId',
      'contract',
      'permission',
      'assertAuthorized',
      'collect',
    ]);
    const contractOwn = dataProperties(sourceOwn.contract, ['id', 'version']);
    const assertSourceCallback = sourceOwn.assertAuthorized;
    const collectCallback = sourceOwn.collect;
    if (
      !gate ||
      typeof generateReviewedApproval !== 'function' ||
      typeof getReviewedApproval !== 'function' ||
      typeof decideReviewedApproval !== 'function' ||
      typeof consumeReviewedApproval !== 'function' ||
      typeof assertAuthorityCallback !== 'function' ||
      typeof assertDisclosureSafeCallback !== 'function' ||
      typeof trackReadCallback !== 'function' ||
      typeof assertSourceCallback !== 'function' ||
      typeof collectCallback !== 'function' ||
      typeof sourceOwn.ownerId !== 'string' ||
      !/^[!-~]{1,255}$/.test(sourceOwn.ownerId) ||
      typeof pageId !== 'string' ||
      pageId.length < 1 ||
      pageId.length > 255 ||
      typeof contractOwn.id !== 'string' ||
      !IDENTIFIER.test(contractOwn.id) ||
      typeof contractOwn.version !== 'string' ||
      !IDENTIFIER.test(contractOwn.version) ||
      (lifecycleSignal !== undefined && !(lifecycleSignal instanceof AbortSignal))
    )
      throw unavailable();

    const context = snapshot(contextInput);
    const action = snapshot(actionInput);
    if (!action || typeof action !== 'object' || Array.isArray(action)) throw unavailable();
    const contract = snapshot({ id: contractOwn.id, version: contractOwn.version });
    const permission = prepareEvidencePermission(sourceOwn.permission);
    const sourceBinding = snapshot({
      ownerId: sourceOwn.ownerId,
      contract,
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
