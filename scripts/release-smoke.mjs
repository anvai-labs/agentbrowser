/** Dependency-free acceptance primitives for built, published and installed executables. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const EXPECTED_TOOLS = Object.freeze([
  'browser_create', 'browser_close', 'browser_cookies', 'browser_snapshot',
  'browser_plan', 'browser_navigate', 'browser_observe', 'browser_act',
  'browser_extract', 'browser_pdf', 'browser_screenshot',
]);

/** Preserve binary/Node commands and allow testing older installed releases. */
export async function runSmokeCommand(kind, argv, manifest) {
  const args = [...argv];
  let expectedVersion;
  if (args[0] === '--expected-version') {
    args.shift();
    expectedVersion = args.shift();
  }
  const binary = args.shift();
  if (!binary || expectedVersion === '') {
    console.error('usage: smoke.mjs [--expected-version VERSION] <binary> [binary-args...]');
    process.exitCode = 2;
    return;
  }
  try {
    expectedVersion ??= JSON.parse(readFileSync(manifest, 'utf8')).version;
    const check = kind === 'mcp' ? checkMcp : checkCli;
    const report = await check([resolve(binary), ...args], { expectedVersion });
    console.log(JSON.stringify({ smoke: 'PASS', kind, ...report }));
  } catch (error) {
    console.error(`smoke: FAIL - ${error.message}`);
    process.exitCode = 1;
  }
}

