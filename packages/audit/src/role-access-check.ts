import type { ConfirmationEvidence } from './finding-confirmation.js';
import { VisualAuditError } from './visual-audit.js';

/** T7 slice 3: the role/business-logic fixture check. A scanner does not find broken access
 * control between identities (IDOR), so this check drives a FIXTURE: each resource belongs to one
 * identity and carries a private marker; every other identity reads it with only its own
 * identity headers. It is a read-only GET probe over an explicit resource list — not a scanner,
 * and it builds no payload database. Scope is enforced before any request. */

export interface RoleAccessResource {
  url: string;
  /** The identity that owns the resource. */
  owner: string;
  /** A private marker only the owner should ever receive. Never copied into findings. */
  marker: string;
}

export interface RoleAccessCheckOptions {
  /** The engagement boundary: exact `host[:port]` entries or `.suffix` entries. */
  allowedHosts: string[];
  /** Identity name → the headers that authenticate it (and nothing else). */
  identities: Record<string, Record<string, string>>;
  resources: RoleAccessResource[];
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

export interface RoleAccessFinding {
  kind: 'broken-access-control';
  url: string;
  owner: string;
  /** The identity that read a resource it does not own. */
  actor: string;
  risk: 'high';
  status: 'confirmed';
  evidence: ConfirmationEvidence;
}

export interface RoleAccessResult {
  findings: RoleAccessFinding[];
  /** Owner reads that succeeded and carried the marker — the clean control. */
  ownerControls: { passed: number; failed: number };
}

const READ_ONLY_CLEANUP = {
  required: false,
  performed: false,
  note: 'read-only GET probe; no state created',
} as const;

function inScope(host: string, allowedHosts: string[]): boolean {
  const lowered = host.toLowerCase();
  return allowedHosts.some((pattern) =>
    pattern.startsWith('.')
      ? lowered.endsWith(pattern.toLowerCase())
      : lowered === pattern.toLowerCase()
  );
}

export async function checkRoleAccess(options: RoleAccessCheckOptions): Promise<RoleAccessResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => new Date());
  // Scope and fixture validation happen before ANY request.
  for (const resource of options.resources) {
    const host = new URL(resource.url).host;
    if (!inScope(host, options.allowedHosts))
      throw new VisualAuditError(
        'POLICY_DENIED',
        `SCOPE_HOST_DENIED: resource host ${host} is outside the engagement scope`
      );
    if (!(resource.owner in options.identities))
      throw new VisualAuditError(
        'FIXTURE_INVALID',
        `FIXTURE_INVALID: unknown owner identity ${resource.owner}`
      );
    if (resource.marker.length === 0)
      throw new VisualAuditError(
        'FIXTURE_INVALID',
        'FIXTURE_INVALID: every resource needs a private marker'
      );
  }

  const read = async (url: string, identity: string) => {
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: { ...options.identities[identity] },
      redirect: 'manual',
    });
    const body = response.ok ? await response.text() : '';
    return { ok: response.ok, status: response.status, body };
  };

  const findings: RoleAccessFinding[] = [];
  const ownerControls = { passed: 0, failed: 0 };
  for (const resource of options.resources) {
    // The clean control: the owner must read its own resource and see its marker. A failing
    // control means the fixture is broken, which must never be reported as "no findings".
    const owned = await read(resource.url, resource.owner);
    if (!owned.ok || !owned.body.includes(resource.marker)) {
      ownerControls.failed += 1;
      throw new VisualAuditError(
        'FIXTURE_INVALID',
        `FIXTURE_INVALID: owner ${resource.owner} cannot read its own resource ${resource.url} (status ${owned.status})`
      );
    }
    ownerControls.passed += 1;
    for (const actor of Object.keys(options.identities)) {
      if (actor === resource.owner) continue;
      const crossed = await read(resource.url, actor);
      if (crossed.ok && crossed.body.includes(resource.marker)) {
        findings.push({
          kind: 'broken-access-control',
          url: resource.url,
          owner: resource.owner,
          actor,
          risk: 'high',
          status: 'confirmed',
          evidence: {
            method: 'independent-reproduction',
            reproducedAt: now().toISOString(),
            observation: `identity ${actor} received the owner's private marker (HTTP ${crossed.status})`,
            cleanup: { ...READ_ONLY_CLEANUP },
          },
        });
      }
    }
  }
  return { findings, ownerControls };
}
