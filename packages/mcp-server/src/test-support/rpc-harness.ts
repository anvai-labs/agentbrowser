import { buildMcpServer, type McpClient } from '../mcp-server.js';

/**
 * The JSON-RPC drivers for the client-stub fixtures (events-replay, session-inspection,
 * page-provisioning): a server over the stub plus `request` (raw response string,
 * explicit id) and `exchange` (parsed, id 1). Suite-specific — the client stub and the
 * tool each suite's `call` shortcut targets — stay in the suite. The deps-based suites
 * (mcp-server.test, edges) deliberately keep their own two-line closure over a `let`
 * server they rebuild at several sites; `rpcDrivers` exists for either shape's future
 * needs.
 *
 * NOTE: src/test-support is excluded from the package tsconfig (the repo convention),
 * so this file is NOT type-checked — keep its types trivial.
 */
export function rpcHarness(client: unknown, options: Parameters<typeof buildMcpServer>[0] = {}) {
  const server = buildMcpServer({
    createClient: () => client as McpClient,
    ...options,
  });
  return { server, ...rpcDrivers(server) };
}

/** For deps-based suites that rebuild their server per test: bind the same drivers to
 * an existing server instance (call inside beforeEach, assigning to a `let`). */
export function rpcDrivers(server: ReturnType<typeof buildMcpServer>) {
  const request = (id: string, method: string, params: unknown = {}) =>
    server.handle(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
  const exchange = async (method: string, params: unknown = {}) => {
    const response = await request('1', method, params);
    if (!response) throw new Error('Missing MCP response');
    return JSON.parse(response);
  };
  return { request, exchange };
}
