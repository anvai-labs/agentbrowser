# ADR-006: Network Egress Policy Boundary and SSRF Defense

**Status:** Accepted
**Context:** 2025-01-23
**Superseded by:** N/A

## Context

AgentBrowser executes code from untrusted pages (JavaScript) and interacts with untrusted destinations (arbitrary websites). This creates several attack vectors:

1. **SSRF (Server-Side Request Forgery)**: Pages can trigger requests to internal resources
2. **DNS rebinding**: DNS responses change between resolve and connect
3. **Redirect chains**: Redirects can bypass initial checks
4. **Data exfiltration**: Exfiltrate data to attacker-controlled domains
5. **Resource exhaustion**: Infinite redirects, huge files, decompression bombs

The system must enforce network policy at a choke point where all outbound traffic passes.

## Decision

**All network access passes through a single enforceable policy boundary with SSRF defenses.**

### Core principles

1. **Allowlist by default**: Only explicitly allowed hosts can be accessed
2. **Choke point enforcement**: Single place where all requests are checked
3. **Layered defense**: IP validation + host validation + redirect limiting
4. **Credential injection**: Scoped credentials injected only at boundary
5. **Fail closed**: Policy violations block the request and log

### Default policy

```json
{
  "allowedHosts": ["*"],  // Can be restricted per session
  "blockedHosts": [],
  "allowedIpRanges": ["0.0.0.0/0"],  // Can be restricted
  "blockedIpRanges": [
    "127.0.0.0/8",        // Loopback
    "10.0.0.0/8",         // RFC1918
    "172.16.0.0/12",      // RFC1918
    "192.168.0.0/16",     // RFC1918
    "169.254.0.0/16",     // Link-local
    "224.0.0.0/4",        // Multicast
    "::1/128",            // IPv6 loopback
    "fc00::/7",           // IPv6 private
    "fe80::/10"           // IPv6 link-local
  ],
  "blockMetadata": true,   // Cloud metadata endpoints
  "maxRedirects": 5,
  "maxResponseBytes": 10485760,  // 10 MB
  "allowDownloads": false
}
```

## Consequences

### Positive
- **SSRF defense**: Cannot access internal resources by default
- **Data exfiltration prevention**: Blocks unauthorized endpoints
- **Resource protection**: Limits on bytes, redirects, file sizes
- **Auditability**: Every request checked and logged

### Negative
- **Restricted functionality**: Can't access all sites by default
- **Configuration burden**: Must explicitly allow needed hosts
- **Compatibility**: Some sites require complex redirect chains

### Trade-offs
- Security over unrestricted access
- Explicit allowlist over implicit permissions
- Fail closed over fail open

## Rationale

### Why SSRF defense is critical

1. **Cloud metadata**: SSRF to metadata services exposes cloud credentials
2. **Internal services**: SSRF can access internal admin panels
3. **Data exfiltration**: Attacker-controlled domains receive data
4. **Network scanning**: Can map internal network topology

### Why choke point architecture

1. **Single place to enforce**: No bypass via different network paths
2. **Consistent logging**: All requests logged in one place
3. **Performance**: Single policy check is efficient
4. **Debugging**: Easy to see what was allowed/denied

### Why layered defense

1. **DNS rebinding**: IP checked after resolve and after connect
2. **Redirect chains**: Re-check on every redirect
3. **Protocol smuggling**: Only allow http:/https:
4. **Size limits**: Prevent resource exhaustion attacks

### Why allowlist by default

1. **Security**: Unknown hosts are blocked
2. **Compliance**: Data only goes to known endpoints
3. **Cost**: No surprise data transfer to unknown domains
4. **Audit**: Clear record of where data went

### Alternative considered: Request interception only
**Rejected** because:
- Not all browser network paths are interceptable
- Can't guarantee enforcement at browser layer
- Native code paths bypass JavaScript checks
- Not sufficient for hosted multi-tenant security

### Alternative considered: No restrictions (wild west)
**Rejected** because:
- SSRF attacks are trivial
- Data exfiltration is uncontrollable
- Compliance violations
- Unacceptable security risk

