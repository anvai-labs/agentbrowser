/** Shared interaction semantics for human help and agent-facing adapters. */
export const INTERACTION_GUIDANCE = Object.freeze({
  networkPolicy:
    'Private-network access requires operator authorization: AGENTBROWSER_ALLOWED_CIDRS on the ' +
    'agentbrowser-server process at startup (comma-separated CIDRs; prefer one host /32 or /128). ' +
    'Setting it on the CLI or MCP adapter does not configure an existing server. ' +
    'CIDR exceptions keep loopback and cloud-metadata blocks enabled, including 127.0.0.1/32; ' +
    'session host rules only restrict access. For local-machine testing against 127.0.0.1 dev servers, ' +
    'the operator can start the server with AGENTBROWSER_ALLOW_LOOPBACK=1, which disables the loopback ' +
    'block for every session on that server — visited pages can then reach the server itself and other ' +
    'loopback services, so use it only where the machine is already trusted to the task. ' +
    'A finer-grained path is a separate trusted embedding with ServerOptions.networkPolicy and ' +
    'NetworkPolicy({blockLoopback:false}); keep private/metadata blocks, permit only required loopback ' +
    'CIDRs, and narrow session allowedHosts. ' +
    'localhost may resolve to both 127.0.0.1 and ::1; every resolved address is checked. ' +
    'POLICY_DENIED can also mean another policy rule; inspect the reason before changing configuration.',
  headedSession:
    'A headed window opens on the server host, not necessarily the client machine. ' +
    'An isolated session does not inherit your daily Chrome login. Inspect returned diagnostics ' +
    'and verify the authenticated page after login or cookie seeding.',
  cookieHandoff:
    'Cookies are credentials. Prefer the CLI private-file handoff when shell access is available: ' +
    'session cookies SESSION --output /private/path/cookies.json, then session create ' +
    '--tenant TENANT --cookies-file /private/path/cookies.json. Seeding does not prove login.',
  snapshot:
    'Read a self-contained page snapshot with current refs. Prefer scoped bulk autofill, ' +
    'where available, for supported native forms; use a snapshot to prepare explicit steps. ' +
    'Degraded or truncated observations cannot establish complete target coverage.',
  plan:
    'Execute explicit ordered steps in one server call. Inspect per-step results and partial ' +
    'effects; command completion does not prove an application commit.',
  action:
    'Act through current element refs. Reobserve stale targets; do not guess selectors or ' +
    'reuse refs after navigation. A completed action does not prove an application commit.',
  uncertainWrite:
    'A timed-out or disconnected write may have executed. Do not blindly retry: reconcile ' +
    'the recorded operation under current authorization before any further write. ' +
    'If no operation record is available, preserve uncertainty and inspect independent outcome evidence.',
  livePush:
    'Live-push transports are closed under any active egress policy (the default SSRF policy ' +
    'included): page WebSockets close with code 1014 "blocked by egress policy" — an engine ' +
    'diagnostic, not a site or bot wall. Read final state by reloading the page or polling a REST ' +
    'endpoint instead of waiting for push; streamed HTTP (SSE) is buffered by the same choke point. ' +
    'allowServiceWorkers restores service-worker transport only, never WebSockets. There is no ' +
    'supported procedure to enable page WebSockets under a policy; the transport-level replacement ' +
    'is tracked separately.',
});
