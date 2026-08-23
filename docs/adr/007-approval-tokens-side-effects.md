# ADR-007: Approval Tokens Bound to Exact Side Effects

**Status:** Accepted
**Context:** 2025-01-23
**Superseded by:** N/A

## Context

Agents executing actions on websites can cause irreversible changes:
- **Financial transactions**: Purchases, transfers, subscriptions
- **Destructive actions**: Delete, cancel, revoke
- **Account changes**: Password, MFA, permissions
- **External messages**: Send emails, post comments

Without human oversight, agents can:
- Make accidental purchases
- Delete important data
- Send unintended messages
- Expose the user to financial loss

The system must provide a safety mechanism for high-risk actions while allowing low-risk automation to proceed automatically.

## Decision

**Classify actions by effect; require approval for high-risk actions using single-use, short-lived tokens.**

### Action classification

```typescript
type ActionEffect =
  | "read"              // Navigation, observation, extraction (always safe)
  | "write-local"       // Form edits not yet submitted (low risk)
  | "external-message"   // Send email/chat/comment (medium risk)
  | "transaction"       // Purchase, booking, subscription, trade (high risk)
  | "account-security"  // Password, MFA, permissions (high risk)
  | "destructive"       // Delete, cancel, revoke (high risk)
```

### Approval flow

```typescript
// 1. Agent attempts high-risk action
POST /v1/sessions/{id}/actions
{
  "action": { "type": "click", "target": { "ref": "e17_09" } },
  "context": { "effect": "transaction" }
}

// 2. System detects high-risk, returns approval request
Response: 403 APPROVAL_REQUIRED
{
  "error": {
    "code": "APPROVAL_REQUIRED",
    "approvalRequest": {
      "id": "apr_01...",
      "action": { "type": "click", "target": { "ref": "e17_09" } },
      "effect": "transaction",
      "pageFingerprint": "...",
      "expiresAt": "2025-01-23T12:35:00Z",
      "digest": "sha256:..."
    }
  }
}

// 3. Human reviews and approves
POST /v1/approvals
{
  "approvalId": "apr_01...",
  "approved": true,
  "signature": "..."  // Cryptographic signature
}

// 4. Agent retries with approval token
POST /v1/sessions/{id}/actions
{
  "action": { "type": "click", "target": { "ref": "e17_09" } },
  "approvalToken": "tok_01..."
}

// 5. System validates token and executes
```

### Approval token properties

- **Single-use**: Token becomes invalid after first use
- **Short-lived**: Tokens expire in 5-15 minutes
- **Bound to exact action**: Hash of action + page + revision
- **Non-transferable**: Tied to specific session and tenant
- **Auditable**: All approvals logged

## Consequences

### Positive
- **Safety**: Humans must approve risky actions
- **Flexibility**: Safe actions proceed automatically
- **Audit trail**: All approvals are logged
- **Customizable**: Policy can define what requires approval

### Negative
- **Latency**: High-risk actions require human intervention
- **Complexity**: Approval workflow adds implementation overhead
- **User experience**: Friction for high-risk automation

### Trade-offs
- Safety over automation speed
- Human oversight for irreversible actions
- Automatic approval for safe read operations

## Rationale

### Why effect-based classification

1. **Risk-aligned**: Dangerous actions get scrutiny
2. **Agent autonomy**: Safe actions proceed unimpeded
3. **Policy flexibility**: Different tenants can set different thresholds
4. **Clear semantics**: Effect name describes the risk

### Why approval tokens

1. **Cryptographic binding**: Token only works for exact action
2. **Single-use**: Can't replay approval for different action
3. **Expiry**: Time-bounded window for approval
4. **Non-transferable**: Can't use approval for different session

### Why high-risk categories matter

1. **Financial**: Transactions can cost money
2. **Destructive**: Deletions are irreversible
3. **Account**: Security changes are catastrophic
4. **External**: Messages affect real people

### Alternative considered: No approvals, trust the agent
**Rejected** because:
- Single agent bug can cause financial loss
- No human override for mistakes
- Unacceptable liability
- Violates principle of least surprise

