/**
 * Approval Gates
 *
 * Token-based approval workflow for high-risk actions with
 * automatic expiration, validation, and usage tracking.
 */

import { createHash, randomUUID } from 'node:crypto';
import { canonicalJson } from './canonical-json.js';
import type { StructuredLogger } from './logger.js';

const LOW_RISK_ACTIONS = new Set<string>(['observe', 'navigate', 'scroll', 'press']);

export interface ApprovalGateOptions {
  tokenTtlMs?: number;
  maxTokens?: number;
  cleanupIntervalMs?: number;
  /**
   * Structured log for the background cleanup path (hygiene G2): absent
   * means silent-if-uninjected, matching the service's own convention for
   * optional telemetry - there is deliberately no console fallback.
   */
  logger?: StructuredLogger;
}

export interface ApprovalActionRequest {
  type: string;
  effect?: string;
  target?: { ref?: string };
  value?: string;
  pageId?: string;
  revision?: number;
  url?: string;
  identity?: string;
  parameters?: Record<string, unknown>;
}

export interface ApprovalRequest {
  sessionId: string;
  action: ApprovalActionRequest;
}

export interface ApprovalToken {
  tokenId: string;
  sessionId: string;
  actionFingerprint: string;
  status: 'pending' | 'used' | 'expired';
  createdAt: number;
  expiresAt: number;
  usedAt?: number;
}

export class ApprovalError extends Error {
  constructor(
    public code: string,
    message: string,
    public retryable = false,
    public details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'ApprovalError';
  }
}

/**
 * Approval Gate for high-risk action authorization
 */
export class ApprovalGate {
  private readonly options: Required<Omit<ApprovalGateOptions, 'logger'>>;
  private readonly logger: StructuredLogger | undefined;
  private readonly tokens: Map<string, ApprovalToken> = new Map();
  /**
   * Session -> token id index (TD-BROWSER-9, A6): keeps getSessionTokens()
   * O(1) instead of an O(n) scan over every token. Must be kept consistent
   * with `tokens` on every create/expire/cleanup - the one place a bug here
   * could reintroduce drift, hence the dedicated consistency test.
   */
  private readonly sessionIndex: Map<string, Set<string>> = new Map();
  private cleanupTimer?: NodeJS.Timeout;
  private closed = false;

  // High-risk action patterns
  private readonly HIGH_RISK_PATTERNS = [
    { effect: 'transaction' },
    { effect: 'account_change' },
    { type: 'click', effect: 'transaction' },
    { type: 'fill', effect: 'account_change' },
    { type: 'select', effect: 'transaction' },
  ];

  constructor(options: ApprovalGateOptions = {}) {
    this.options = {
      tokenTtlMs: options.tokenTtlMs ?? 300000, // 5 minutes default
      maxTokens: options.maxTokens ?? 1000,
      cleanupIntervalMs: options.cleanupIntervalMs ?? 60000, // 1 minute default
    };
    this.logger = options.logger;

    // Validate configuration
    if (!Number.isSafeInteger(this.options.tokenTtlMs) || this.options.tokenTtlMs <= 0) {
      throw new Error('tokenTtlMs must be positive');
    }

    if (!Number.isSafeInteger(this.options.maxTokens) || this.options.maxTokens <= 0) {
      throw new Error('maxTokens must be positive');
    }

    // Start cleanup timer
    this.startCleanupTimer();
  }

  /**
   * Check if an action requires approval
   */
  async isApprovalRequired(action: ApprovalActionRequest): Promise<boolean> {
    // Low-risk actions that don't require approval
    if (LOW_RISK_ACTIONS.has(action.type)) {
      return false;
    }

    // Check if action matches high-risk patterns
    for (const pattern of this.HIGH_RISK_PATTERNS) {
      const matches = Object.entries(pattern).every(
        ([key, value]) => action[key as keyof ApprovalActionRequest] === value
      );

      if (matches) {
        return true;
      }
    }

    // Default to safe - require approval for unknown actions
    return true;
  }

