import { EngineError } from '@agentbrowser/engine';

/** Trusted startup admission, separate from the request's boolean selector. */
export type CdpAttachAdmission =
  | 'allowed'
  | 'disabled'
  | 'egress'
  | 'hosted'
  | 'local_only'
  | 'auth_required';
export interface OperatorCdpAdmissionOptions {
  operatorCdp?: Readonly<{ allowUnenforcedEgress: boolean }>;
  deploymentMode?: 'local' | 'hosted';
  host?: string;
}

export function isOperatorLoopback(address: string): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

export function cdpAttachAdmission(
  options: OperatorCdpAdmissionOptions,
  tenants: Iterable<string>
): CdpAttachAdmission {
  if (
    options.deploymentMode !== undefined &&
    options.deploymentMode !== 'local' &&
    options.deploymentMode !== 'hosted'
  )
    throw new Error('Invalid deployment mode');
  const tenantCount = new Set(tenants).size;
  if (options.deploymentMode === 'hosted' || tenantCount > 1) return 'hosted';
  if (!options.operatorCdp) return 'disabled';
  if (!isOperatorLoopback(options.host ?? '127.0.0.1')) return 'local_only';
  if (options.operatorCdp.allowUnenforcedEgress !== true) return 'egress';
  if (tenantCount === 0) return 'auth_required';
  return 'allowed';
}

export function requireCdpAttachAdmission(admission: CdpAttachAdmission): void {
  if (admission === 'allowed') return;
  const refusals = {
    auth_required: [
      'CDP_ATTACH_AUTH_REQUIRED',
      'Operator attachment requires AGENTBROWSER_API_KEYS for one trust domain. Configure a strong bearer credential and send it on every request.',
    ],
    disabled: [
      'CDP_ATTACH_DISABLED',
      'Operator attachment is disabled. Start a local service with AGENTBROWSER_CDP_ENDPOINT and AGENTBROWSER_CDP_ALLOW_UNENFORCED_EGRESS=true; use a dedicated Chrome profile.',
    ],
    egress: [
      'EGRESS_UNSUPPORTED',
      'Operator attachment cannot enforce ADR-006 across the existing profile. A trusted local operator must explicitly set AGENTBROWSER_CDP_ALLOW_UNENFORCED_EGRESS=true; only initial explicit navigation URLs are checked.',
    ],
    hosted: [
      'HOSTED_UNSUPPORTED',
      'Operator attachment is unavailable in hosted or multi-tenant deployments (ADR-008). Use an isolated browser session.',
    ],
    local_only: [
      'CDP_ATTACH_LOCAL_ONLY',
      'Operator attachment requires a literal loopback API listener and local client. Use 127.0.0.1 or ::1.',
    ],
  } as const;
  const [reason, message] = refusals[admission];
  throw new EngineError('ENGINE_UNSUPPORTED', message, false, { reason });
}

/** No environment value or endpoint is ever included in a configuration error. */
export function deploymentModeFromEnvironment(env: { AGENTBROWSER_HOSTED?: string | undefined }):
  | 'local'
  | 'hosted' {
  const value = env.AGENTBROWSER_HOSTED;
  if (value === undefined || value === '' || value === 'false' || value === '0') return 'local';
  if (value === 'true' || value === '1') return 'hosted';
  throw new Error('AGENTBROWSER_HOSTED must be true, false, 1, or 0');
}
