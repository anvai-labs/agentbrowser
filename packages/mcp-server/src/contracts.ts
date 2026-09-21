/**
 * Production assignment check. Member names/signatures are derived from the SDK
 * in McpClient; partial test stand-ins may still omit optional families.
 * scripts/sdk-client-contract.test.mjs proves renamed methods and narrowed
 * inputs fail at these real consumers, rather than relying on method variance.
 */
import type { AgentBrowserClient } from '@agentbrowser/sdk-typescript';
import type { McpClient } from './mcp-server.js';

export const sdkClientSatisfiesMcpClient =
  null as unknown as AgentBrowserClient satisfies McpClient;