  /**
   * Generate an approval token
   */
  async generateApprovalToken(request: ApprovalRequest): Promise<ApprovalToken> {
    this.assertOpen();
    const binding = this.snapshotBinding(request);

    // Check token limit and clean up if needed
    if (this.tokens.size >= this.options.maxTokens) {
      await this.runCleanup();
    }
    this.assertOpen();
    // Check again after cleanup. There is no await between this admission
    // decision and insertion, so concurrent callers cannot over-admit.
    if (this.tokens.size >= this.options.maxTokens) {
      throw new ApprovalError('QUOTA_EXCEEDED', 'Approval token capacity reached', false, {
        maxTokens: this.options.maxTokens,
      });
    }

    const tokenId = this.generateTokenId();
    const now = Date.now();
    const token: ApprovalToken = {
      tokenId,
      ...binding,
      status: 'pending',
      createdAt: now,
      expiresAt: now + this.options.tokenTtlMs,
    };

    this.tokens.set(tokenId, token);
    const sessionTokenIds = this.sessionIndex.get(binding.sessionId) ?? new Set<string>();
    sessionTokenIds.add(tokenId);
    this.sessionIndex.set(binding.sessionId, sessionTokenIds);

    return { ...token };
  }

  /**
   * Validate an approval token
   */
  async validateApprovalToken(tokenId: string, request: ApprovalRequest): Promise<boolean> {
    const binding = this.snapshotBinding(request);
    return this.matchingToken(tokenId, binding, Date.now()) !== undefined;
  }

  /** Validate current binding/expiry and burn without yielding; a probe never reserves consent. */
  async consumeApprovalToken(tokenId: string, request: ApprovalRequest): Promise<boolean> {
    // Proxy inspection can reenter the gate. Finish it BEFORE reading current token state.
    const binding = this.snapshotBinding(request);
    const now = Date.now();
    const token = this.matchingToken(tokenId, binding, now);
    if (!token) return false;
    token.status = 'used';
    token.usedAt = now;
    return true;
  }

  /**
   * Legacy trusted-owner burn. Authorization paths must use consumeApprovalToken.
   */
  async useApprovalToken(tokenId: string): Promise<void> {
    const now = Date.now();
    const token = this.pendingToken(tokenId, now);
    if (!token)
      throw new ApprovalError('INVALID_TOKEN', 'Token is not live and pending', false, { tokenId });
    token.status = 'used';
    token.usedAt = now;
  }

  /**
   * Get token by ID
   */
  async getToken(tokenId: string): Promise<ApprovalToken | undefined> {
    const token = this.tokens.get(tokenId);

    if (token) this.expire(token, Date.now());
    return token ? { ...token } : undefined;
  }

  /**
   * Get all tokens for a session (TD-BROWSER-9, A6: O(1) via the session
   * index rather than a full scan of every token).
   */
  async getSessionTokens(sessionId: string): Promise<ApprovalToken[]> {
    const tokenIds = this.sessionIndex.get(sessionId);
    if (!tokenIds) {
      return [];
    }

    const now = Date.now();
    const sessionTokens: ApprovalToken[] = [];
    for (const tokenId of tokenIds) {
      const token = this.tokens.get(tokenId);
      // Skip expired tokens (and tolerate an index entry outliving its token,
      // though runCleanup keeps that from happening in normal operation).
      if (token) this.expire(token, now);
      if (token && token.status !== 'expired' && now < token.expiresAt) {
        sessionTokens.push({ ...token });
      }
    }

    return sessionTokens;
  }

  /**
   * Get current token count
   */
  getTokenCount(): number {
    return this.tokens.size;
  }

  /**
   * Shutdown approval gate
   */
  async shutdown(): Promise<void> {
    this.closed = true;
    // Stop cleanup timer
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
    }

