import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  checkCli,
  checkCliTestEvaluation,
  checkMcp,
  EXPECTED_TOOLS,
  runExecutable,
} from './release-smoke.mjs';

const command = (source) => [process.execPath, '--input-type=module', '-e', source, '--'];
const options = { expectedVersion: '1.2.3', timeoutMs: 3000 };
function mcp({ version = '1.2.3', protocol = '2024-11-05', tools = EXPECTED_TOOLS, reply = '', startup = '', afterReply = '' } = {}) {
  return command(`
    import { createInterface } from 'node:readline';
    ${startup}
    const input = createInterface({ input: process.stdin });
    input.on('line', line => {
      const request = JSON.parse(line);
      if (request.id === undefined) return;
      ${reply}
      const result = request.method === 'initialize'
        ? { protocolVersion: ${JSON.stringify(protocol)}, serverInfo: { version: ${JSON.stringify(version)} } }
        : request.method === 'tools/list'
          ? { tools: ${JSON.stringify(tools)}.map(name => ({ name })) }
          : { content: [{ type: 'text', text: JSON.stringify({ ok: true }) }] };
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n');
      ${afterReply}
    });
  `);
}

test('MCP verifies explicit version independently of the checkout and supports live tool calls', async () => {
  const report = await checkMcp(mcp(), {
    ...options,
    exercise: async ({ callTool }) => assert.deepEqual(await callTool('browser_create', {}), { ok: true }),
  });
  assert.equal(report.version, '1.2.3');
  assert.deepEqual(report.tools, [...EXPECTED_TOOLS].sort());
});

test('wrong MCP release version fails', async () => {
  await assert.rejects(checkMcp(mcp({ version: '9.9.9' }), options), /version/);
});

const delegatedTools = [
  'browser_snapshot', 'browser_plan', 'browser_autofill', 'browser_navigate', 'browser_observe',
  'browser_act', 'browser_extract', 'browser_html', 'browser_pdf',
  'browser_screenshot', 'browser_session', 'browser_operation',
];

test('delegated MCP acceptance requires the exact bound catalog', async () => {
  const report = await checkMcp(mcp({ tools: delegatedTools }), { ...options, catalog: 'delegated' });
  assert.deepEqual(report.tools, [...delegatedTools].sort());
  for (const tool of ['browser_create', 'browser_close', 'browser_cookies']) {
    await assert.rejects(checkMcp(mcp({ tools: [...delegatedTools, tool] }), {
      ...options, catalog: 'delegated',
    }), /catalog/);
  }
});

test('MCP catalog selection is explicit and does not weaken default acceptance', async () => {
  await assert.rejects(checkMcp(mcp({ tools: delegatedTools }), options), /catalog/);
  await assert.rejects(checkMcp(mcp(), { ...options, catalog: 'typo' }), /catalog/);
});

test('incompatible negotiated MCP protocol fails', async () => {
  await assert.rejects(checkMcp(mcp({ protocol: 'garbage' }), options), /protocol/i);
});

test('valid MCP responses cannot hide trailing output or unsuccessful shutdown', async () => {
  for (const afterReply of [
    "if(request.method==='tools/list')process.stdout.write('{');",
    "if(request.method==='tools/list'){process.exitCode=7;input.close();process.stdin.destroy();}",
    "if(request.method==='tools/list')process.stdout.write('not json\\n');",
  ]) {
    await assert.rejects(checkMcp(mcp({ afterReply }), options), /JSON|exited/);
  }
});

test('MCP must exit after stdin EOF within its deadline', async () => {
  await assert.rejects(checkMcp(mcp({ startup: 'setInterval(()=>{},1000);' }), {
    ...options, timeoutMs: 800,
  }), /deadline/);
});

test('incomplete or duplicated tool catalog fails', async () => {
  for (const tools of [EXPECTED_TOOLS.slice(1), EXPECTED_TOOLS.filter(name => name !== 'browser_autofill'), [...EXPECTED_TOOLS, EXPECTED_TOOLS[0]]]) {
    await assert.rejects(checkMcp(mcp({ tools }), options), /catalog/);
  }
});

test('MCP rejects malformed and truncated output and early exit', async () => {
  for (const source of [
    "console.log('not json');setInterval(()=>{},1000)",
    "process.stdout.write('{');",
    'process.exit(0)',
  ]) {
    await assert.rejects(checkMcp(command(source), options), /JSON|exited/);
  }
});

test('MCP JSON-RPC and tool errors cannot masquerade as successful acceptance', async () => {
  for (const payload of [
    "{jsonrpc:'2.0',id:request.id,error:{code:-32603,message:'fixture error'}}",
    "{jsonrpc:'2.0',id:request.id,result:{isError:true,content:[{type:'text',text:'fixture error'}]}}",
  ]) {
    const reply = `if(request.method==='tools/call'){console.log(JSON.stringify(${payload}));return;}`;
    await assert.rejects(checkMcp(mcp({ reply }), {
      ...options, exercise: async ({ callTool }) => callTool('browser_create', {}),
    }), /error/i);
  }
});

