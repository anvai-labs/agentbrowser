import {
  CONTROL_OPERATION_ID,
  EvidenceReferenceIdsSchema,
  parseExecutionReport,
} from '@agentbrowser/protocol';
import type {
  ApplicationAuthority,
  PreparedApplicationRead,
  PreparedApplicationReceiptReader,
} from './application-authority.js';
import { canonicalJson } from './canonical-json.js';
import {
  type EvidenceAuthorizationRequest,
  type EvidencePermission,
  type EvidenceRead,
  type TrustedEvidenceSourceDefinition,
  type TrustedEvidenceSourceDescriptor,
  defineEvidenceSource,
} from './outcome-runner.js';
import {
  evidencePermissionGuard,
  snapshotAuthorizationInput,
  synchronousResult,
} from './trusted-callback.js';

/** Policy receives authority-owned identity, never a receipt capability or host context. */
export interface ApplicationReceiptAuthorizationRequest {
  readonly source: TrustedEvidenceSourceDescriptor;
  readonly verifier: EvidenceAuthorizationRequest<unknown>['verifier'];
  readonly correlationId: string;
  readonly identity: PreparedApplicationReceiptReader['identity'];
}

export interface ApplicationReceiptEvidenceSourceOptions {
  readonly descriptor: Pick<TrustedEvidenceSourceDescriptor, 'id' | 'capability'>;
  authorize(request: ApplicationReceiptAuthorizationRequest): EvidencePermission | undefined;
  /** Return opaque references only; the verifier owns validation of receipt data. */
  evidenceRefs?(receipt: unknown): readonly string[];
}

export interface ApplicationReadAuthorizationRequest
  extends Omit<ApplicationReceiptAuthorizationRequest, 'identity'> {
  readonly identity: PreparedApplicationRead['identity'];
}

export interface ApplicationReadEvidenceSourceOptions {
  readonly descriptor: Pick<TrustedEvidenceSourceDescriptor, 'id' | 'capability'>;
  /** Trusted configured read, captured once; never selected from mutable execution context. */
  readonly request: { readonly operation: string; readonly input: unknown };
  authorize(request: ApplicationReadAuthorizationRequest): EvidencePermission | undefined;
  /** Receives frozen detached JSON; references are detached before publication. */
  evidenceRefs?(value: unknown): readonly string[];
}

/** Shared policy fence, retaining receipt-specific I/O semantics in its existing adapter. */
function applicationEvidenceAccess<Identity extends PreparedApplicationReceiptReader['identity']>(
  reader: { readonly identity: Identity; assertAuthority(): void },
  request: EvidenceAuthorizationRequest<unknown>,
  correlationId: string,
  authorize: (
    request: ApplicationReceiptAuthorizationRequest & { readonly identity: Identity }
  ) => EvidencePermission | undefined
): () => number {
  const policyRequest = Object.freeze({
    source: request.source,
    verifier: request.verifier,
    correlationId,
    identity: reader.identity,
  });
  const assertPermission = evidencePermissionGuard(synchronousResult(authorize(policyRequest)));
  const assertAccess = () => {
    reader.assertAuthority();
    assertPermission();
    reader.assertAuthority();
    return 0;
  };
  assertAccess();
  return assertAccess;
}

type AuthorizedApplicationEvidenceRead = (signal: AbortSignal) => Promise<EvidenceRead<unknown>>;

/** Compose scoped observation inside the caller's existing admission; never dispatch a write. */
export function defineApplicationReceiptEvidenceSource<
  Context extends { readonly sessionId: string },