    // Clear all tokens
    this.tokens.clear();
    this.sessionIndex.clear();
  }

  /**
   * Start cleanup timer
   */
  private startCleanupTimer(): void {
    this.cleanupTimer = setInterval(() => {
      this.runCleanup().catch((error) => {
        this.logger?.error('approval.cleanup-failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }, this.options.cleanupIntervalMs);
  }

  /**
   * Run cleanup pass to remove expired tokens
   */
  private async runCleanup(): Promise<void> {
    const now = Date.now();

    // Remove expired tokens in a single pass, keeping the session index
    // consistent with the primary map.
    for (const [tokenId, token] of this.tokens.entries()) {
      if (now >= token.expiresAt || token.status === 'used' || token.status === 'expired') {
        this.tokens.delete(tokenId);
        const sessionTokenIds = this.sessionIndex.get(token.sessionId);
        if (sessionTokenIds) {
          sessionTokenIds.delete(tokenId);
          if (sessionTokenIds.size === 0) {
            this.sessionIndex.delete(token.sessionId);
          }
        }
      }
    }
  }

  /**
   * Generate unique token ID
   */
  private generateTokenId(): string {
    return `tok_${randomUUID()}`;
  }

  /**
   * Generate action fingerprint for validation
   */
  private snapshotBinding(
    request: ApprovalRequest
  ): Pick<ApprovalToken, 'sessionId' | 'actionFingerprint'> {
    try {
      const detached = JSON.parse(canonicalJson(request)) as ApprovalRequest;
      if (
        !detached ||
        typeof detached.sessionId !== 'string' ||
        !detached.sessionId.length ||
        detached.sessionId.length > 255 ||
        !detached.action ||
        typeof detached.action.type !== 'string' ||
        !detached.action.type.length ||
        detached.action.type.length > 128
      )
        throw new Error('Invalid binding');
      return {
        sessionId: detached.sessionId,
        actionFingerprint: `${detached.action.type}:${createHash('sha256').update(canonicalJson(detached.action)).digest('hex')}`,
      };
    } catch {
      throw new ApprovalError(
        'INVALID_REQUEST',
        'Approval request must be bounded JSON with a sessionId and action.type'
      );
    }
  }

  private expire(token: ApprovalToken, now: number): void {
    if (token.status === 'pending' && now >= token.expiresAt) token.status = 'expired';
  }

  private pendingToken(tokenId: string, now: number): ApprovalToken | undefined {
    const token = this.tokens.get(tokenId);
    if (!token) return undefined;
    this.expire(token, now);
    return token.status === 'pending' ? token : undefined;
  }

  private matchingToken(
    tokenId: string,
    binding: Pick<ApprovalToken, 'sessionId' | 'actionFingerprint'>,
    now: number
  ): ApprovalToken | undefined {
    const token = this.pendingToken(tokenId, now);
    return token?.sessionId === binding.sessionId &&
      token.actionFingerprint === binding.actionFingerprint
      ? token
      : undefined;
  }

  private assertOpen(): void {
    if (this.closed) throw new ApprovalError('INVALID_TOKEN', 'Approval gate is closed');
  }

  /**
   * Update configuration
   */
  updateConfig(options: Partial<ApprovalGateOptions>): void {
    if (
      options.tokenTtlMs !== undefined &&
      (!Number.isSafeInteger(options.tokenTtlMs) || options.tokenTtlMs <= 0)
    ) {
      throw new Error('tokenTtlMs must be positive');
    }

    if (
      options.maxTokens !== undefined &&
      (!Number.isSafeInteger(options.maxTokens) || options.maxTokens <= 0)
    ) {
      throw new Error('maxTokens must be positive');
    }

    Object.assign(this.options, options);

    // Restart cleanup timer with new interval
    if (!this.closed && this.cleanupTimer && options.cleanupIntervalMs) {
      clearInterval(this.cleanupTimer);
      this.startCleanupTimer();
    }
  }

  /**
   * Get current configuration
   */
  getConfig(): Readonly<Required<Omit<ApprovalGateOptions, 'logger'>>> {
    return { ...this.options };
  }
}
