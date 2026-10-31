import { isScopeDenialCode, type ScopeDenialDetail } from '@agentbrowser/protocol';
import { tldts } from './tldts-lazy.js';

const vendors = [
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
];
const label = (hostname: string): string | undefined =>
  tldts().getDomain(hostname, { allowPrivateDomains: true })?.split('.')[0];

/** Bounded advisory correlation. A match never grants network authority. */
export class DenialTrace {
  private readonly recent = new Map<string, { times: number[] }>();
  constructor(
    private readonly programHosts: string[],
    private readonly windowMs = 5000
  ) {}
  note(data: Record<string, unknown>, now: number): ScopeDenialDetail | undefined {
    const detail = scopeDenialDetail(data);
    if (!detail) return;
    const hostname = detail.hostname;
    if (data.scope === 'SCOPE_HOST_DENIED') {
      for (const [host, row] of this.recent)
        if (now - (row.times.at(-1) ?? Number.NEGATIVE_INFINITY) > this.windowMs)
          this.recent.delete(host);
      const old = this.recent.get(hostname);
      if (old) {
        old.times = old.times.filter((at) => now - at <= this.windowMs).slice(-63);
        old.times.push(now);
      } else if (this.recent.size < 128) this.recent.set(hostname, { times: [now] });
    }
    return detail;
  }

  hints(now: number): Array<{ hostname: string; count: number; message: string }> {
    const labels = new Set(
      this.programHosts.map((host) => label(host.replace(/^\./, ''))).filter(Boolean)
    );
    const result: Array<{ hostname: string; count: number; message: string }> = [];
    for (const [hostname, row] of this.recent) {
      const count = row.times.filter((at) => now - at <= this.windowMs).length;
      if (count < 3) continue;
      if (
        !vendors.some((vendor) => hostname === vendor || hostname.endsWith(`.${vendor}`)) &&
        !labels.has(label(hostname))
      )
        continue;
      result.push({
        hostname,
        count,
        message: `functional dependency may be starved: ${hostname} — review authorization before adding as a resource host`,
      });
    }
    return result;
  }
}
export function denialTraceLine(data: ScopeDenialDetail & { timestamp: string }): string {
  return `${data.timestamp} ${data.scope} ${data.method} ${data.url}`;
}

export function scopeDenialDetail(data: Record<string, unknown>): ScopeDenialDetail | undefined {
  if (!isScopeDenialCode(data.scope)) return;
  let url: URL;
  try {
    url = new URL(String(data.redirect ?? data.url));
  } catch {
    return;
  }
  if (!['http:', 'https:'].includes(url.protocol)) return;
  const method =
    typeof data.method === 'string' && /^[A-Z][A-Z0-9-]{0,31}$/.test(data.method)
      ? data.method
      : '?';
  return {
    scope: data.scope,
    method,
    url: `${url.origin}${url.pathname}`.slice(0, 2048),
    hostname: url.hostname.slice(0, 253),
  };
}
