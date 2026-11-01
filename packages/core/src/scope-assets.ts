import type { EngagementScope } from '@agentbrowser/protocol';
import { hostMatchesPattern, hostPatternsOverlap } from './domain-matcher.js';
import { verifyEngagementLedger } from './engagement-chain.js';
import { tldts } from './tldts-lazy.js';

const staticAssetTypes = new Set([
  'script',
  'stylesheet',
  'image',
  'font',
  'media',
  'manifest',
  'texttrack',
]);
// Expose membership without allowing consumers to widen the classification set.
export const STATIC_ASSET_TYPES = Object.freeze({
  has: (type: string): boolean => staticAssetTypes.has(type),
});
export interface ScopeAssetHost {
  host: string;
  class: 'asset';
  category?: 'asset' | 'consent' | 'captcha' | 'sso';
}
export interface DeniedHostSummary {
  hostname: string;
  count: number;
  codes: Record<string, number>;
  resourceTypes: Record<string, number>;
}
export interface DenialRecord {
  type: string;
  data: Record<string, unknown>;
}

export function summarizeDeniedHosts(
  records: Iterable<DenialRecord>,
  maxHosts = 256
): { hosts: DeniedHostSummary[]; truncated: boolean } {
  const hosts = new Map<string, DeniedHostSummary>();
  let truncated = false;
  for (const record of records) {
    const data = record.data;
    if (
      !(
        record.type === 'request.failed' ||
        record.type === 'preflight.denied' ||
        (record.type === 'request' && data.outcome === 'failed')
      ) ||
      typeof data.scope !== 'string' ||
      !data.scope.startsWith('SCOPE_')
    )
      continue;
    let hostname: string;
    try {
      hostname = new URL(String(data.redirect ?? data.url)).hostname
        .toLowerCase()
        .replace(/\.+$/, '');
    } catch {
      continue;
    }
    if (!hostname) continue;
    let row = hosts.get(hostname);
    if (!row) {
      if (hosts.size >= maxHosts) {
        truncated = true;
        continue;
      }
      row = {
        hostname,
        count: 0,
        codes: Object.create(null) as Record<string, number>,
        resourceTypes: Object.create(null) as Record<string, number>,
      };
      hosts.set(hostname, row);
    }
    row.count += 1;
    row.codes[data.scope] = (row.codes[data.scope] ?? 0) + 1;
    const type = typeof data.resourceType === 'string' ? data.resourceType : 'unknown';
    row.resourceTypes[type] = (row.resourceTypes[type] ?? 0) + 1;
  }
  return {
    hosts: [...hosts.values()].sort(
      (a, b) => b.count - a.count || a.hostname.localeCompare(b.hostname)
    ),
    truncated,
  };
}

export function deniedHostsFromLedger(text: string) {
  if (!text.trim() || !verifyEngagementLedger(text).ok)
    throw new Error('Asset adoption requires a valid engagement ledger chain');
  return summarizeDeniedHosts(
    text
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as DenialRecord)
  );
}

/** An explicit operator command adopts candidates as assets; observations alone grant nothing. */
export function adoptAssetCandidates(
  scope: EngagementScope,
  candidates: DeniedHostSummary[]
): EngagementScope {
  const assetHosts: ScopeAssetHost[] = (scope.assetHosts ?? []).map((entry) => ({ ...entry }));
  for (const row of candidates) {
    const host = row.hostname;
    if (
      !row.codes.SCOPE_HOST_DENIED ||
      !Object.keys(row.resourceTypes).some((t) => STATIC_ASSET_TYPES.has(t))
    )
      continue;
    if (
      scope.allowedHosts.some((p) => hostPatternsOverlap(host, p)) ||
      (scope.excludeHosts ?? []).some((p) => hostMatchesPattern(host, p)) ||
      assetHosts.some((a) => hostMatchesPattern(host, a.host))
    )
      continue;
    const parsed = new URL(`https://${host}`);
    if (
      !host ||
      parsed.hostname !== host ||
      parsed.port ||
      parsed.username ||
      !/^[a-z0-9.-]+$/.test(host)
    )
      throw new Error('Invalid asset candidate host');
    assetHosts.push({ host, class: 'asset' });
  }
  if (assetHosts.length > 128) throw new Error('At most 128 asset hosts may be adopted');
  return { ...structuredClone(scope), ...(assetHosts.length ? { assetHosts } : {}) };
}

/** Vendors whose denial starves a program's own pages (mirrors DenialTrace's
 * live-hint list; kept in sync there until the two share one constant). */
const FUNCTIONAL_DEPENDENCY_VENDORS = [
  'cookielaw.org',
  'onetrust.com',
  'datadome.co',
  'captcha-delivery.com',
  'recaptcha.net',
  'hcaptcha.com',
  'hcaptcha.net',
  'sentry.io',
  'braze.com',
  'braze.eu',
] as const;

