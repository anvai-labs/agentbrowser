import type { ActionRiskPolicyOptions } from '@agentbrowser/core';
import type { Authorizer } from '@agentbrowser/policy-engine';
import type { PolicyDocument, PolicyLimits } from '@agentbrowser/protocol';

/** A loaded policy file, or the shadow wrapper, as the entrypoint holds it. */
export type EntrypointPolicy =
  | {
      kind: 'file';
      authorizer: Authorizer;
      document: PolicyDocument;
      limits: PolicyLimits;
    }
  | {
      kind: 'shadow';
      authorizer: Authorizer;
      version: string;
      limits: Record<string, never>;
    };

/**
 * The `policy` option buildServer receives. A file also hands over its approval rules: they
 * classify each action before the authorizer decides, and nothing else carries them in file
 * mode (the environment approval policy is refused alongside a file).
 */
export function serverPolicyOption(policy: EntrypointPolicy): {
  kind: 'file' | 'shadow';
  authorizer: Authorizer;
  version: string;
  limits: PolicyLimits;
  approval?: ActionRiskPolicyOptions;
} {
  return {
    kind: policy.kind,
    authorizer: policy.authorizer,
    version: policy.authorizer.version,
    limits: policy.limits,
    ...(policy.kind === 'file'
      ? {
          approval: {
            rules: policy.document.approvalRules,
            unknownRisk: policy.document.unknownRisk,
          },
        }
      : {}),
  };
}
