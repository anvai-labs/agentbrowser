/**
 * Action Execution with Element References
 *
 * Executes protocol `ActionRequest`s against an engine page through stable
 * element references, with revision-based and fingerprint-based staleness
 * detection. Failures are returned as a typed error payload on the
 * `ActionResult` - the executor never throws for an expected failure mode.
 */

import type { ActionEffect, EngineAction, EnginePage, ResolvedTarget } from '@agentbrowser/engine';
import { ErrorCode, createApiErrorDetail } from '@agentbrowser/protocol';
import type {
  ActionRequest,
  ActionResult,
  ApiErrorDetail,
  ApiErrorOptions,
  ElementTarget,
  PageElement,
  PageState,
  SupportedAction,
} from '@agentbrowser/protocol';
import { ObservationNormalizer } from './observation-normalizer.js';

export interface ExecutionContext {
  enginePage: EnginePage;
  /** The observation the caller's refs were minted from. */
  observation: PageState;
  /**
   * The page's actual current revision, when the caller knows it independently
   * of `observation` (for example after an out-of-band navigation). Defaults to
   * `observation.revision`.
   */
  currentRevision?: number;
}

/** Actions the MVP executor knows how to run. */
const SUPPORTED_ACTION_TYPES = ['click', 'fill', 'select', 'scroll', 'press'] as const;

type SupportedActionType = (typeof SUPPORTED_ACTION_TYPES)[number];

const REF_PATTERN = /^e(\d+)_(\d+)$/;

/**
 * ActionExecutor handles action execution with element references
 */
export class ActionExecutor {
  private actionCounter = 0;

  constructor(private readonly normalizer: ObservationNormalizer = new ObservationNormalizer()) {}

  /**
   * Execute an action through its element reference
   */
  async execute(request: ActionRequest, context: ExecutionContext): Promise<ActionResult> {
    const { enginePage, observation, currentRevision } = context;
    const startTimestamp = new Date().toISOString();
    const revision = currentRevision ?? observation.revision;

    const validationError = this.validateAction(request.action);
    if (validationError) {
      return this.failure(validationError, startTimestamp, revision);
    }

    try {
      const target = targetOf(request.action);
      let resolvedTarget: ResolvedTarget | undefined;

      if (target) {
        resolvedTarget = await enginePage.resolve({ ref: target.ref });

        if (!resolvedTarget.visible) {
          return this.failure(
            createApiErrorDetail(
              ErrorCode.TARGET_NOT_VISIBLE,
              `Target element ${target.ref} is not visible`,
              { details: { ref: target.ref } }
            ),
            startTimestamp,
            revision
          );
        }

        if (!resolvedTarget.enabled) {
          return this.failure(
            createApiErrorDetail(
              ErrorCode.TARGET_DISABLED,
              `Target element ${target.ref} is disabled`,
              { details: { ref: target.ref } }
            ),
            startTimestamp,
            revision
          );
        }
      }

      // Staleness is checked before the action runs and is never auto-retried.
      const staleError = this.checkStaleness(request, target, revision);
      if (staleError) {
        return this.failure(staleError, startTimestamp, revision);
      }

      if (target && resolvedTarget) {
        const fingerprintError = this.verifyFingerprint(target.ref, resolvedTarget, observation);
        if (fingerprintError) {
          return this.failure(fingerprintError, startTimestamp, revision);
        }
      }

      const effect = await enginePage.act(this.buildEngineAction(request.action));

      const result: ActionResult = {
        actionId: effect.actionId,
        startTimestamp: effect.startTimestamp ?? startTimestamp,
        endTimestamp: effect.endTimestamp ?? new Date().toISOString(),
        oldRevision: effect.oldRevision ?? revision,
        newRevision: effect.newRevision ?? revision,
        result: effect.result,
      };

      if (resolvedTarget) {
        result.targetFingerprint = resolvedTarget.fingerprint;
      }

      if (request.observeAfter) {
        result.observation = await this.observeAfter(request, context, effect, result.newRevision);
      }

      return result;
    } catch (error) {
      return this.failure(this.mapEngineError(error), startTimestamp, revision);
    }
  }

  /**
   * Capture and normalize a post-action observation
   */
  private async observeAfter(
    request: ActionRequest,
    context: ExecutionContext,
    _effect: ActionEffect,
    newRevision: number
  ): Promise<PageState> {
    const raw = await context.enginePage.observe(request.observeAfter ?? {});

    return this.normalizer.normalize(raw, {
      ...request.observeAfter,
      revision: newRevision,
      sessionId: context.observation.sessionId,
      pageId: request.pageId,
    });
  }

  /**
   * Validate that an action is supported and carries its required parameters
   */
  private validateAction(action: SupportedAction): ApiErrorDetail | null {
    if (!isSupportedActionType(action.type)) {
      return invalidRequest(`Unsupported action type: ${action.type}`, {
        actionType: action.type,
      });
    }

    switch (action.type) {
      case 'fill':
        if (action.value === undefined) {
          return invalidRequest('Fill action requires a value parameter');
        }
        break;
      case 'select':
        if (!action.values || action.values.length === 0) {
          return invalidRequest('Select action requires a non-empty values parameter');
        }
        break;
      case 'press':
        if (!action.key) {
          return invalidRequest('Press action requires a key parameter');
        }
        break;
      case 'scroll':
        if (
          action.direction === undefined &&
          action.deltaX === undefined &&
          action.deltaY === undefined
        ) {
          return invalidRequest('Scroll action requires a direction or a delta');
        }
        break;
      default:
        break;
    }

    return null;
  }

