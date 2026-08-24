/**
 * Approval Gates
 *
 * Token-based approval workflow for high-risk actions with
 * automatic expiration, validation, and usage tracking.
 */

const LOW_RISK_ACTIONS = new Set<string>(['observe', 'navigate', 'scroll', 'press']);

export interface ApprovalGateOptions {
  tokenTtlMs?: number;
  maxTokens?: number;
  cleanupIntervalMs?: number;
}

export interface ApprovalActionRequest {
  type: string;
  effect?: string;
  target?: { ref?: string };
  value?: string;
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
  private readonly options: Required<ApprovalGateOptions>;
  private readonly tokens: Map<string, ApprovalToken> = new Map();
  private cleanupTimer?: NodeJS.Timeout;

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

    // Validate configuration
    if (this.options.tokenTtlMs <= 0) {
      throw new Error('tokenTtlMs must be positive');
    }

    if (this.options.maxTokens <= 0) {
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
    const tokenId = this.generateTokenId();
    const actionFingerprint = this.generateActionFingerprint(request.action);
    const now = Date.now();

    // Check token limit and clean up if needed
    if (this.tokens.size >= this.options.maxTokens) {
      await this.runCleanup();
    }

    const token: ApprovalToken = {
      tokenId,
      sessionId: request.sessionId,
      actionFingerprint,
      status: 'pending',
      createdAt: now,
      expiresAt: now + this.options.tokenTtlMs,
    };

    this.tokens.set(tokenId, token);

    return token;
  }

  /**
   * Validate an approval token
   */
  async validateApprovalToken(tokenId: string, request: ApprovalRequest): Promise<boolean> {
    const token = this.tokens.get(tokenId);

    if (!token) {
      return false;
    }

    // Check if token is expired
    if (Date.now() > token.expiresAt) {
      token.status = 'expired';
      return false;
    }

    // Check if token has been used
    if (token.status === 'used') {
      return false;
    }

    // Check if token is for the correct session
    if (token.sessionId !== request.sessionId) {
      return false;
    }

    // Check if token is for the correct action
    const requestFingerprint = this.generateActionFingerprint(request.action);
    if (token.actionFingerprint !== requestFingerprint) {
      return false;
    }

    return true;
  }

  /**
   * Use an approval token (mark as consumed)
   */
  async useApprovalToken(tokenId: string): Promise<void> {
    const token = this.tokens.get(tokenId);

    if (!token) {
      throw new ApprovalError('INVALID_TOKEN', `Token not found: ${tokenId}`, false, { tokenId });
    }

    if (token.status === 'used') {
      throw new ApprovalError('INVALID_TOKEN', `Token already used: ${tokenId}`, false, {
        tokenId,
        status: token.status,
      });
    }

    token.status = 'used';
    token.usedAt = Date.now();
  }

  /**
   * Get token by ID
   */
  async getToken(tokenId: string): Promise<ApprovalToken | undefined> {
    const token = this.tokens.get(tokenId);

    // Return undefined if expired
    if (token && Date.now() > token.expiresAt) {
      token.status = 'expired';
    }

    return token;
  }

  /**
   * Get all tokens for a session
   */
  async getSessionTokens(sessionId: string): Promise<ApprovalToken[]> {
    const sessionTokens: ApprovalToken[] = [];

    for (const token of this.tokens.values()) {
      if (token.sessionId === sessionId) {
        // Skip expired tokens
        if (Date.now() <= token.expiresAt) {
          sessionTokens.push(token);
        }
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
    // Stop cleanup timer
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
    }

    // Clear all tokens
    this.tokens.clear();
  }

  /**
   * Start cleanup timer
   */
  private startCleanupTimer(): void {
    this.cleanupTimer = setInterval(() => {
      this.runCleanup().catch((error) => {
        console.error('Approval token cleanup error:', error);
      });
    }, this.options.cleanupIntervalMs);
  }

  /**
   * Run cleanup pass to remove expired tokens
   */
  private async runCleanup(): Promise<void> {
    const now = Date.now();

    // Remove expired tokens in a single pass
    for (const [tokenId, token] of this.tokens.entries()) {
      if (now > token.expiresAt || token.status === 'used') {
        this.tokens.delete(tokenId);
      }
    }
  }

  /**
   * Generate unique token ID
   */
  private generateTokenId(): string {
    return `tok_${Date.now()}_${Math.random().toString(36).substr(2, 16)}`;
  }

  /**
   * Generate action fingerprint for validation
   */
  private generateActionFingerprint(action: ApprovalActionRequest): string {
    const parts = [
      action.type,
      action.effect || '',
      action.target?.ref || '',
      action.value ? `value_${action.value}` : '',
    ];

    return parts.filter(Boolean).join(':');
  }

  /**
   * Update configuration
   */
  updateConfig(options: Partial<ApprovalGateOptions>): void {
    if (options.tokenTtlMs !== undefined && options.tokenTtlMs <= 0) {
      throw new Error('tokenTtlMs must be positive');
    }

    if (options.maxTokens !== undefined && options.maxTokens <= 0) {
      throw new Error('maxTokens must be positive');
    }

    Object.assign(this.options, options);

    // Restart cleanup timer with new interval
    if (this.cleanupTimer && options.cleanupIntervalMs) {
      clearInterval(this.cleanupTimer);
      this.startCleanupTimer();
    }
  }

  /**
   * Get current configuration
   */
  getConfig(): Readonly<Required<ApprovalGateOptions>> {
    return { ...this.options };
  }
}