test('MCP deadline kills a hung child even when graceful termination is ignored', async () => {
  let pid;
  const started = performance.now();
  await assert.rejects(checkMcp(mcp({
    startup: "process.on('SIGTERM',()=>{});",
    reply: "if(request.method==='tools/call')return;",
  }), {
    ...options, timeoutMs: 800,
    onSpawn(child) { pid = child.pid; },
    exercise: async ({ callTool }) => callTool('browser_create', {}),
  }), /deadline/);
  assert.ok(performance.now() - started < 5000);
  assert.ok(pid);
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});

test('failed acceptance assertions close the owned process', async () => {
  let pid;
  await assert.rejects(checkMcp(mcp(), {
    ...options,
    onSpawn(child) { pid = child.pid; },
    exercise: async () => { throw new Error('injected acceptance failure'); },
  }), /injected acceptance failure/);
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});

test('child output is bounded and nonzero exit/spawn errors fail', async () => {
  await assert.rejects(runExecutable(command("process.stdout.write('x'.repeat(2048));"), { maxOutputBytes: 1024 }), /output/);
  await assert.rejects(runExecutable(command("process.stderr.write('x'.repeat(2048));"), { maxOutputBytes: 1024 }), /output/);
  await assert.rejects(runExecutable(command('process.exit(7)'), {}), /exited/);
  await assert.rejects(runExecutable(['/definitely-missing-agentbrowser-fixture'], {}), /ENOENT/);
});