  /**
   * Check for staleness from the request's expected revision and the revision
   * encoded in the element ref.
   */
  private checkStaleness(
    request: ActionRequest,
    target: ElementTarget | undefined,
    currentRevision: number
  ): ApiErrorDetail | null {
    if (request.expectedRevision !== currentRevision) {
      return staleTarget(
        `Action expected page revision ${request.expectedRevision}, but the page is at revision ${currentRevision}`,
        { expectedRevision: request.expectedRevision, currentRevision }
      );
    }

    if (!target) {
      return null;
    }

    const refMatch = REF_PATTERN.exec(target.ref);
    if (!refMatch?.[1]) {
      return invalidRequest(`Invalid element reference format: ${target.ref}`, {
        ref: target.ref,
      });
    }

    const refRevision = Number.parseInt(refMatch[1], 10);
    if (refRevision !== currentRevision) {
      return staleTarget(
        `Element reference ${target.ref} belongs to revision ${refRevision}, but the page is at revision ${currentRevision}`,
        { ref: target.ref, refRevision, currentRevision }
      );
    }

    return null;
  }

  /**
   * Verify the resolved element still matches what the caller observed
   */
  private verifyFingerprint(
    ref: string,
    resolvedTarget: ResolvedTarget,
    observation: PageState
  ): ApiErrorDetail | null {
    const observedElement = observation.elements.find((el) => el.ref === ref);

    // Not in the observation: nothing to compare against, revision checks stand.
    if (!observedElement) {
      return null;
    }

    const expectedFingerprint = fingerprintOf(observedElement);

    if (resolvedTarget.fingerprint !== expectedFingerprint) {
      return staleTarget(
        `Element fingerprint mismatch for ${ref}. Expected '${expectedFingerprint}', got '${resolvedTarget.fingerprint}'. The element has changed.`,
        { ref, expectedFingerprint, actualFingerprint: resolvedTarget.fingerprint }
      );
    }

    return null;
  }

  /**
   * Translate a protocol action into the engine-neutral action shape
   */
  private buildEngineAction(action: SupportedAction): EngineAction {
    const { type, ...params } = action as SupportedAction & Record<string, unknown>;
    return { type, ...params };
  }

  /**
   * Map an engine exception onto the protocol error taxonomy
   */
  private mapEngineError(error: unknown): ApiErrorDetail {
    const message = error instanceof Error ? error.message : 'Unknown engine error';

    if (/not found/i.test(message)) {
      return createApiErrorDetail(
        ErrorCode.TARGET_NOT_FOUND,
        `Target element not found: ${message}`
      );
    }

    if (/multiple elements|ambiguous/i.test(message)) {
      return createApiErrorDetail(ErrorCode.TARGET_AMBIGUOUS, `Target is ambiguous: ${message}`);
    }

    if (/stale|fingerprint/i.test(message)) {
      return staleTarget(`Target is stale: ${message}`);
    }

    if (/timeout|timed out/i.test(message)) {
      return createApiErrorDetail(ErrorCode.ACTION_TIMEOUT, message, { retryable: true });
    }

    return createApiErrorDetail(ErrorCode.INTERNAL, message);
  }

  /**
   * Build a protocol-shaped result for a failed action. A failed action is
   * still an action: it keeps an id, timestamps and revisions so it can be
   * traced, and leaves the revision unchanged.
   */
  private failure(error: ApiErrorDetail, startTimestamp: string, revision: number): ActionResult {
    return {
      actionId: `act_${++this.actionCounter}`,
      startTimestamp,
      endTimestamp: new Date().toISOString(),
      oldRevision: revision,
      newRevision: revision,
      result: null,
      error,
    };
  }
}

/**
 * Extract the element target of an action, if it has one
 */
function targetOf(action: SupportedAction): ElementTarget | undefined {
  return 'target' in action ? action.target : undefined;
}

function isSupportedActionType(type: string): type is SupportedActionType {
  return (SUPPORTED_ACTION_TYPES as readonly string[]).includes(type);
}

/**
 * Semantic fingerprint of an observed element
 */
function fingerprintOf(element: PageElement): string {
  const parts = [
    element.role,
    element.name || '',
    `visible_${element.visible}`,
    `enabled_${element.enabled}`,
    element.value !== undefined ? `value_${element.value}` : '',
  ];
  return parts.filter(Boolean).join('_');
}

function invalidRequest(message: string, details?: Record<string, unknown>): ApiErrorDetail {
  const options: ApiErrorOptions = { retryable: false };
  if (details) {
    options.details = details;
  }
  return createApiErrorDetail(ErrorCode.INVALID_REQUEST, message, options);
}

function staleTarget(message: string, details?: Record<string, unknown>): ApiErrorDetail {
  const options: ApiErrorOptions = { retryable: true, action: 'observe_and_retry' };
  if (details) {
    options.details = details;
  }
  return createApiErrorDetail(ErrorCode.STALE_TARGET, message, options);
}
