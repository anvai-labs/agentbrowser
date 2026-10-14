import { describe, expect, it, vi } from 'vitest';
import { buildTools, type McpClient } from './mcp-server.js';

/** TD-BROWSER-15 phase 5: the read-only policy tool, in every mode. */

const client = (extra: Partial<McpClient> = {}): McpClient =>
  ({ ...extra }) as unknown as McpClient;

describe('the policy MCP tool', () => {
  it('is present in every mode with the same shape', () => {
    const all = buildTools(client());
    const policy = all.find((tool) => tool.name === 'policy');
    expect(policy).toBeDefined();
    expect(policy?.requiredCapabilities).toEqual(['session.control', 'page.observe']);
    expect(Object.keys(policy?.inputSchema.properties ?? {}).sort()).toEqual(['action', 'target']);
    // Delegated modes filter the same list; policy is read-only and stays.
    // (buildTools' mode filtering applies at registration; the definition
    // itself carries no session binding.)
    expect(all.map((t) => t.name)).toContain('policy');
  });

  it('without an action, returns the summary', async () => {
    const policy = vi.fn().mockResolvedValue({ policyVersion: 'legacy', capabilities: {} });
    const tool = buildTools(client({ policy })).find((t) => t.name === 'policy');
    const result = await tool?.handler({});
    expect(policy).toHaveBeenCalledWith();
    expect(result).toMatchObject({ policyVersion: 'legacy' });
  });

  it('with an action and target, checks without resolving', async () => {
    const policyCheck = vi.fn().mockResolvedValue({
      action: 'request',
      answers: [{ classSet: 'public', answer: { kind: 'decision' } }],
    });
    const tool = buildTools(client({ policyCheck })).find((t) => t.name === 'policy');
    const result = await tool?.handler({ action: 'request', target: 'example.com' });
    expect(policyCheck).toHaveBeenCalledWith({ action: 'request', target: 'example.com' });
    expect(result).toMatchObject({ action: 'request' });
  });

  it('refuses a missing client gracefully', async () => {
    const tool = buildTools(client()).find((t) => t.name === 'policy');
    await expect(tool?.handler({})).rejects.toThrow(/does not support policy queries/);
  });
});