export type ScopeHostSuggestionClass = 'program-host' | 'asset-host' | 'unrecognized';
export interface ScopeHostSuggestion {
  hostname: string;
  count: number;
  suggestion: ScopeHostSuggestionClass;
  registrableDomain?: string;
  evidence: { codes: Record<string, number>; resourceTypes: Record<string, number> };
  note: string;
}

const registrableDomain = (host: string): string | undefined =>
  tldts().getDomain(host, { allowPrivateDomains: true }) ?? undefined;

/**
 * Classify denied hosts for operator review. A suggestion is an observation,
 * never authorization (ADR-028): program targets stay immutable in live
 * sessions, and only an explicit operator command changes a scope file.
 * `program-host` names a host under a registrable domain the scope already
 * trusts — likely a first-party endpoint the published program list omitted
 * (the Wolt `consumer-api`/`gatekeeper` shape). The least-authority edit is
 * the exact hostname in `allowedHosts` for the NEXT session; widening a bare
 * registrable domain covers its whole subtree and is the operator's call.
 */
export function suggestScopeHosts(
  scope: EngagementScope,
  denied: { hosts: DeniedHostSummary[]; truncated: boolean },
  maxSuggestions = 64
): { hosts: ScopeHostSuggestion[]; truncated: boolean } {
  const programRegistry = new Set(
    scope.allowedHosts
      .map((pattern) => registrableDomain(pattern.replace(/^\./, '')))
      .filter((domain): domain is string => domain !== undefined)
  );
  const suggestions: ScopeHostSuggestion[] = [];
  for (const row of denied.hosts) {
    const host = row.hostname;
    // Never suggest what the operator already allows, adopted as an asset, or
    // deliberately excluded (an exclusion denial must not resuggest the host).
    if (scope.allowedHosts.some((pattern) => hostMatchesPattern(host, pattern))) continue;
    if ((scope.excludeHosts ?? []).some((pattern) => hostMatchesPattern(host, pattern))) continue;
    if ((scope.assetHosts ?? []).some((asset) => hostMatchesPattern(host, asset.host))) continue;
    const registry = registrableDomain(host);
    const types = Object.keys(row.resourceTypes);
    const staticOnly = types.length > 0 && types.every((type) => STATIC_ASSET_TYPES.has(type));
    const vendor = FUNCTIONAL_DEPENDENCY_VENDORS.some((v) => host === v || host.endsWith(`.${v}`));
    let suggestion: ScopeHostSuggestionClass;
    let note: string;
    if (vendor && staticOnly) {
      suggestion = 'asset-host';
      note =
        'known functional-dependency vendor — adopt as an asset host (GET/HEAD static, no credentials)';
    } else if (vendor) {
      // The asset class is GET/HEAD static only; a vendor reached with active
      // traffic (sentry ingest over fetch/POST) has no home in the current
      // schema — surface it rather than mis-suggest a class that cannot carry it.
      suggestion = 'unrecognized';
      note =
        'functional-dependency vendor with non-static traffic — the asset class cannot carry it; it needs an explicit program-host entry or a future resource-host class';
    } else if (registry !== undefined && programRegistry.has(registry)) {
      suggestion = 'program-host';
      note = `same registry as an allowed host (${registry}) — likely a first-party endpoint missing from the program list; if authorized, add the exact hostname to allowedHosts for the next session (a bare ${registry} entry would cover its whole subtree)`;
    } else if (row.codes.SCOPE_HOST_DENIED && staticOnly) {
      suggestion = 'asset-host';
      note = 'static subresource only — existing scope adopt-assets path';
    } else {
      suggestion = 'unrecognized';
      note = 'cross-registry non-static host; review the program scope before any change';
    }
    suggestions.push({
      hostname: host,
      count: row.count,
      suggestion,
      ...(registry !== undefined ? { registrableDomain: registry } : {}),
      evidence: { codes: { ...row.codes }, resourceTypes: { ...row.resourceTypes } },
      note,
    });
  }
  return {
    hosts: suggestions.slice(0, maxSuggestions),
    truncated: suggestions.length > maxSuggestions || denied.truncated,
  };
}

/**
 * Methods the scope denied on in-scope hosts (complements the observed method
 * fingerprint): each is a candidate `allowedMethods` addition for the next
 * scope when the program permits it. Observation grants nothing.
 */
export function suggestScopeMethods(
  scope: EngagementScope,
  records: Iterable<DenialRecord>
): { method: string; count: number }[] {
  const allowed = new Set((scope.allowedMethods ?? []).map((m) => m.toUpperCase()));
  const deniedMethods = new Map<string, number>();
  for (const record of records) {
    const data = record.data;
    if (data.scope !== 'SCOPE_METHOD_DENIED' || typeof data.method !== 'string') continue;
    const method = data.method.toUpperCase();
    if (allowed.has(method)) continue;
    deniedMethods.set(method, (deniedMethods.get(method) ?? 0) + 1);
  }
  return [...deniedMethods.entries()]
    .map(([method, count]) => ({ method, count }))
    .sort((a, b) => b.count - a.count || a.method.localeCompare(b.method));
}
