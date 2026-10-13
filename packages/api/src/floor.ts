/**
 * The floor (ADR-024 §1, TD-BROWSER-15): refusals no policy can grant, in one
 * place. Each carries a `floor.*` rule id so an agent can tell a fixed refusal
 * from an operator choice. Engine-level duplicates stay in the engines as a
 * second line of defence; the metadata classifier lives in @agentbrowser/policy.
 *
 * Refusals are exported as ServiceError argument tuples, not errors, so this
 * module does not import service.ts (which imports it). Their details objects
 * are shared by every throw, so they are frozen.
 */

import { EngineError } from '@agentbrowser/engine';
import { MetadataFloorPolicy, type RequestPolicyChain } from '@agentbrowser/policy';

/** Trusted startup admission, separate from the request's boolean selector. */
export type CdpAttachAdmission =
  | 'allowed'
  | 'disabled'
  | 'egress'
  | 'hosted'
  | 'multi_tenant'
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
  if (options.deploymentMode === 'hosted') return 'hosted';
  if (tenantCount > 1) return 'multi_tenant';
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
    // Same client-facing reason as hosted; a distinct floor rule (ADR-024 §1).
    multi_tenant: [
      'HOSTED_UNSUPPORTED',
      'Operator attachment is unavailable in hosted or multi-tenant deployments (ADR-008). Use an isolated browser session.',
    ],
    local_only: [
      'CDP_ATTACH_LOCAL_ONLY',
      'Operator attachment requires a literal loopback API listener and local client. Use 127.0.0.1 or ::1.',
    ],
  } as const;
  const [reason, message] = refusals[admission];
  // `reason` stays stable for clients; `rule` names the unconditional floor
  // refusal (ADR-024 §1), which no policy can grant.
  throw new EngineError('ENGINE_UNSUPPORTED', message, false, {
    reason,
    rule: `floor.cdp.${admission}`,
  });
}

/** Controlled (delegated) sessions require an authenticated operator principal. */
export const FLOOR_DELEGATED_REQUIRES_OPERATOR = [
  'FORBIDDEN',
  'Controlled sessions require authenticated operator credentials',
  false,
  Object.freeze({ rule: 'floor.delegated.operator' }),
] as const;

/** Operator-only control, approval and review routes. */
export const FLOOR_OPERATOR_REQUIRED = [
  'FORBIDDEN',
  'Operator authority is required',
  false,
  Object.freeze({ rule: 'floor.delegated.operator' }),
] as const;

/** Operator attachment cannot carry launch, cookie, delegated-control, download or policy options. */
export const FLOOR_ATTACH_OPTIONS = [
  'INVALID_REQUEST',
  'Operator attachment cannot apply launch, cookie, delegated-control, download, or per-session policy options. Use a normal isolated session for those options.',
  false,
  Object.freeze({ rule: 'floor.cdp.options' }),
] as const;

/** True when an attach request asks for any option the floor refuses. */
export function attachRequestHasOptions(
  request: Readonly<{
    controlMode?: unknown;
    headless?: unknown;
    viewport?: unknown;
    locale?: unknown;
    timezoneId?: unknown;
    cookies?: unknown;
    allowDownloads?: boolean;
    allowedHosts?: unknown;
    blockedHosts?: unknown;
    allowServiceWorkers?: unknown;
    maxDownloadBytes?: unknown;
    approval?: unknown;
    engine?: string;
  }>,
  defaultEngineName: string
): boolean {
  return (
    request.controlMode !== undefined ||
    request.headless !== undefined ||
    request.viewport !== undefined ||
    request.locale !== undefined ||
    request.timezoneId !== undefined ||
    request.cookies !== undefined ||
    request.allowDownloads === true ||
    request.allowedHosts !== undefined ||
    request.blockedHosts !== undefined ||
    request.allowServiceWorkers !== undefined ||
    request.maxDownloadBytes !== undefined ||
    request.approval !== undefined ||
    (request.engine !== undefined &&
      request.engine !== 'auto' &&
      request.engine !== defaultEngineName)
  );
}

/** Every session's request policy is wrapped in the metadata floor. */
export function withMetadataFloor(chain: RequestPolicyChain): MetadataFloorPolicy {
  return new MetadataFloorPolicy(chain);
}
