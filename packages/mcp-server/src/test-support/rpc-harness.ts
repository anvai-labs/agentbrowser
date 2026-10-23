import { buildMcpServer, type McpClient } from '../mcp-server.js';

/**
 * The scaffold every offline MCP tool suite shares: a server over a stub client, plus
 * the JSON-RPC `request` (raw response string, explicit id) and `exchange` (parsed,
 * id 1) drivers. Suite-specific — the client stub and the tool each suite's `call`
 * shortcut targets — stay in the suite.
 */
export function rpcHarness(client: unknown, options: Parameters<typeof buildMcpServer>[0] = {}) {
  const server = buildMcpServer({
    createClient: () => client as McpClient,
    ...options,
  });
  const request = (id: string, method: string, params: unknown = {}) =>
    server.handle(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
  const exchange = async (method: string, params: unknown = {}) => {
    const response = await request('1', method, params);
    if (!response) throw new Error('Missing MCP response');
    return JSON.parse(response);
  };
  return { server, request, exchange };
}
