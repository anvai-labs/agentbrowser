import type { ScopeTrafficSummary } from '@agentbrowser/protocol';
import { BoundedCache } from './bounded-cache.js';
import { hostMatchesPattern } from './domain-matcher.js';

export class ScopeTraffic {
  private readonly rows = new Map<string, ScopeTrafficSummary['rows'][number]>();
  private truncated = false;
  constructor(
    private readonly scope: {
      allowedHosts: string[];
      assetHosts?: Array<{ host: string }>;
      resourceHosts?: string[];
    }
  ) {}
  note(data: Record<string, unknown>, denied: boolean, effective = this.scope): void {
    if (typeof data.method !== 'string' || !/^[A-Z][A-Z0-9-]{0,31}$/.test(data.method)) return;
    let hostname: string;
    try {
      hostname = new URL(String(data.redirect ?? data.url)).hostname;
    } catch {
      return;
    }
    const matches = (patterns: string[]) =>
      patterns.some((pattern) => hostMatchesPattern(hostname, pattern));
    const hostClass = matches(effective.allowedHosts)
      ? 'program'
      : matches((effective.assetHosts ?? []).map((a) => a.host))
        ? 'asset'
        : matches(effective.resourceHosts ?? [])
          ? 'resource'
          : 'other';
    const key = `${hostClass}:${data.method}`;
    let row = this.rows.get(key);
    if (!row) {
      if (this.rows.size >= 128) {
        this.truncated = true;
        return;
      }
      row = { method: data.method, hostClass, requests: 0, denied: 0 };
      this.rows.set(key, row);
    }
    row.requests++;
    if (denied) row.denied++;
  }
  summary(): ScopeTrafficSummary {
    return {
      rows: [...this.rows.values()]
        .map((row) => ({ ...row }))
        .sort((a, b) => a.method.localeCompare(b.method) || a.hostClass.localeCompare(b.hostClass)),
      truncated: this.truncated,
    };
  }
}
/** Process-local advisory history, no URLs/credentials and no cross-tenant lookup. */
export class PageCostHistory {
  private readonly samples = new BoundedCache<string, number[]>({ maxEntries: 256 });
  note(tenant: string, host: string, cost: number): void {
    if (!Number.isSafeInteger(cost) || cost < 1) return;
    const key = JSON.stringify([tenant, host]);
    const samples = this.samples.get(key) ?? [];
    this.samples.set(key, [...samples.slice(-31), cost]);
  }
  warning(tenant: string, hosts: string[], budget: number | undefined): string | undefined {
    if (budget === undefined) return;
    const values = hosts
      .flatMap((host) => this.samples.get(JSON.stringify([tenant, host])) ?? [])
      .sort((a, b) => a - b);
    if (!values.length) return;
    const median = values[Math.floor(values.length / 2)];
    if (median === undefined) return;
    if (budget < 5 * median)
      return `Request budget ${budget} is below 5 × the tenant's observed median page cost (${median} requests); plan at least ${5 * median} requests for five comparable navigations. Subrequests and redirect hops count; deferred SPA traffic can cost more.`;
  }
}
