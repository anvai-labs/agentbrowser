import { SessionCoordinator } from '@agentbrowser/core';
import { FakeEngine } from '@agentbrowser/testkit';
import { describe, expect, it, vi } from 'vitest';
import { AgentBrowserService } from './service.js';

class ReplacingCoordinator extends SessionCoordinator {
  replacement: ReturnType<SessionCoordinator['captureForCleanup']>;

  override async createOwned(...args: Parameters<SessionCoordinator['createOwned']>) {
    const original = await super.createOwned(...args);
    await this.close(original.response.sessionId, 'replace-before-return');
    await super.createOwned(...args);
    this.replacement = this.captureForCleanup(original.response.sessionId);
    return original;
  }
}

describe('session creation allocation identity', () => {
  it('cannot publish or discard a replacement installed before the allocation result returns', async () => {
    const coordinator = new ReplacingCoordinator({ now: () => 1000 });
    vi.spyOn(
      coordinator as unknown as { generateSessionId(): string },
      'generateSessionId'
    ).mockReturnValue('same-id');
    const service = new AgentBrowserService({ engine: new FakeEngine(), coordinator });
    try {
      await expect(service.createSession({ tenantId: 'owner' })).rejects.toThrow(
        'Session ended during creation'
      );
      expect(coordinator.captureForCleanup('same-id')).toBe(coordinator.replacement);
      expect(coordinator.replacement?.signal.aborted).toBe(false);
    } finally {
      await service.shutdown();
    }
  });
});
