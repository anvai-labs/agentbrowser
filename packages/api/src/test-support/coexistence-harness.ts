import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { buildMcpServer } from '../../../mcp-server/src/mcp-server.js';
import { AgentBrowserClient } from '../../../sdk-typescript/src/client.js';

type Result = ReturnType<typeof JSON.parse>;
export interface Harness {
  request(method: string, params?: Record<string, unknown>): Promise<Result>;
  close(): Promise<void>;
}

/** Test-only client of either actual stdio or the in-process comparison. */
export async function openHarness(options: {
  transport: 'in-process' | 'stdio' | 'victor';
  baseUrl: string;
  sessionId: string;
  token: string;
  requestTimeoutMs?: number;
}): Promise<Harness> {
  const requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
  if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > 60_000)
    throw new Error('Harness requestTimeoutMs must be an integer from 1 through 60000');
  let nextId = 0;
  if (options.transport === 'in-process') {
    const server = buildMcpServer({
      createClient: () =>
        new AgentBrowserClient({ baseUrl: options.baseUrl, apiKey: options.token }),
      sessionId: options.sessionId,
    });
    return {
      async request(method, params = {}) {
        const response = await server.handle(
          JSON.stringify({ jsonrpc: '2.0', id: ++nextId, method, params })
        );
        if (!response) throw new Error('Missing MCP response');
        const parsed = JSON.parse(response);
        if (parsed.error) throw new Error(parsed.error.message);
        return parsed.result;
      },
      close: async () => {},
    };
  }
  const root = fileURLToPath(new URL('../../../../', import.meta.url));
  const victor = options.transport === 'victor';
  const victorRoot = victor ? realpathSync(process.env.AGENTBROWSER_VICTOR_ROOT || '') : '';
  if (victor && !process.env.AGENTBROWSER_VICTOR_PYTHON)
    throw new Error('Set AGENTBROWSER_VICTOR_PYTHON to Victor’s Python environment');
  const child = spawn(
    victor ? process.env.AGENTBROWSER_VICTOR_PYTHON! : process.execPath,
    victor
      ? [resolve(root, 'scripts/victor-coexistence-bridge.py')]
      : [resolve(root, 'packages/mcp-server/dist/bin.js')],
    {
      cwd: root,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        AGENTBROWSER_BASE_URL: options.baseUrl,
        AGENTBROWSER_SESSION_ID: options.sessionId,
        AGENTBROWSER_API_KEY: options.token,
        AGENTBROWSER_VICTOR_ROOT: victorRoot,
        AGENTBROWSER_MCP_BINARY: resolve(root, 'packages/mcp-server/dist/bin.js'),
        AGENTBROWSER_NODE: process.execPath,
        PYTHONDONTWRITEBYTECODE: '1',
      },
    }
  );
  const pending = new Map<
    number,
    {
      resolve(value: Result): void;
      reject(error: Error): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  let terminal = false;
  let closed = false;
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr = (stderr + chunk.toString().split(options.token).join('[redacted]')).slice(-2048);
  });
  const fail = (error: Error) => {
    terminal = true;
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    pending.clear();
  };
  const exited = new Promise<void>((done) =>
    child.once('close', () => {
      closed = true;
      done();
    })
  );
  child.once('error', (error) => fail(error));
  child.once('close', (code) => fail(new Error(`Harness exited (${code}): ${stderr}`)));
  child.stdin.on('error', (error) => fail(error));
  const lines = createInterface({ input: child.stdout });
  lines.on('line', (line) => {
    try {
      const response = JSON.parse(line);
      if (response.id === undefined && response.method) return;
      const entry = pending.get(response.id);
      if (!entry) throw new Error('Unmatched harness response');
      pending.delete(response.id);
      clearTimeout(entry.timer);
      if (response.error) entry.reject(new Error(response.error.message));
      else entry.resolve(response.result);
    } catch (error) {
      fail(error instanceof Error ? error : new Error('Malformed harness response'));
    }
  });
  const signal = (value: NodeJS.Signals) => {
    if (closed || !child.pid) return;
    try {
      if (process.platform === 'win32') child.kill(value);
      else process.kill(-child.pid, value);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  };
  const harness: Harness = {
    request(method, params = {}) {
      if (terminal) return Promise.reject(new Error('Harness connection closed'));
      if (pending.size >= 8) return Promise.reject(new Error('Harness request capacity exceeded'));
      return new Promise((resolve, reject) => {
        const id = ++nextId;
        const timer = setTimeout(() => {
          fail(new Error(`Harness timeout: ${method}`));
          signal('SIGTERM');
        }, requestTimeoutMs);
        pending.set(id, { resolve, reject, timer });
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      });
    },
    async close() {
      fail(new Error('Harness connection closed'));
      child.stdin.end();
      const terminate = setTimeout(() => signal('SIGTERM'), 2000);
      const kill = setTimeout(() => signal('SIGKILL'), 4000);
      try {
        await exited;
      } finally {
        clearTimeout(terminate);
        clearTimeout(kill);
        lines.close();
      }
    },
  };
  try {
    const initialized = await harness.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'coexistence-acceptance', version: '1' },
    });
    if (
      victor &&
      initialized.harnessModule !==
        realpathSync(resolve(victorRoot, 'victor/integrations/mcp/client.py'))
    )
      throw new Error('Wrong Victor client imported');
    return harness;
  } catch (error) {
    await harness.close();
    throw error;
  }
}
