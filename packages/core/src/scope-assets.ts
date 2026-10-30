import type { EngagementScope } from '@agentbrowser/protocol';
import { hostMatchesPattern, hostPatternsOverlap } from './domain-matcher.js';
import { verifyEngagementLedger } from './engagement-chain.js';

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
