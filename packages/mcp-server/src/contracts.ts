/**
 * Type-level contract checks (ADR-015) for the MCP server's structural SDK
 * mirror — same pattern as packages/cli/src/contracts.ts.
 *
 * These live in a COMPILED source file deliberately: test files are excluded
 * from tsconfig and vitest does not type-check. `pnpm -r type-check` enforces
 * these — if the real SDK client and McpClient drift apart, this file stops
 * compiling. Direction is one-way: the real client satisfies the mirror.
 */

import type { AgentBrowserClient } from '@agentbrowser/sdk-typescript';
import type { McpClient } from './mcp-server.js';

export const sdkClientSatisfiesMcpClient =
  null as unknown as AgentBrowserClient satisfies McpClient;
