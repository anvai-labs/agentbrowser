#!/usr/bin/env node
/**
 * Stdio smoke test for a compiled agentbrowser-mcp binary (TD-BROWSER-5).
 *
 * A binary that compiles but cannot speak the protocol must not ship: this
 * drives the artifact itself over stdio and requires the full MCP handshake
 * plus the complete 6-tool catalog. No AgentBrowser server is needed — the
 * gate is deliberately protocol-level so it runs on any build runner.
 *
 * Usage: node scripts/smoke.mjs <path-to-binary>
 * Exit:  0 pass, 1 fail, 2 usage error.
 */

import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

const binary = process.argv[2];
if (!binary) {
  console.error('usage: node scripts/smoke.mjs <path-to-binary>');
  process.exit(2);
}

const EXPECTED_TOOLS = [
  'browser_create',
  'browser_close',
  'browser_cookies',
  'browser_navigate',
  'browser_observe',
  'browser_act',
  'browser_extract',
  'browser_pdf',
  'browser_screenshot',
];

const TIMEOUT_MS = 20_000;

const child = spawn(resolve(binary), [], { stdio: ['pipe', 'pipe', 'pipe'] });

let buffer = '';
const responses = new Map();

child.stdout.on('data', (chunk) => {
  buffer += chunk;
  let newline = buffer.indexOf('\n');
  while (newline >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line) {
      try {
        const message = JSON.parse(line);
        if (message.id !== undefined) {
          responses.set(message.id, message);
        }
      } catch {
        console.error(`smoke: unparseable stdout line: ${line}`);
      }
    }
    newline = buffer.indexOf('\n');
  }
});

child.stderr.on('data', (chunk) => process.stderr.write(`[binary stderr] ${chunk}`));

const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);

send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });

const timer = setTimeout(() => {
  console.error(`smoke: FAIL - no complete handshake within ${TIMEOUT_MS}ms`);
  child.kill();
  process.exit(1);
}, TIMEOUT_MS);

const waitFor = (id) =>
  new Promise((resolvePromise, reject) => {
    const started = Date.now();
    const poll = setInterval(() => {
      if (responses.has(id)) {
        clearInterval(poll);
        resolvePromise(responses.get(id));
      } else if (Date.now() - started > TIMEOUT_MS) {
        clearInterval(poll);
        reject(new Error(`no response for request ${id}`));
      }
    }, 25);
  });

try {
  const failures = [];

  const init = await waitFor(1);
  const initVersion = init?.result?.serverInfo?.version;
  const initProtocol = init?.result?.protocolVersion;
  if (init?.error || !initProtocol) {
    failures.push(`initialize failed: ${JSON.stringify(init?.error ?? 'no protocolVersion')}`);
  }
  if (!/^\d+\.\d+\.\d+/.test(String(initVersion))) {
    failures.push(`serverInfo.version is not a release version: ${JSON.stringify(initVersion)}`);
  }

  const tools = await waitFor(2);
  const names = (tools?.result?.tools ?? []).map((tool) => tool.name).sort();
  const expected = [...EXPECTED_TOOLS].sort();
  if (tools?.error) {
    failures.push(`tools/list failed: ${JSON.stringify(tools.error)}`);
  } else if (JSON.stringify(names) !== JSON.stringify(expected)) {
    failures.push(`tool catalog mismatch:\n  expected: ${expected.join(', ')}\n  actual:   ${names.join(', ')}`);
  }

  clearTimeout(timer);
  child.kill();

  if (failures.length > 0) {
    console.error('smoke: FAIL');
    for (const failure of failures) {
      console.error(`  - ${failure}`);
    }
    process.exit(1);
  }

  console.log(`smoke: PASS - 6 tools, serverInfo.version=${initVersion}`);
  process.exit(0);
} catch (error) {
  clearTimeout(timer);
  child.kill();
  console.error(`smoke: FAIL - ${error.message}`);
  process.exit(1);
}