function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Invalid ${name}`);
  return value;
}

async function waitForExit(closed, milliseconds) {
  let timer;
  try {
    return await Promise.race([
      closed.then(() => true),
      new Promise((resolve) => { timer = setTimeout(() => resolve(false), milliseconds); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function withProcess(command, options, exercise) {
  assert.ok(Array.isArray(command) && command.length > 0 && command.every((arg) => typeof arg === 'string'), 'Expected command array');
  const timeoutMs = positiveInteger(options.timeoutMs ?? 20_000, 'deadline');
  const maxOutputBytes = positiveInteger(options.maxOutputBytes ?? 1024 * 1024, 'output limit');
  const env = { ...(options.env ?? process.env) };
  // A runtime version override must never make an incorrectly stamped artifact pass.
  delete env.AGENTBROWSER_MCP_VERSION;
  const child = spawn(command[0], command.slice(1), { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let rejectFailure;
  const failure = new Promise((_, reject) => { rejectFailure = reject; });
  // Install immediately: spawn/stream errors can precede the first request.
  failure.catch(() => {});
  let stdout = '';
  let stderr = '';
  let outputBytes = 0;
  let onData = () => {};
  let hasClosed = false;
  const fail = (error) => rejectFailure(error);
  const closed = new Promise((resolve) => {
    child.once('close', (code, signal) => { hasClosed = true; resolve({ code, signal }); });
  });
  child.once('error', fail);
  child.stdin.on('error', fail);
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  for (const [name, stream] of [['stdout', child.stdout], ['stderr', child.stderr]]) {
    stream.on('error', fail);
    stream.on('data', (chunk) => {
      outputBytes += Buffer.byteLength(chunk);
      if (outputBytes > maxOutputBytes) {
        fail(new Error('Executable output exceeded the acceptance limit'));
        return;
      }
      if (name === 'stderr') stderr += chunk;
      else {
        stdout += chunk;
        try { onData(chunk); } catch (error) { fail(error); }
      }
    });
  }
  const timer = setTimeout(() => fail(new Error('Executable acceptance deadline exceeded')), timeoutMs);
  try {
    options.onSpawn?.(child);
    return await Promise.race([
      exercise({ child, closed, failure, fail, onData(callback) { onData = callback; }, output: () => ({ stdout, stderr }) }),
      failure,
    ]);
  } finally {
    clearTimeout(timer);
    if (!hasClosed) {
      child.kill('SIGTERM');
      if (!(await waitForExit(closed, 1000))) {
        child.kill('SIGKILL');
        if (!(await waitForExit(closed, 1000))) throw new Error('Executable cleanup failed: child did not exit');
      }
    }
  }
}

export async function runExecutable(command, options = {}) {
  return withProcess(command, options, async ({ closed, output }) => {
    const result = await closed;
    assert.equal(result.code, 0, `Executable exited unsuccessfully (${result.code ?? result.signal})`);
    return output();
  });
}

export async function checkCli(command, options) {
  assert.ok(options.expectedVersion, 'Expected release version is required');
  const version = (await runExecutable([...command, '--version'], options)).stdout.trim();
  assert.equal(version, options.expectedVersion, 'CLI version mismatch');
  const help = (await runExecutable([...command, '--help'], options)).stdout;
  for (const token of ['agentbrowser', 'session', 'act', 'plan']) {
    assert.ok(help.includes(token), `CLI help is missing ${token}`);
  }
  return { version };
}

export async function checkMcp(command, options) {
  assert.ok(options.expectedVersion, 'Expected release version is required');
  return withProcess(command, options, async (process) => {
    const pending = new Map();
    let sequence = 0;
    let buffer = '';
    process.onData((chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        let message;
        try { message = JSON.parse(line); } catch { throw new Error('Invalid JSON on MCP stdout'); }
        assert.ok(message && message.jsonrpc === '2.0', 'Invalid JSON-RPC envelope');
        if (!Object.hasOwn(message, 'id') && typeof message.method === 'string') continue;
        const receive = pending.get(message.id);
        assert.ok(receive, 'Unexpected MCP response id');
        assert.ok(Object.hasOwn(message, 'result') !== Object.hasOwn(message, 'error'), 'Invalid JSON-RPC result/error envelope');
        pending.delete(message.id);
        receive(message);
      }
    });
    const request = async (method, params = {}) => {
      assert.ok(pending.size < 16, 'Too many pending MCP smoke requests');
      const id = ++sequence;
      const response = new Promise((resolve) => pending.set(id, resolve));
      try {
        process.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
        const message = await Promise.race([
          response, process.failure,
          process.closed.then(() => { throw new Error('MCP exited before its response completed'); }),
        ]);
        assert.ok(!Object.hasOwn(message, 'error'), 'MCP JSON-RPC error');
        return message.result;
      } finally {
        pending.delete(id);
      }
    };
    const callTool = async (name, args) => {
      const result = await request('tools/call', { name, arguments: args });
      assert.ok(result && !result.isError, 'MCP tool returned an error');
      const text = result.content?.find((item) => item.type === 'text')?.text;
      assert.equal(typeof text, 'string', 'MCP tool omitted JSON text content');
      return JSON.parse(text);
    };
    const init = await request('initialize', {
      protocolVersion: '2024-11-05', capabilities: {},
      clientInfo: { name: 'agentbrowser-release-smoke', version: '1.0.0' },
    });
    assert.equal(init?.protocolVersion, '2024-11-05', 'MCP protocol version mismatch');
    assert.equal(init?.serverInfo?.version, options.expectedVersion, 'MCP version mismatch');
    process.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    const catalog = await request('tools/list');
    const names = catalog?.tools?.map((tool) => tool.name).sort();
    assert.deepEqual(names, [...EXPECTED_TOOLS].sort(), 'MCP tool catalog mismatch');
    await options.exercise?.({ request, callTool });
    assert.equal(pending.size, 0, 'Acceptance returned with pending MCP requests');
    // EOF is the normal stdio shutdown. Drain every byte and validate the exit
    // before reporting success; signal escalation is only failure cleanup.
    process.child.stdin.end();
    const result = await Promise.race([process.closed, process.failure]);
    assert.equal(result.code, 0, `MCP exited unsuccessfully (${result.code ?? result.signal})`);
    assert.equal(buffer.trim(), '', 'Incomplete JSON on MCP stdout');
    return { version: init.serverInfo.version, tools: names };
  });
}
