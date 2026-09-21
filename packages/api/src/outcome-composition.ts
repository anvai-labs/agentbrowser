/**
 * Blessed deployment composition for outcome verification over the
 * application surface (T2): one helper that assembles the three
 * ServerOptions fields a deployment must otherwise wire by hand, and the
 * one path future deployments should copy. The only worked example used to
 * live in a test fixture (scripts/cli-outcome-child.mjs).
 *
 * Single-verifier scope, deliberately: the receipt evidence source derives
 * its descriptor from ONE verifier's descriptor, so source/capability
 * identity exists exactly once per deployment (in the verifier definition).
 */

import {
  type ApplicationAdapter,
  type ApplicationReceiptAuthorizationRequest,
  type EvidencePermission,
  TrustedEvidenceSourceRegistry,
  type TrustedVerifierRegistry,
} from '@agentbrowser/control';
import type { ServerOptions } from './server.js';
import type { ServiceEvidenceSourceBuilder, ServiceOutcomeEvidenceContext } from './service.js';

export interface ApplicationReceiptComposition {
  /** Application adapters the deployment owns; operators bind them to sessions. */
  adapters: readonly ApplicationAdapter[];
  /** The deployment's trusted verifier definitions. */
  verifierRegistry: TrustedVerifierRegistry;
  /**
   * The verifier that owns the receipt claim. Its descriptor's
   * `evidenceSource` and `requiredCapability` name the receipt source, so
   * the identifiers cannot disagree between verifier and source.
   */
  verifier: { id: string; version: string };
  /**
   * Deployment policy over each authorized receipt read. Receives
   * authority-owned identity (never a capability or host context); return
   * a permission generation fence, or undefined to deny.
   */
  authorize: (request: ApplicationReceiptAuthorizationRequest) => EvidencePermission | undefined;
  /** Opaque per-receipt evidence references (optional). */
  evidenceRefs?: (receipt: unknown) => readonly string[];
}

/** Must stay synchronous: the service rejects async evidence providers. */
export function applicationReceiptOutcomeOptions(
  composition: ApplicationReceiptComposition
): Pick<
  ServerOptions,
  'applicationAdapters' | 'verifierRegistry' | 'evidenceSourceRegistryProvider'
> {
  const { adapters, verifierRegistry, verifier, authorize, evidenceRefs } = composition;
  const descriptor = verifierRegistry.describe(verifier.id, verifier.version);
  return {
    applicationAdapters: [...adapters],
    verifierRegistry,
    evidenceSourceRegistryProvider: (
      sources: ServiceEvidenceSourceBuilder
    ): TrustedEvidenceSourceRegistry<ServiceOutcomeEvidenceContext> =>
      new TrustedEvidenceSourceRegistry([
        sources.applicationReceipt({
          descriptor: { id: descriptor.evidenceSource, capability: descriptor.requiredCapability },
          authorize,
          ...(evidenceRefs !== undefined ? { evidenceRefs } : {}),
        }),
      ]),
  };
}