## Related Decisions

- **ADR-005**: Ephemeral sessions - complements network isolation
- **ADR-008**: Process isolation - strengthens security boundary
- **Spec Section 14.2**: Network rules and threat model

## Implementation Notes

### Policy enforcement layers

```typescript
// Layer 1: Request resolution
async resolve(hostname) {
  const ip = await dnsResolver.resolve(hostname);

  // Check if IP is blocked
  if (isBlockedIp(ip)) {
    throw new PolicyDeniedError("blocked_ip_range", { ip });
  }

  return ip;
}

// Layer 2: Connection validation
async beforeConnect(hostname, ip) {
  // Re-check IP (DNS rebinding defense)
  const currentIp = await dnsResolver.resolve(hostname);
  if (currentIp !== ip) {
    throw new PolicyDeniedError("dns_rebinding", { hostname });
  }

  // Check host allowlist
  if (!isAllowedHost(hostname)) {
    throw new PolicyDeniedError("blocked_host", { hostname });
  }
}

// Layer 3: Response validation
async afterResponse(request, response) {
  // Check redirect
  if (response.isRedirect()) {
    if (++request.redirectCount > maxRedirects) {
      throw new PolicyDeniedError("max_redirects", { count: request.redirectCount });
    }

    // Re-check redirect target
    await beforeConnect(response.redirectHost, response.redirectIp);
  }

  // Check response size
  if (response.bytesReceived > maxResponseBytes) {
    response.abort();
    throw new PolicyDeniedError("response_too_large", { size: response.bytesReceived });
  }
}
```

### Chromium implementation

```typescript
// In Playwright adapter:
const context = await browser.newContext({
  // Use browser context routing + proxy
  proxy: { server: this.policyProxyServer },
  // Or use request interception (not sufficient alone)
  acceptDownloads: policy.allowDownloads
});

// Policy proxy server validates all requests:
class PolicyProxyServer {
  async request(req) {
    const hostname = parseUrl(req.url).hostname;

    // Layer 1: DNS resolve
    const ip = await this.resolveWithPolicy(hostname);

    // Layer 2: Connect
    await this.validateConnect(hostname, ip);

    // Layer 3: Forward
    return this.forwardRequest(req);
  }
}
```

### Metadata endpoint blocking

```typescript
// Cloud metadata endpoints to block:
const BLOCKED_METADATA_ENDPOINTS = [
  "metadata.google.internal",
  "169.254.169.254",
  "100.100.100.200",  // GCP V2
  // Add other cloud providers
];

async validateMetadataAccess(hostname) {
  if (BLOCKED_METADATA_ENDPOINTS.includes(hostname)) {
    throw new PolicyDeniedError("blocked_metadata_endpoint", { hostname });
  }
}
```

### Credential injection

```typescript
// Inject credentials only at policy boundary:
async injectCredentials(request, credentials) {
  // Never expose credentials to page JavaScript
  // Inject only in HTTP headers at network layer
  if (credentials.type === "basic") {
    request.headers["Authorization"] = `Basic ${credentials.value}`;
  } else if (credentials.type === "bearer") {
    request.headers["Authorization"] = `Bearer ${credentials.value}`;
  }

  // Never log credentials
  this.logger.debug("credentials_injected", { type: credentials.type });
}
```

### Policy decision logging

```typescript
async logPolicyDecision(sessionId, decision) {
  await eventStore.append({
    type: "policy_decision",
    sessionId,
    timestamp: Date.now(),
    decision: decision.action,  // "allow" | "deny"
    reason: decision.reason,
    url: sanitizeUrl(decision.url),
    hostname: decision.hostname,
    ip: decision.ip,
    ruleMatched: decision.rule
  });
}
```

### Validation criteria

- Cannot access 127.0.0.1 from page JavaScript
- Cannot access cloud metadata endpoints
- Cannot follow >5 redirects
- Cannot download >10MB without explicit permission
- All requests logged with allow/deny
- IP rechecked after DNS rebinding attempt
- Credential injection never exposes values to page
- Can configure per-session allowlist
