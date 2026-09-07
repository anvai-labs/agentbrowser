import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkCli, checkMcp, EXPECTED_TOOLS, runExecutable } from './release-smoke.mjs';

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
  for (const tools of [EXPECTED_TOOLS.slice(1), [...EXPECTED_TOOLS, EXPECTED_TOOLS[0]]]) {
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

test('public smoke commands accept explicit versions and propagate failure exit codes', async () => {
  const cli = command("console.log(process.argv.includes('--version')?'1.2.3':'agentbrowser session act plan');");
  for (const [kind, executable] of [['cli', cli], ['mcp-server', mcp()]]) {
    const wrapper = fileURLToPath(new URL(`../packages/${kind}/scripts/smoke.mjs`, import.meta.url));
    const base = [process.execPath, wrapper];
    const result = await runExecutable([...base, '--expected-version', '1.2.3', ...executable]);
    assert.equal(JSON.parse(result.stdout).version, '1.2.3');
    await assert.rejects(runExecutable([...base, '--expected-version', '9.9.9', ...executable]), /exited unsuccessfully \(1\)/);
    await assert.rejects(runExecutable([...base, '--expected-version']), /exited unsuccessfully \(2\)/);
  }
});

test('CLI requires both exact version and command help', async () => {
  const cli = (version, help) => command(`console.log(process.argv.includes('--version') ? ${JSON.stringify(version)} : ${JSON.stringify(help)});`);
  assert.equal((await checkCli(cli('1.2.3', 'agentbrowser session act plan'), options)).version, '1.2.3');
  await assert.rejects(checkCli(cli('1.2.4', 'agentbrowser session act plan'), options), /version/);
  await assert.rejects(checkCli(cli('1.2.3', 'wrong program'), options), /help/);
});

test('version evidence clears the runtime MCP version override', async () => {
  const child = mcp({ version: '1.2.3' });
  child[3] = child[3].replace('"1.2.3"', 'process.env.AGENTBROWSER_MCP_VERSION ?? "1.2.3"');
  assert.equal((await checkMcp(child, { ...options, env: { ...process.env, AGENTBROWSER_MCP_VERSION: '9.9.9' } })).version, '1.2.3');
});
