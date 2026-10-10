// windows-mcp-e2e.test.mjs — full-stack win32 roundtrip through the real
// MCP server binary: initialize -> tools/list -> create (headless)
// -> observe -> close.
//
// This is the test class that would have caught the WSL interop failures
// (UNC cwd, .cmd relay) before users hit them: it exercises the actual
// server process, the engine spawn, and Playwright browser discovery on
// Windows — not just protocol plumbing.
//
// Browser policy mirrors windows-ci.yml: system Chrome when present,
// otherwise PLAYWRIGHT_BROWSERS_PATH (set by the runner provisioning step).
// Skips on non-Windows so the file can live in the shared scripts dir.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const IS_WIN = process.platform === 'win32';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MCP_BIN = join(ROOT, 'packages', 'mcp-server', 'dist', 'bin.js');
const NODE = process.execPath;

class McpClient {
  constructor() {
    this.nextId = 1;
    this.pending = new Map();
    this.buf = '';
    this.child = null;
  }
  start() {
    this.child = spawn(NODE, [MCP_BIN], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stdout.on('data', (d) => this.#ingest(d));
    this.child.stderr.on('data', (d) => process.stderr.write(`[mcp-server] ${d}`));
    return this.child;
  }
  #ingest(chunk) {
    this.buf += chunk;
    let nl;
    while ((nl = this.buf.indexOf('\n')) !== -1) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (!line.startsWith('{')) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id && this.pending.has(msg.id)) {
          const { resolve, reject } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          if (msg.error) reject(new Error(JSON.stringify(msg.error)));
          else resolve(msg.result);
        }
      } catch { /* mid-line */ }
    }
  }
  request(method, params, timeoutMs = 45000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timeout after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
  call(tool, args) { return this.request('tools/call', { name: tool, arguments: args }); }
  stop() { this.child?.kill(); }
}

test('MCP end-to-end: create -> observe -> close on win32', { skip: !IS_WIN && 'windows-only' }, async (t) => {
  assert.ok(existsSync(MCP_BIN), `built MCP entry missing: ${MCP_BIN} — run pnpm -r build first`);
  const c = new McpClient();
  t.after(() => c.stop());
  c.start();

  const init = await c.request('initialize', {
    protocolVersion: '2024-11-05', capabilities: {},
    clientInfo: { name: 'win-e2e', version: '0.0.0' },
  });
  assert.ok(init.serverInfo, 'initialize returns serverInfo');
  c.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

  const tools = await c.request('tools/list', {});
  const names = (tools.tools || []).map((x) => x.name);
  for (const expected of ['create', 'observe', 'close']) {
    assert.ok(names.includes(expected), `tools/list must expose ${expected} (have ${names.length} tools)`);
  }

  const created = await c.call('create', {
    tenantId: 'win-ci-e2e',
    headless: true,
    ttlMs: 120000,
    idleTimeoutMs: 120000,
  });
  const text = (created.content || []).map((p) => p.text || '').join('');
  const createdJson = (() => { try { return JSON.parse(text || '{}'); } catch { return {}; } })();
  const sessionId = created.sessionId ?? createdJson.sessionId;
  assert.ok(sessionId, `create must return sessionId (text=${text.slice(0, 200)})`);
  const pageId = created.pageId ?? createdJson.pageId;
  assert.ok(pageId, 'create must return pageId');

  const observed = await c.call('observe', { sessionId, pageId });
  assert.ok(observed, 'observe must answer');
  // An empty about:blank observation is still a structured result; the gate
  // is that the engine spawned and the roundtrip completed without error.

  await c.call('close', { sessionId });
});
