import { isIP } from 'node:net';
import { parse } from 'tldts';

/**
 * TD-BROWSER-16 phase 3 (ADR-025 §3): the cookie-domain relation — which
 * cookies a handoff may transfer to which target, and which allowlist entries
 * cover which hosts. The public suffix list comes from pinned `tldts`, so a
 * registrable domain can never be handed off for a public suffix (github.io,
 * vercel.app) and a suffix of a registrable domain never covers its siblings.
 *
 * Semantics (host strings as `Cookie.domain` carries them, leading dot or not):
 * - `covers(matcher, host)` — a cookie's domain (or an allowlist entry)
 *   matches `host` when they are equal, or `matcher` is a parent domain of
 *   `host` AND registrable: exactly the cookie-scope rule minus public
 *   suffixes. A suffix entry (`.example.com`) covers SUBDOMAINS ONLY, like
 *   SessionHostPolicy — list the apex explicitly alongside it when both are
 *   in scope.
 * - `cookieDomain(domain, host)` — what a handoff may bind for `host`:
 *   `host` itself (host-only) or a registrable parent the operator asked
 *   for. `null` refuses: public suffixes, suffix-only hosts, IPs,
 *   non-registrable labels.
 */

/** The private section of the public suffix list is in force (ADR-025 §3). */
const PARSE_OPTIONS = { allowPrivateDomains: true } as const;

export interface DomainVerdict {
  /** True when the relation holds. */
  ok: boolean;
  /** Why it refused, for the operator; never a host if ok is true. */
  reason?: string;
}

const normalize = (host: string): string => (host.startsWith('.') ? host.slice(1) : host);

function parentChains(host: string): string[] {
  // Every parent domain of host, longest-first, excluding host itself.
  const parts = host.split('.');
  const chains: string[] = [];
  for (let i = 1; i < parts.length - 1; i += 1) chains.push(parts.slice(i).join('.'));
  return chains;
}

function isRegistrable(domain: string): boolean {
  // Registrable = tldts resolves a domain and it IS the entry, on the ICANN
  // or the private section (the private section makes github.io a suffix and
  // x.github.io registrable).
  const parsed = parse(domain, PARSE_OPTIONS);
  return parsed.domain === domain && Boolean(parsed.isIcann || parsed.isPrivate);
}

/** Whether `host` is a label-and-up child of `domain` (not equal). */
function isSubdomainOf(host: string, domain: string): boolean {
  return host.endsWith(`.${domain}`) && host.length > domain.length + 1;
}

/** A host string is usable at all: not empty, not an IP, not a public suffix. */
export function usableHost(host: string): DomainVerdict {
  const bare = normalize(host.toLowerCase());
  if (bare === '') return { ok: false, reason: 'empty host' };
  if (isIP(bare) !== 0 || (bare.startsWith('[') && bare.endsWith(']')))
    return { ok: false, reason: 'IP addresses cannot be cookie domains' };
  // With the private section in force, a bare suffix (github.io, vercel.app,
  // co.uk, com, localhost) parses with domain === null; an unknown TLD
  // parses as its own domain but with neither ICANN nor private — the
  // keys-only rule refuses it.
  const parsed = parse(bare, PARSE_OPTIONS);
  if (parsed.domain === null)
    return { ok: false, reason: 'not a registrable domain (public suffix or unlisted TLD)' };
  if (!parsed.isIcann && !parsed.isPrivate)
    return { ok: false, reason: 'not on the public suffix list' };
  return { ok: true };
}

/**
 * Does `matcher` (a cookie domain or an allowlist entry) cover `host`?
 * Exact match always; a parent covers its subdomains only when registrable.
 */
export function covers(matcher: string, host: string): DomainVerdict {
  const m = normalize(matcher.toLowerCase());
  const h = normalize(host.toLowerCase());
  if (m === h) return { ok: true };
  if (!isSubdomainOf(h, m)) return { ok: false, reason: 'not equal and not a subdomain' };
  // The matcher must itself be registrable: ".github.io" must not cover
  // "x.github.io", and ".com" must not cover anything.
  if (!isRegistrable(m))
    return { ok: false, reason: 'matcher is a public suffix, not a registrable domain' };
  return { ok: true };
}

/**
 * What cookie domain a handoff may bind for `host`: `host` itself, or a
 * registrable parent explicitly requested by the operator. `null` refuses.
 */
export function cookieDomain(host: string, requested?: string): string | null {
  const h = normalize(host.toLowerCase());
  if (!usableHost(h).ok) return null;
  if (requested === undefined) return h;
  const r = normalize(requested.toLowerCase());
  // The request must be the host itself or a registrable parent.
  if (r !== h && !isSubdomainOf(h, r)) return null;
  if (!isRegistrable(r)) return null;
  return r;
}

/** Host-only and `.domain` cookies with the same name and path are distinct (the dedup fix). */
export function cookieKey(cookie: { name: string; domain: string; path: string }): string {
  const d = normalize(cookie.domain.toLowerCase());
  const hostOnly = !cookie.domain.startsWith('.');
  return `${cookie.name}|${hostOnly ? 'h' : 'd'}|${d}|${cookie.path}`;
}

/** Every registrable parent of host (for operator "widen to my domain" flows). */
export function registrableParents(host: string): string[] {
  const h = normalize(host.toLowerCase());
  return parentChains(h).filter(isRegistrable);
}
