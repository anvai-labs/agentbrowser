#!/usr/bin/env node
/**
 * MCP server entrypoint: newline-delimited JSON-RPC over stdio.
 *
 * Run directly, or point an MCP client at it:
 *   victor: await client.connect(['node', 'dist/bin.js'])
 */

import { createInterface } from 'node:readline';
import { AgentBrowserClient } from '@agentbrowser/sdk-typescript';
import { buildMcpServer } from './mcp-server.js';

const server = buildMcpServer({
  createClient: (options) => new AgentBrowserClient(options),
  baseUrl: process.env.AGENTBROWSER_BASE_URL,
  serverInfo: { name: 'agentbrowser', version: '1.0.0' },
});

const rl = createInterface({ input: process.stdin });

rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) {
    return;
  }

  server
    .handle(trimmed)
    .then((response) => {
      if (response !== null) {
        process.stdout.write(`${response}\n`);
      }
    })
    .catch((error) => {
      // The handler itself never rejects, but a transport-level failure must
      // still be visible rather than silently dropped.
      process.stderr.write(`mcp: unhandled error: ${error}\n`);
    });
});

rl.on('close', () => {
  process.exit(0);
});
