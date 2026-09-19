import type {
  ApplicationAuthority,
  PreparedApplicationReceiptReader,
} from './application-authority.js';
import {
  type EvidenceAuthorizationRequest,
  type EvidencePermission,
  type EvidenceRead,
  type TrustedEvidenceSourceDefinition,
  type TrustedEvidenceSourceDescriptor,
  defineEvidenceSource,
} from './outcome-runner.js';
import { evidencePermissionGuard, synchronousResult } from './trusted-callback.js';

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

type AuthorizedReceiptRead = (signal: AbortSignal) => Promise<EvidenceRead<unknown>>;

/** Compose scoped observation inside the caller's existing admission; never dispatch a write. */
export function defineApplicationReceiptEvidenceSource<
  Context extends { readonly sessionId: string },
>(
  application: ApplicationAuthority,
  options: ApplicationReceiptEvidenceSourceOptions
): TrustedEvidenceSourceDefinition<Context, unknown, AuthorizedReceiptRead> {
  const { authorize, evidenceRefs } = options;
  const prepareReceipt = application.prepareReceiptReadInScope.bind(application);
  if (
    typeof authorize !== 'function' ||
    (evidenceRefs !== undefined && typeof evidenceRefs !== 'function')
  )
    throw new Error('Invalid application evidence source');
  return defineEvidenceSource<Context, unknown, AuthorizedReceiptRead>({
    descriptor: { ...options.descriptor, authorization: 'required', correlation: 'required' },
    authorize(request) {
      const sessionId = request.context.sessionId;
      const correlationId = request.correlationId;
      if (correlationId === undefined) throw new Error('Application evidence correlation required');
      const reader = prepareReceipt(sessionId);
      if (reader.identity.sessionId !== sessionId)
        throw new Error('Application evidence identity mismatch');
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
