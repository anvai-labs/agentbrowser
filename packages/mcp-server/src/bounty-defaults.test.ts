import { expect, it, vi } from 'vitest';
import { buildTools, type McpClient } from './mcp-server.js';

it('forwards the bounty profile default and explicit request to session creation', async () => {
  for (const mode of [undefined, 'bounty'] as const) {
    const create = vi.fn(async () => ({ sessionId: 's' }));
    const client = {
      sessions: { create, createPage: async () => ({ pageId: 'p' }) },
    } as unknown as McpClient;
    const tool = buildTools(client, undefined, undefined, mode).find((t) => t.name === 'create')!;
    await tool.handler({ tenantId: 'local', ...(mode ? {} : { mode: 'bounty' }) });
    expect(create).toHaveBeenCalledWith({ tenantId: 'local', mode: 'bounty' });
    expect(
      buildTools(client).some((t) => t.name.includes('evidence') || t.name.includes('scope_amend'))
    ).toBe(false);
  }
});
