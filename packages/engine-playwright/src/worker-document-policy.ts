/** Independent enforced policy: never edit or relax a site's own CSP. */
export const WORKER_DENIAL_CSP = "worker-src 'none'";
export function denyWorkersInDocument(headers: Record<string, string>): Record<string, string> {
  const csp = Object.entries(headers).find(
    ([name]) => name.toLowerCase() === 'content-security-policy'
  );
  return {
    ...headers,
    [csp?.[0] ?? 'content-security-policy']: csp
      ? `${csp[1]}, ${WORKER_DENIAL_CSP}`
      : WORKER_DENIAL_CSP,
  };
}