>(
  application: ApplicationAuthority,
  options: ApplicationReceiptEvidenceSourceOptions
): TrustedEvidenceSourceDefinition<Context, unknown, AuthorizedApplicationEvidenceRead> {
  const { authorize, evidenceRefs } = options;
  const prepareReceipt = application.prepareReceiptReadInScope.bind(application);
  if (
    typeof authorize !== 'function' ||
    (evidenceRefs !== undefined && typeof evidenceRefs !== 'function')
  )
    throw new Error('Invalid application evidence source');
  return defineEvidenceSource<Context, unknown, AuthorizedApplicationEvidenceRead>({
    descriptor: { ...options.descriptor, authorization: 'required', correlation: 'required' },
    authorize(request) {
      const sessionId = request.context.sessionId;
      const correlationId = request.correlationId;
      if (correlationId === undefined) throw new Error('Application evidence correlation required');
      const reader = prepareReceipt(sessionId);
      if (reader.identity.sessionId !== sessionId)
        throw new Error('Application evidence identity mismatch');
      const assertAccess = applicationEvidenceAccess(reader, request, correlationId, authorize);
      return {
        kind: 'authorized_access_v1',
        permission: { generation: 0, currentGeneration: assertAccess },
        access: async (signal: AbortSignal) => {
          assertAccess();
          const receipt = await reader.read(correlationId, signal);
          assertAccess();
          if (receipt === undefined) return { status: 'pending' };
          const evidenceRefIds = evidenceRefs ? synchronousResult(evidenceRefs(receipt)) : [];
          assertAccess();
          return { status: 'ready', evidence: receipt, evidenceRefIds };
        },
      };
    },
    async read(_context, signal, _correlationId, access) {
      if (!access) throw new Error('Application evidence access unavailable');
      return access(signal);
    },
  });
}

/** Authorized bounded application data; not a completeness or submission witness by itself. */
export function defineApplicationReadEvidenceSource<Context extends { readonly sessionId: string }>(
  application: ApplicationAuthority,
  options: ApplicationReadEvidenceSourceOptions
): TrustedEvidenceSourceDefinition<Context, unknown, AuthorizedApplicationEvidenceRead> {
  try {
    const prepareRead = application.prepareReadInScope.bind(application);
    const { authorize, evidenceRefs } = options;
    if (
      typeof authorize !== 'function' ||
      (evidenceRefs !== undefined && typeof evidenceRefs !== 'function')
    )
      throw new Error();
    // Strict descriptors are checked before the shared finite/encoded-size serializer.
    // Keep only a private immutable string; a fresh request is supplied to each reader.
    const serialized = canonicalJson(snapshotAuthorizationInput(options.request));
    const configured: unknown = JSON.parse(serialized);
    if (
      !configured ||
      typeof configured !== 'object' ||
      Array.isArray(configured) ||
      Object.keys(configured).length !== 2 ||
      !Object.hasOwn(configured, 'operation') ||
      !Object.hasOwn(configured, 'input') ||
      typeof (configured as { operation: unknown }).operation !== 'string' ||
      !CONTROL_OPERATION_ID.test((configured as { operation: string }).operation)
    )
      throw new Error();
    return defineEvidenceSource<Context, unknown, AuthorizedApplicationEvidenceRead>({
      descriptor: { ...options.descriptor, authorization: 'required', correlation: 'required' },
      authorize(request) {
        try {
          const sessionId = request.context.sessionId;
          const correlationId = request.correlationId;
          if (typeof sessionId !== 'string' || correlationId === undefined) throw new Error();
          const reader = prepareRead(sessionId, JSON.parse(serialized));
          if (reader.identity.sessionId !== sessionId) throw new Error();
          const assertAccess = applicationEvidenceAccess(reader, request, correlationId, authorize);
          return {
            kind: 'authorized_access_v1',
            permission: { generation: 0, currentGeneration: assertAccess },
            access: async (signal: AbortSignal) => {
              const check = () => {
                if (signal.aborted) throw new Error();
                assertAccess();
                if (signal.aborted) throw new Error();
              };
              try {
                check();
                const value = await reader.read(signal);
                check();
                // Reference callbacks can inspect this value, but cannot rewrite evidence.
                const evidence = snapshotAuthorizationInput(value);
                check();
                const refs = evidenceRefs ? synchronousResult(evidenceRefs(evidence)) : [];
                check();
                const stableRefs = snapshotAuthorizationInput(refs);
                check();
                const validatedRefs = Object.freeze(
                  parseExecutionReport(
                    EvidenceReferenceIdsSchema,
                    stableRefs,
                    'evidence references'
                  )
                );
                check();
                return {
                  status: 'ready',
                  evidence,
                  evidenceRefIds: validatedRefs,
                };
              } catch {
                // A failed callback/inspection may also revoke access; record that
                // observation before replacing its private exception with a static error.
                try {
                  check();
                } catch {
                  /* Permission and reader guards retain revocation. */
                }
                throw new Error('Application read evidence unavailable');
              }
            },
          };
        } catch {
          throw new Error('Evidence authorization unavailable');
        }
      },
      async read(_context, signal, _correlationId, access) {
        if (!access) throw new Error('Application read evidence unavailable');
        return access(signal);
      },
    });
  } catch {
    throw new Error('Invalid application read evidence source');
  }
}
