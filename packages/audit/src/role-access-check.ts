import {
  type ConfirmationEvidence,
  confirmFinding,
  VisualAuditError,
} from '@agentbrowser/engagement';

/** T7 slice 3: the role/business-logic fixture check. A scanner does not find broken access
 * control between identities (IDOR), so this check drives a FIXTURE: each resource belongs to one
 * identity and carries a private marker; every other identity reads it with only its own
 * identity headers. It is a read-only GET probe over an explicit resource list — not a scanner,
 * and it builds no payload database. Scope is enforced before any request, but only on the host:
 * an engagement's path, method, time or budget limits are the caller's to apply.
 *
 * A cross-identity read that returns the owner's marker is deterministic evidence of the flaw, so
 * the probe confirms it through `confirmFinding` with the read as the reproduction; the probe that
 * detects it is the one that reproduces it, which is stated in the evidence observation. */

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
  /** Per-request timeout (default 15 s). */
  timeoutMs?: number;
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
  /** Owner reads that succeeded and carried the marker — the clean control. A failing control
   * throws FIXTURE_INVALID instead of returning, so there is no failed count. */
  ownerControls: { passed: number };
}

/** Response bodies are read up to this many bytes; a marker past it is not seen. */
const MAX_BODY_BYTES = 1_048_576;

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
    // Object.hasOwn: an owner such as 'constructor' must not resolve through the prototype.
    if (!Object.hasOwn(options.identities, resource.owner))
      throw new VisualAuditError(
        'FIXTURE_INVALID',
        `FIXTURE_INVALID: unknown owner identity ${resource.owner}`
      );
    if (resource.marker.length === 0)
      throw new VisualAuditError(
        'FIXTURE_INVALID',
        'FIXTURE_INVALID: every resource needs a private marker'
      );
    // The URL is reported in findings; a marker inside it would leak, and a page reflecting its
    // own URL would look like a read. Neither the URL nor the marker is echoed in this refusal.
    if (
      resource.url.includes(resource.marker) ||
      safeDecode(resource.url).includes(resource.marker)
    )
      throw new VisualAuditError(
        'FIXTURE_INVALID',
        'FIXTURE_INVALID: a resource URL contains its private marker'
      );
  }

  const timeoutMs = options.timeoutMs ?? 15_000;
  const read = async (url: string, identity: string) => {
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: { ...options.identities[identity] },
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      // Release the connection: an unread body can hold it open.
      await response.body?.cancel().catch(() => undefined);
      return { ok: false, status: response.status, body: '' };
    }
    return { ok: true, status: response.status, body: await boundedText(response) };
  };

  const findings: RoleAccessFinding[] = [];
  const ownerControls = { passed: 0 };
  for (const resource of options.resources) {
    // The clean control: the owner must read its own resource and see its marker. A failing
    // control means the fixture is broken, which must never be reported as "no findings".
    const owned = await read(resource.url, resource.owner);
    if (!owned.ok || !owned.body.includes(resource.marker)) {
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
        const suspected = {
          kind: 'broken-access-control' as const,
          url: resource.url,
          owner: resource.owner,
          actor,
          risk: 'high' as const,
          status: 'suspected' as const,
        };
        findings.push(
          confirmFinding(suspected, {
            method: 'independent-reproduction',
            reproducedAt: now().toISOString(),
            observation: `identity ${actor} received the owner's private marker (HTTP ${crossed.status}); the detecting read is the reproduction`,
            cleanup: { ...READ_ONLY_CLEANUP },
          })
        );
      }
    }
  }
  return { findings, ownerControls };
}

/** Percent-decode each run of `%XX` escapes on its own, so one malformed escape elsewhere in the
 * URL (e.g. `?x=%ZZ`) cannot switch decoding off for the rest. A run that is not valid UTF-8 is
 * decoded byte by byte. */
function safeDecode(url: string): string {
  return url.replace(/(?:%[0-9A-Fa-f]{2})+/g, (run) => {
    try {
      return decodeURIComponent(run);
    } catch {
      return run.replace(/%([0-9A-Fa-f]{2})/g, (_, hex: string) =>
        String.fromCharCode(Number.parseInt(hex, 16))
      );
    }
  });
}

async function boundedText(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (reader === undefined) return '';
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (total < MAX_BODY_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
  }
  if (total >= MAX_BODY_BYTES) await reader.cancel().catch(() => undefined);
  const bytes = new Uint8Array(Math.min(total, MAX_BODY_BYTES));
  let offset = 0;
  for (const chunk of chunks) {
    const take = Math.min(chunk.byteLength, bytes.byteLength - offset);
    bytes.set(chunk.subarray(0, take), offset);
    offset += take;
    if (offset >= bytes.byteLength) break;
  }
  return new TextDecoder().decode(bytes);
}