test('executable runner inspects an expected failed JSON exit with isolated stdin, env and cwd', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agentbrowser-executable-'));
  try {
    const actualDirectory = await realpath(directory);
    const executable = command(`
      let input = '';
      process.stdin.setEncoding('utf8');
      for await (const chunk of process.stdin) input += chunk;
      process.stdout.write(JSON.stringify({ input: JSON.parse(input), cwd: process.cwd(), marker: process.env.ACCEPTANCE_MARKER, inherited: process.env.HOME }) + '\\n');
      process.exitCode = 1;
    `);
    const result = await runExecutable(executable, {
      cwd: directory,
      env: { ACCEPTANCE_MARKER: 'isolated' },
      stdin: JSON.stringify({ request: 'outcome' }),
      expectedExitCode: 1,
    });
    assert.equal(result.code, 1);
    assert.equal(result.stderr, '');
    assert.deepEqual(JSON.parse(result.stdout), {
      input: { request: 'outcome' },
      cwd: actualDirectory,
      marker: 'isolated',
    });
    await assert.rejects(
      runExecutable(command('process.exit(1)'), { expectedExitCode: 2 }),
      /expected 2/
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('executable runner rejects oversized stdin before spawn', async () => {
  let spawned = false;
  await assert.rejects(
    runExecutable(command('process.exit(0)'), {
      stdin: '12345',
      maxInputBytes: 4,
      onSpawn: () => {
        spawned = true;
      },
    }),
    /input exceeded/
  );
  assert.equal(spawned, false);
  for (const expectedExitCode of [-1, 1.5, 256]) {
    await assert.rejects(
      runExecutable(command('process.exit(0)'), {
        expectedExitCode,
        onSpawn: () => {
          spawned = true;
        },
      }),
      /Invalid expected exit code/
    );
  }
  assert.equal(spawned, false);
});

test('executable runner never accepts a signal exit as an expected code', async () => {
  await assert.rejects(
    runExecutable(command("process.kill(process.pid, 'SIGTERM')"), { expectedExitCode: 0 }),
    /SIGTERM/
  );
});

test('executable runner closes stdin and kills a child that hangs after EOF', async () => {
  let pid;
  await assert.rejects(
    runExecutable(
      command(`
        for await (const _chunk of process.stdin) {}
        setInterval(() => {}, 1000);
      `),
      {
        stdin: '{}',
        timeoutMs: 50,
        onSpawn: (child) => {
          pid = child.pid;
        },
      }
    ),
    /deadline/
  );
  assert.ok(pid);
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});

test('public smoke commands accept explicit versions and propagate failure exit codes', async () => {
  const evaluator = {
    productVersion: '1.2.3',
    command: {
      path: ['test', 'evaluate'],
      schemas: {
        input: { $id: 'urn:agentbrowser:test-case-evaluation-input:v1' },
        output: { $id: 'urn:agentbrowser:test-case-evaluation-report:v1' },
      },
    },
  };
  const cli = command(`
    if (process.argv.includes('--version')) console.log('1.2.3');
    else if (process.argv.includes('describe')) console.log(${JSON.stringify(JSON.stringify(evaluator))});
    else console.log('agentbrowser session act plan autofill pdf download health test');
  `);
  for (const [kind, executable] of [['cli', cli], ['mcp-server', mcp()]]) {
    const wrapper = fileURLToPath(new URL(`../packages/${kind}/scripts/smoke.mjs`, import.meta.url));
    const base = [process.execPath, wrapper];
    const result = await runExecutable([...base, '--expected-version', '1.2.3', ...executable]);
    assert.equal(JSON.parse(result.stdout).version, '1.2.3');
    await assert.rejects(runExecutable([...base, '--expected-version', '9.9.9', ...executable]), /exited unsuccessfully \(1\)/);
    await assert.rejects(runExecutable([...base, '--expected-version']), /exited unsuccessfully \(2\)/);
  }
});

test('CLI requires exact version, command help and the offline evaluator schema', async () => {
  const discovery = (version = '1.2.3', input = true, output = true) => ({
    productVersion: version,
    command: {
      path: ['test', 'evaluate'],
      schemas: {
        ...(input ? { input: { $id: 'urn:agentbrowser:test-case-evaluation-input:v1' } } : {}),
        ...(output ? { output: { $id: 'urn:agentbrowser:test-case-evaluation-report:v1' } } : {}),
      },
    },
  });
  const cli = (version, help, described = discovery()) => command(`
    if (process.argv.includes('--version')) console.log(${JSON.stringify(version)});
    else if (process.argv.includes('describe')) {
      ${described === null ? 'process.exitCode = 1;' : `console.log(${JSON.stringify(JSON.stringify(described))});`}
    } else console.log(${JSON.stringify(help)});
  `);
  const fullHelp = 'agentbrowser session act plan autofill pdf download health test';
  const accepted = await checkCli(cli('1.2.3', fullHelp), options);
  assert.equal(accepted.version, '1.2.3');
  const evaluator = await checkCliTestEvaluation(cli('1.2.3', fullHelp), options);
  assert.equal(evaluator.inputSchemaId, 'urn:agentbrowser:test-case-evaluation-input:v1');
  await assert.rejects(checkCli(cli('1.2.4', fullHelp), options), /version/);
  await assert.rejects(checkCli(cli('1.2.3', 'wrong program'), options), /help/);
  await assert.rejects(checkCliTestEvaluation(cli('1.2.3', fullHelp, null), options), /discovery/);
  await assert.rejects(
    checkCliTestEvaluation(cli('1.2.3', fullHelp, discovery('1.2.4')), options),
    /version/
  );
  await assert.rejects(
    checkCliTestEvaluation(cli('1.2.3', fullHelp, discovery('1.2.3', false)), options),
    /schema/
  );
  await assert.rejects(
    checkCliTestEvaluation(cli('1.2.3', fullHelp, discovery('1.2.3', true, false)), options),
    /schema/
  );
  assert.equal(
    (await checkCli(
      cli('1.2.3', 'agentbrowser session act plan autofill pdf download health', null),
      options
    )).version,
    '1.2.3'
  );
});

test('version evidence clears the runtime MCP version override', async () => {
  const child = mcp({ version: '1.2.3' });
  child[3] = child[3].replace('"1.2.3"', 'process.env.AGENTBROWSER_MCP_VERSION ?? "1.2.3"');
  assert.equal((await checkMcp(child, { ...options, env: { ...process.env, AGENTBROWSER_MCP_VERSION: '9.9.9' } })).version, '1.2.3');
});


test('MCP smoke qualifies explicitly requested protocol versions without weakening legacy default', async () => {
  const modern = mcp({ protocol: '2025-06-18' });
  await checkMcp(modern, { ...options, protocolVersion: '2025-06-18' });
  await assert.rejects(checkMcp(modern, options), /protocol/);
});

test('MCP smoke rejects mismatched structured/text data and unflagged failed reports', async () => {
  for (const result of [
    { content: [{ type: 'text', text: '{"ok":true}' }], structuredContent: { ok: false } },
    { content: [{ type: 'text', text: '{"ok":false}' }] },
  ]) {
    const reply = `if(request.method==='tools/call'){console.log(JSON.stringify({jsonrpc:'2.0',id:request.id,result:${JSON.stringify(result)}}));return;}`;
    await assert.rejects(checkMcp(mcp({ reply }), {
      ...options, exercise: async ({ callTool }) => callTool('browser_autofill', {}),
    }), /structured|failed/);
  }
});


test('empty stdin EOF tolerates a closed reader but undelivered nonempty input fails', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agentbrowser-closed-stdin-'));
  try {
    const inputs = [undefined, '', Buffer.alloc(0), '{}'];
    for (const [index, stdin] of inputs.entries()) {
      const marker = join(directory, String(index));
      const executable = command(`
        const fs = await import('node:fs');
        fs.closeSync(0);
        fs.writeFileSync(${JSON.stringify(marker)}, 'closed');
        setTimeout(() => process.stdout.write('done'), 100);
      `);
      const run = runExecutable(executable, {
        ...(stdin === undefined ? {} : { stdin }),
        onSpawn() {
          // Child startup is independent of this event loop. Wait for proof that
          // its read end is closed before the runner attempts to finish stdin.
          const deadline = Date.now() + 2000;
          while (!existsSync(marker) && Date.now() < deadline)
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
          assert.ok(existsSync(marker), 'Child failed to close stdin within the bound');
        },
      });
      if (stdin === '{}') await assert.rejects(run, /EPIPE/);
      else assert.deepEqual(await run, { stdout: 'done', stderr: '', code: 0 });
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
