import {
  DELIVERED_WAIT_TYPES,
  ObservationRequestSchema,
  ScreenshotRequestSchema,
} from '@agentbrowser/protocol';
import { describe, expect, it, vi } from 'vitest';
import { type McpClient, buildTools } from './mcp-server.js';

describe.each(['observe', 'screenshot'] as const)(
  'MCP %s canonical capture contract',
  (operation) => {
    const setup = () => {
      const invoke = vi.fn().mockResolvedValue({});
      const tool = buildTools({ sessions: { [operation]: invoke } } as unknown as McpClient).find(
        (tool) => tool.name === `browser_${operation}`
      );
      if (!tool) throw new Error('Missing tool');
      return { invoke, tool };
    };
    it.each(DELIVERED_WAIT_TYPES)('forwards %s with its required fields', async (until) => {
      const { invoke, tool } = setup();
      const wait = {
        until,
        timeoutMs: 250,
        ...(until === 'minElements' ? { count: 2 } : {}),
        ...(until === 'urlPattern' ? { pattern: '**/ready' } : {}),
        ...(until === 'selectorVisible' ? { selector: '#ready' } : {}),
      };
      const request =
        operation === 'observe'
          ? { wait, sinceRevision: 1, continueFrom: 0, include: ['formControls'] }
          : { wait, quality: 75, maskSensitive: true, fullPage: true, format: 'jpeg' };
      await tool.handler({ sessionId: 'ses_1', pageId: 'pg_1', ...request });
      expect(invoke).toHaveBeenCalledWith('ses_1', 'pg_1', request);
    });
    it.each([
      null,
      {},
      { until: 'bogus' },
      { until: 'minElements' },
      { until: 'minElements', count: 1.5 },
      { until: 'load', timeoutMs: 300001 },
      { until: 'selectorVisible', selector: '' },
    ])('rejects invalid wait %j before dispatch', async (wait) => {
      const { invoke, tool } = setup();
      await expect(tool.handler({ sessionId: 'ses_1', pageId: 'pg_1', wait })).rejects.toThrow(
        /Invalid capture request/
      );
      expect(invoke).not.toHaveBeenCalled();
    });
    it('shares nested constraints and required fields with the protocol schema', () => {
      const { tool } = setup();
      const canonical =
        operation === 'observe' ? ObservationRequestSchema : ScreenshotRequestSchema;
      const { sessionId, pageId, ...body } = tool.inputSchema.properties as Record<string, unknown>;
      expect(body).toEqual(canonical.properties);
      expect(tool.outputSchema).toBeDefined();
    });
  }
);
