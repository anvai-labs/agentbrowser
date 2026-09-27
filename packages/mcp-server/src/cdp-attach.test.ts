import { expect, it, vi } from 'vitest';
import { type McpClient, buildTools } from './mcp-server.js';

it('advertises and forwards only the configured attach selector', async () => {
  const create = vi.fn(async () => ({ sessionId: 's', diagnostics: { attachment: 'cdp_attach' } }));
  const tool = buildTools({
    sessions: { create, createPage: async () => ({ pageId: 'p' }) },
  } as unknown as McpClient).find((tool) => tool.name === 'browser_create');
  expect(tool?.inputSchema).toMatchObject({ properties: { cdpAttach: { type: 'boolean' } } });
  const result = await tool?.handler({ tenantId: 'local', cdpAttach: true });
  expect(create).toHaveBeenCalledWith({ tenantId: 'local', cdpAttach: true });
  expect(result).toMatchObject({ diagnostics: { attachment: 'cdp_attach' }, pageId: 'p' });
});

it('releases the newly created session if initial page provisioning fails', async () => {
  const failure = new Error('Page provisioning failed');
  const close = vi.fn(async () => {});
  const tool = buildTools({
    sessions: {
      create: async () => ({ sessionId: 'new-session' }),
      createPage: async () => {
        throw failure;
      },
      close,
    },
  } as unknown as McpClient).find((tool) => tool.name === 'browser_create');
  await expect(tool?.handler({ tenantId: 'local', cdpAttach: true })).rejects.toBe(failure);
  expect(close).toHaveBeenCalledTimes(1);
  expect(close).toHaveBeenCalledWith('new-session');
});
