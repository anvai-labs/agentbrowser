# ADR-008: Process/Container Isolation for Hostile Multi-Tenancy

**Status:** Accepted
**Context:** 2025-01-23
**Superseded by:** N/A

## Context

AgentBrowser will host sessions from multiple tenants on shared infrastructure. Pages are hostile: they can attempt to escape the browser sandbox, access other tenants' data, or probe the host system.

Chromium's BrowserContext is a storage boundary but not a complete security boundary for hostile multi-tenancy:
- Same process memory can have cross-context information leaks
- Crash bugs can affect other contexts
- Resource contention (CPU, memory, FDs) affects neighbors
- Side channels can leak information

For a hosted multi-tenant service, stronger isolation is required.

## Decision

**Use process or container isolation per session/trust group for hosted multi-tenant deployments.**

### Isolation tiers

| Tier | Implementation | Use Case | Cost |
|------|---------------|-----------|------|
| `context` | Separate BrowserContext in shared process | Local single-tenant MVP, development | Low |
| `process` | One Chromium process per session | Default for hosted multi-tenant MVP | Medium |
| `container` | Locked-down container per session | Untrusted or higher-assurance workloads | High |
| `microvm` | MicroVM/isolate boundary | Highest assurance hosted tier | Very High |

### Default for MVP

- **Local development**: `context` isolation (shared process)
- **Hosted MVP**: `process` isolation (one process per session)
- **Future**: `container` isolation for premium tier

### Process isolation implementation

```typescript
// Each session gets its own Chromium process
const browser = await playwright.chromium.launch({
  // No existing contexts - fresh process
  headless: true,

  // Isolate from other sessions
  // Each session.launch() creates new process
});

const context = await browser.newContext({
  // Session-scoped storage
  storageState: undefined
});
```

## Consequences

### Positive
- **Strong isolation**: Process boundary prevents memory leaks
- **Resource limits**: Can apply per-process resource limits
- **Crash containment**: One crash doesn't affect others
- **Security**: Harder to escape process than context

### Negative
- **Resource overhead**: More memory/CPU per session
- **Startup cost**: Process launch is slower than context creation
- **Scalability**: More processes = more host resources

### Trade-offs
- Accept resource overhead for security
- Process isolation is minimum for multi-tenancy
- Context isolation acceptable for single-tenant local use

## Rationale

### Why BrowserContext is insufficient for multi-tenancy

1. **Shared process**: Memory side-channels possible
2. **Crash risk**: Bug in one context can crash entire process
3. **Resource starvation**: No per-context limits
4. **Debugging**: Hard to attribute resource usage per tenant

### Why process isolation is minimum for hosted

1. **Memory isolation**: Separate address spaces
2. **Crash isolation**: One crash doesn't affect others
3. **Resource limits**: OS-level limits per process
4. **Auditability**: Clear per-process metrics

### When to use stronger isolation

1. **Untrusted tenants**: Need container/isolate
2. **Regulatory requirements**: Data segregation requirements
3. **Premium tier**: Customers pay for stronger guarantees
4. **High-risk workloads**: Financial/healthcare data

### Alternative considered: BrowserContext isolation only
**Rejected** because:
- Not sufficient for hostile multi-tenancy
- Memory leaks possible between contexts
- No per-context resource limits
- Crash affects entire process
- Doesn't meet security bar for hosted service

### Alternative considered: Container isolation from start
**Rejected** because:
- Too expensive for MVP
- Overhead not justified initially
- Can upgrade later for premium tier
- Process isolation meets MVP security requirements

## Related Decisions

- **ADR-005**: Ephemeral sessions - complements isolation
- **ADR-006**: Network egress policy - strengthens security
- **Spec Section 9.2**: Isolation tiers

## Implementation Notes

### Session coordinator logic

```typescript
async createSession(options, tenant) {
  const isolationTier = selectIsolationTier(tenant, options);

  switch (isolationTier) {
    case "context":
      // Shared process, separate context
      return await this.createContextSession(options);

    case "process":
      // New process per session
      return await this.createProcessSession(options);

    case "container":
      // New container per session
      return await this.createContainerSession(options);

    case "microvm":
      // Future: Firecracker/isolate
      throw new Error("Not implemented in MVP");
  }
}
```

### Process isolation

```typescript
async createProcessSession(options) {
  // Launch new Chromium process
  const browser = await playwright.chromium.launch({
    headless: true,
    // No args that share state
    args: [
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-features=TranslateUI"
    ]
  });

  // Track for cleanup
  const sessionId = generateId();
  this.sessions.set(sessionId, {
    browser,
    isolationTier: "process",
    createdAt: Date.now()
  });

  // Create context
  const context = await browser.newContext({
    viewport: options.viewport,
    locale: options.locale,
    timezoneId: options.timezoneId
  });

  return { sessionId, context };
}
```

### Resource limits per process

```typescript
async applyResourceLimits(session) {
  // Use OS-level limits where possible
  if (process.platform === "linux") {
    // Set memory limit
    await setResourceLimit(session.browserPid, {
      as: 512 * 1024 * 1024,  // 512 MB address space
      rss: 256 * 1024 * 1024  // 256 MB RSS
    });

    // Set file descriptor limit
    await setFileDescriptorLimit(session.browserPid, 256);
  }

  // Set timeouts
  session.ttl = options.ttlMs;
  session.idleTimeout = options.idleTimeoutMs;
}
```

### Cleanup on session close

```typescript
async closeSession(sessionId) {
  const session = this.sessions.get(sessionId);

  // 1. Close context
  await session.context.close();

  // 2. Close browser process
  await session.browser.close();

  // 3. Verify process termination
  const isRunning = await isProcessRunning(session.browserPid);
  if (isRunning) {
    await forceKill(session.browserPid);
    await emitSecurityEvent("process_had_to_be_killed", { sessionId });
  }

  // 4. Cleanup temp files
  await cleanupTempDir(session.tempDir);

  // 5. Clear from tracking
  this.sessions.delete(sessionId);
}
```

### Tier selection policy

```typescript
function selectIsolationTier(tenant, options) {
  // Local dev: context isolation
  if (process.env.NODE_ENV === "development" &&
      process.env.AGENTBROWSER_HOSTED !== "true") {
    return "context";
  }

  // Hosted: process isolation minimum
  if (tenant.isolation === "default") {
    return "process";
  }

  // Premium: container isolation
  if (tenant.isolation === "high") {
    return "container";
  }

  // Compliance required: strongest available
  if (tenant.requiresCompliance) {
    return "container"; // or microvm in future
  }

  return "process";
}
```

### Monitoring per session

```typescript
async monitorSessionResources(session) {
  const stats = await getProcessStats(session.browserPid);

  await emitMetrics({
    sessionId: session.id,
    isolationTier: session.isolationTier,
    cpuPercent: stats.cpu,
    memoryMb: stats.memoryMb,
    fileDescriptors: stats.fds,
    threadCount: stats.threads
  });

  // Enforce limits
  if (stats.memoryMb > SESSION_MEMORY_LIMIT) {
    await terminateSession(session.id, "memory_limit_exceeded");
  }
}
```

### Validation criteria

- Process isolation prevents memory access between sessions
- One session crash doesn't affect others
- Can set per-process resource limits
- Cleanup terminates all processes
- Local dev uses context isolation
- Hosted uses process isolation minimum