### Alternative considered: Approve everything
**Rejected** because:
- Defeats the purpose of agent automation
- Impractical at scale
- Human becomes bottleneck
- Safe actions don't need approval

### Alternative considered: Block high-risk actions entirely
**Rejected** because:
- Prevents legitimate use cases
- Too restrictive
- Users will find unsafe workarounds
- Approval is better than prohibition

## Related Decisions

- **ADR-006**: Network egress policy - complements security model
- **Spec Section 14.5**: Approval gates and action classification

## Implementation Notes

### Policy configuration

```typescript
interface ApprovalPolicy {
  // Require approval for these effect types
  requireApprovalFor: ActionEffect[];

  // Auto-approve these effect types
  autoApprove: ActionEffect[];

  // Approval token TTL
  approvalTtlMs: number;

  // Max number of pending approvals per session
  maxPendingApprovals: number;

  // Require approval for specific domains
  domainOverrides: Record<string, ActionEffect[]>;
}

// Default policy:
const DEFAULT_POLICY: ApprovalPolicy = {
  requireApprovalFor: [
    "transaction",
    "account-security",
    "destructive",
    "external-message"
  ],
  autoApprove: [
    "read",
    "write-local"
  ],
  approvalTtlMs: 900000,  // 15 minutes
  maxPendingApprovals: 10
};
```

### Effect detection

```typescript
async classifyAction(action, pageContext): Promise<ActionEffect> {
  // Check if action is on known risky element
  const element = await resolveElement(action.target);

  // Check for destructive keywords
  if (MATCHES_DESTRUCTIVE.test(element.name)) {
    return "destructive";
  }

  // Check for transaction indicators
  if (pageContext.url.includes("checkout") ||
      element.name.includes("purchase") ||
      element.name.includes("buy")) {
    return "transaction";
  }

  // Check for account security
  if (pageContext.url.includes("account") ||
      element.name.includes("password") ||
      element.name.includes("mfa")) {
    return "account-security";
  }

  // Check for external messaging
  if (element.formAction.includes("mailto:") ||
      element.formAction.includes("api/send")) {
    return "external-message";
  }

  // Default: safe
  return "write-local";
}
```

### Approval token generation

```typescript
async generateApprovalToken(request): Promise<string> {
  const payload = {
    sessionId: request.sessionId,
    pageId: request.pageId,
    revision: request.revision,
    actionHash: hashAction(request.action),
    pageFingerprint: request.pageFingerprint,
    expiresAt: Date.now() + policy.approvalTtlMs
  };

  // Sign with tenant secret
  const token = await sign(payload, tenantSecret);

  // Store for validation
  await approvalStore.set(token, payload, { ttl: policy.approvalTtlMs });

  return token;
}
```

### Token validation

```typescript
async validateApprovalToken(token, action, page): Promise<boolean> {
  const payload = await approvalStore.get(token);
  if (!payload) {
    throw new Error("Invalid or expired approval token");
  }

  // Verify binding
  if (payload.sessionId !== page.sessionId) return false;
  if (payload.pageId !== page.id) return false;
  if (payload.revision !== page.revision) return false;
  if (payload.actionHash !== hashAction(action)) return false;

  // Mark as used (single-use)
  await approvalStore.delete(token);

  return true;
}
```

### MCP integration

```typescript
// MCP tools should detect high-risk actions and request approval
async browser_act(params, context) {
  const effect = await classifyAction(params.action, context.page);

  if (policy.requiresApproval(effect)) {
    // Request approval from user
    const approval = await context.requestApproval({
      action: params.action,
      effect,
      reason: `Action may cause ${effect}`
    });

    if (!approval.approved) {
      return { error: "APPROVAL_DENIED", approvalRequest: approval.request };
    }

    params.approvalToken = approval.token;
  }

  return await executeAction(params);
}
```

### Validation criteria

- Read actions never require approval
- Transaction actions always require approval
- Approval token is single-use
- Approval token expires after TTL
- Approval token bound to exact action
- Can't reuse approval for different action
- All approvals logged
