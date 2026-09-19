/** Dependency-free acceptance primitives for built, published and installed executables. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { resolve } from 'node:path';

export const EXPECTED_TOOLS = Object.freeze([
  'browser_create', 'browser_close', 'browser_cookies', 'browser_snapshot',
  'browser_plan', 'browser_autofill', 'browser_navigate', 'browser_observe', 'browser_act',
  'browser_extract', 'browser_html', 'browser_pdf', 'browser_screenshot',
]);

export const EXPECTED_DELEGATED_TOOLS = Object.freeze([
  ...EXPECTED_TOOLS.filter((name) => !['browser_create', 'browser_close', 'browser_cookies'].includes(name)),
  'browser_session', 'browser_operation',
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
  const child = spawn(command[0], command.slice(1), {
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
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
  const expectedExitCode = options.expectedExitCode ?? 0;
  assert.ok(
    Number.isSafeInteger(expectedExitCode) && expectedExitCode >= 0 && expectedExitCode <= 255,
    'Invalid expected exit code'
  );
  const maxInputBytes = positiveInteger(options.maxInputBytes ?? 1024 * 1024, 'input limit');
  const stdin = options.stdin ?? '';
  assert.ok(typeof stdin === 'string' || Buffer.isBuffer(stdin), 'Executable stdin must be a string or Buffer');
  assert.ok(Buffer.byteLength(stdin) <= maxInputBytes, 'Executable input exceeded the acceptance limit');
  return withProcess(command, options, async ({ child, closed, output }) => {
    // Empty chunks still issue a pipe write and can EPIPE after a short-lived
    // child closes its reader. EOF alone needs no write; real input errors fail.
    if (Buffer.byteLength(stdin) === 0) child.stdin.end();
    else child.stdin.end(stdin);
    const result = await closed;
    assert.equal(
      result.code,
      expectedExitCode,
      expectedExitCode === 0
        ? `Executable exited unsuccessfully (${result.code ?? result.signal})`
        : `Executable exited unexpectedly (${result.code ?? result.signal}; expected ${expectedExitCode})`
    );
    return { ...output(), code: result.code };
  });
}

export async function checkCli(command, options) {
  assert.ok(options.expectedVersion, 'Expected release version is required');
  const version = (await runExecutable([...command, '--version'], options)).stdout.trim();
  assert.equal(version, options.expectedVersion, 'CLI version mismatch');
  const help = (await runExecutable([...command, '--help'], options)).stdout;
  for (const token of ['agentbrowser', 'session', 'act', 'plan', 'autofill', 'pdf', 'download', 'health']) {
    assert.ok(help.includes(token), `CLI help is missing ${token}`);
  }
  return { version };
}

export async function checkMcp(command, options) {
  assert.ok(options.expectedVersion, 'Expected release version is required');
  const catalogMode = options.catalog ?? 'unbound';
  const protocolVersion = options.protocolVersion ?? '2024-11-05';
  assert.ok(['unbound', 'delegated'].includes(catalogMode), 'Unknown MCP catalog');
  const expectedTools = catalogMode === 'delegated' ? EXPECTED_DELEGATED_TOOLS : EXPECTED_TOOLS;
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
      const value = JSON.parse(text);
      if (result.structuredContent !== undefined)
        assert.deepEqual(result.structuredContent, value, 'MCP structured/text results disagree');
      assert.notEqual(value?.ok, false, 'MCP report failed');
      return value;
    };
    const init = await request('initialize', {
      protocolVersion, capabilities: {},
      clientInfo: { name: 'agentbrowser-release-smoke', version: '1.0.0' },
    });
    assert.equal(init?.protocolVersion, protocolVersion, 'MCP protocol version mismatch');
    assert.equal(init?.serverInfo?.version, options.expectedVersion, 'MCP version mismatch');
    process.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    const catalog = await request('tools/list');
    const names = catalog?.tools?.map((tool) => tool.name).sort();
    assert.deepEqual(names, [...expectedTools].sort(), 'MCP tool catalog mismatch');
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


/** Qualify serialization/dispatch, not browser behavior, using an owned loopback fixture. */
export async function checkMcpContracts(command, options) {
  const payload = { fields: [{ match: { label: 'Name', block: { label: 'Current' } }, value: 'fixture-value' }] };
  const report = { ok: true, receipts: [{ field: 0, match: payload.fields[0].match, status: 'unverified', verified: false }], elapsedMs: 1 };
  const failed = { ...report, ok: false, receipts: [{ ...report.receipts[0], status: 'uncertain' }] };
  const planReport = { ok: true, completed: 1, results: [{ step: 0, ok: true, actionId: 'fixture-action', result: { evidence: 'kept' } }], mode: 'stable', newRevision: 2 };
  const cases = [
    { route: 'autofill', payload, report, failed },
    { route: 'plan', payload: { actions: [{ action: 'press', key: 'Tab', count: 2 }] }, report: planReport,
      failed: { ...planReport, ok: false, completed: 0, results: [{ step: 0, ok: false, error: 'denied' }], error: { code: 'PLAN_STEP_FAILED', message: 'denied' } } },
  ];
  const requests = [];
  const fixture = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    requests.push({ path: request.url, method: request.method, headers: request.headers, body });
    const id = request.headers['x-agentbrowser-operation-id'];
    const scenario = cases.find((entry) => request.url.endsWith(`/${entry.route}`));
    const result = id === 'invalid' ? { ...scenario.report, ok: 'PRIVATE-REPORT' }
      : id === 'failed' ? scenario.failed : scenario.report;
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(result));
  });
  try {
    await new Promise((resolve, reject) => {
      fixture.once('error', reject);
      fixture.listen(0, '127.0.0.1', resolve);
    });
    const bytes = [];
    for (const protocolVersion of ['2024-11-05', '2025-06-18']) {
      for (const catalog of ['unbound', 'delegated']) {
        const env = { ...(options.env ?? process.env), AGENTBROWSER_BASE_URL: `http://127.0.0.1:${fixture.address().port}`, AGENTBROWSER_API_KEY: 'fixture-key' };
        delete env.AGENTBROWSER_SESSION_ID;
        if (catalog === 'delegated') env.AGENTBROWSER_SESSION_ID = 'fixture-session';
        await checkMcp(command, { ...options, env, protocolVersion, catalog, exercise: async ({ request }) => {
          const listed = await request('tools/list');
          bytes.push({ protocolVersion, catalog, bytes: Buffer.byteLength(JSON.stringify(listed)) });
          const autofill = listed.tools.find((tool) => tool.name === 'browser_autofill');
          const modern = protocolVersion === '2025-06-18';
          if (modern) {
            assert.equal(autofill.outputSchema?.$id, 'urn:agentbrowser:autofill-report:v1', 'Missing canonical output schema');
            assert.equal(autofill.annotations?.readOnlyHint, false, 'Autofill must not claim read-only behavior');
            assert.equal(autofill.annotations?.idempotentHint, false, 'Autofill must not imply safe replay');
            assert.ok(autofill.outputSchema.properties.receipts.items.properties.status.anyOf.some((entry) => entry.const === 'uncertain'), 'Lost nested output schema');
          } else assert.ok(listed.tools.every((tool) => !tool.outputSchema && !tool.annotations), 'Legacy catalog gained modern fields');
          assert.equal(autofill.inputSchema.properties.fields.items.properties.match.properties.block.properties.label.maxLength, 512, 'Lost nested match schema');
          assert.equal(autofill.inputSchema.required.includes('operationId'), catalog === 'delegated');
          const plan = listed.tools.find((tool) => tool.name === 'browser_plan');
          assert.equal(plan.inputSchema.properties.actions.items.properties.waitMs.maximum, 60000, 'Lost canonical plan input');
          if (modern) assert.equal(plan.outputSchema?.$id, 'urn:agentbrowser:plan-report:v1', 'Missing canonical plan output');
          for (const scenario of cases) {
          const args = { ...scenario.payload, pageId: 'fixture-page', ...(catalog === 'unbound' ? { sessionId: 'fixture-session' } : {}) };
          for (const [operationId, expected] of [['success', scenario.report], ['failed', scenario.failed], ['invalid', null]]) {
            const before = requests.length;
            const result = await request('tools/call', { name: `browser_${scenario.route}`, arguments: { ...args, operationId } });
            assert.equal(requests.length, before + 1, 'Write dispatch must happen exactly once');
            const received = requests.at(-1);
            assert.equal(received.path, `/v1/sessions/fixture-session/pages/fixture-page/${scenario.route}`);
            assert.equal(received.method, 'POST');
            assert.equal(received.headers['x-agentbrowser-operation-id'], operationId);
            assert.equal(received.headers.authorization, 'Bearer fixture-key');
            assert.deepEqual(JSON.parse(received.body), scenario.payload);
            if (expected) {
              assert.deepEqual(JSON.parse(result.content[0].text), expected);
              assert.equal(result.isError, expected.ok ? undefined : true);
              assert.deepEqual(result.structuredContent, modern ? expected : undefined);
            } else {
              assert.equal(result.isError, true);
              assert.equal(result.structuredContent, undefined);
              assert.ok(!JSON.stringify(result).includes('PRIVATE-REPORT'));
              assert.match(result.content[0].text, /may have executed/);
            }
          }
          }
        } });
      }
    }
    return { catalogs: bytes };
  } finally {
    fixture.closeAllConnections();
    await new Promise((resolve) => fixture.close(resolve));
  }
}
