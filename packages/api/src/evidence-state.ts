import { createHash } from 'node:crypto';
import { hostMatchesPattern } from '@agentbrowser/core';
import type { EvidenceState } from '@agentbrowser/engine';
import type { EngagementScope } from '@agentbrowser/protocol';

const hostAllowed = (host: string, scope: EngagementScope) =>
  scope.allowedHosts.some((p) => hostMatchesPattern(host, p)) &&
  !(scope.excludeHosts ?? []).some((p) => hostMatchesPattern(host, p));

export function evidenceOrigins(origins: string[], scope: EngagementScope): string[] {
  if (origins.length < 1 || origins.length > 16)
    throw new Error('Select 1–16 exact program origins');
  return [
    ...new Set(
      origins.map((origin) => {
        const url = new URL(origin);
        if (
          url.origin !== origin ||
          !['http:', 'https:'].includes(url.protocol) ||
          url.username ||
          url.password ||
          !hostAllowed(url.hostname, scope) ||
          (scope.allowedSchemes &&
            !scope.allowedSchemes.some(
              (scheme) => scheme.toLowerCase() === url.protocol.slice(0, -1)
            )) ||
          (scope.allowedPorts &&
            !scope.allowedPorts.includes(
              Number(url.port || (url.protocol === 'https:' ? 443 : 80))
            ))
        )
          throw new Error('State transfer requires an exact authorized program origin');
        return origin;
      })
    ),
  ].sort();
}

/** Values stay server-side; asset origins and parent-cookie rewrites are never admitted. */
export function filterEvidenceState(
  state: EvidenceState,
  scope: EngagementScope,
  origins: string[]
): EvidenceState {
  const selected = new Set(evidenceOrigins(origins, scope));
  if (
    !Array.isArray(state.cookies) ||
    !Array.isArray(state.origins) ||
    state.cookies.length > 1000 ||
    state.origins.length > 16 ||
    Buffer.byteLength(JSON.stringify(state)) > 1024 * 1024
  )
    throw new Error('Captured browser state exceeds its bounds');
  const cookies = state.cookies
    .filter((cookie) => {
      if (
        'partitionKey' in cookie ||
        typeof cookie.domain !== 'string' ||
        typeof cookie.name !== 'string' ||
        typeof cookie.value !== 'string' ||
        typeof cookie.path !== 'string'
      )
        throw new Error('Unsupported cookie state');
      const domain = cookie.domain.toLowerCase();
      const host = domain.replace(/^\./, '');
      if (!hostAllowed(host, scope)) return false;
      if (
        !origins.some((origin) => {
          const hostname = new URL(origin).hostname;
          return hostname === host || (domain.startsWith('.') && hostname.endsWith(domain));
        })
      )
        return false;
      if (domain.startsWith('.')) {
        if (
          !scope.allowedHosts.some(
            (p) => hostMatchesPattern(host, p) && hostMatchesPattern(`probe.${host}`, p)
          )
        )
          return false;
        if (
          (scope.excludeHosts ?? []).some(
            (p) => p.replace(/^\./, '') === host || p.endsWith(domain) || host.endsWith(p)
          )
        )
          return false;
      }
      return (
        cookie.expires === undefined || cookie.expires === -1 || cookie.expires * 1000 > Date.now()
      );
    })
    .map((cookie) => ({ ...cookie }));
  const storage = state.origins
    .filter((entry) => selected.has(entry.origin))
    .map((entry) => {
      if (
        !Array.isArray(entry.localStorage) ||
        entry.localStorage.length > 1000 ||
        entry.localStorage.some(
          (item) =>
            typeof item.name !== 'string' ||
            typeof item.value !== 'string' ||
            item.name.length > 4096 ||
            item.value.length > 65536
        )
      )
        throw new Error('Unsupported localStorage state');
      return {
        origin: entry.origin,
        localStorage: entry.localStorage.map((item) => ({ ...item })),
      };
    });
  return { cookies, origins: storage };
}

export function evidenceStateDigest(state: EvidenceState) {
  return {
    sha256: createHash('sha256').update(JSON.stringify(state)).digest('hex'),
    cookieCount: state.cookies.length,
    originCount: state.origins.length,
    entryCount: state.origins.reduce((n, entry) => n + entry.localStorage.length, 0),
  };
}
