#!/usr/bin/env node
/**
 * T8 Q1: re-qualify the MCP bridge through installed provider CLIs (Codex, Claude Code) against a
 * scratch service built from this checkout. The evidence is independent of the model's narrative:
 * the fixture server records what the browser actually did, the service's own operation records
 * confirm delegated writes, and the providers' JSON event streams are scanned for what crossed
 * the bridge (structured results, redaction, image artifact references).
 *
 *   pnpm -r build
 *   node scripts/t8-harness-qualification.mjs --providers codex,claude --out <file.json>
 *
 * Safety: the service runs in KEYED mode on a scratch loopback port with AGENTBROWSER_ALLOW_LOOPBACK
 * (the fixture lives on loopback). Codex runs `exec --ephemeral --ignore-user-config
 * --approve-for-me` with only this MCP server; Claude Code runs `-p` with a strict MCP config and
 * ONLY the agentbrowser tools allowed (no shell, file or web tools). Nothing is submitted anywhere
 * but the fixture.
 */
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const SERVER_BIN = join(root, 'packages/api/dist/bin.js');
const MCP_BIN = join(root, 'packages/mcp-server/dist/bin.js');

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
};
const providers = flag('--providers', 'codex,claude').split(',').filter(Boolean);
const outFile = flag('--out', undefined);
/** Optional directory for the raw provider event streams (they hold the run's tool traffic). */
const streamsDir = flag('--streams', undefined);
let streamSeq = 0;
const nonce = () => randomBytes(6).toString('hex');

// ---------------------------------------------------------------- fixture (independent oracle)
const hits = [];
const SECRET = `qual-secret-${nonce()}`;
const fixture = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://fixture.invalid');
  hits.push({ path: url.pathname, query: Object.fromEntries(url.searchParams) });
  response.setHeader('content-type', 'text/html');
  if (url.pathname === '/form') {
    response.end(`<!doctype html><title>Qualification form</title><main><h1>Qualification</h1>
      <form action="/submit"><label>First name <input name="first"></label>
      <label>Account password <input type="password" name="pw" value="${SECRET}"></label>
      <button>Apply</button></form></main>`);
    return;
  }
  if (url.pathname === '/submit') {
    response.end('<!doctype html><title>Submitted</title><p>Received.</p>');
    return;
  }
  response.statusCode = 404;
  response.end('not found');
});

// ---------------------------------------------------------------- scratch service
async function startService(apiKey) {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, [SERVER_BIN], {
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      AGENTBROWSER_API_KEYS: `${apiKey}:qual`,
      AGENTBROWSER_ALLOW_LOOPBACK: '1',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  const base = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      if ((await fetch(`${base}/health`)).ok) return { child, base };
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  child.kill();
  throw new Error('scratch service did not start');
}

async function rest(base, key, method, path, body, extraHeaders = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${key}`,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...extraHeaders,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  return { status: response.status, json: text ? JSON.parse(text) : null };
}

// ---------------------------------------------------------------- providers
/**
 * Asynchronous on purpose: the fixture server lives in this process, so a synchronous spawn
 * would block its event loop and the browser could never load a fixture page.
 */
function spawnAsync(command, commandArgs, options) {
  return new Promise((resolve) => {
    const child = spawn(command, commandArgs, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => child.kill('SIGTERM'), options.timeout ?? 600_000);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ status: code, stdout, stderr });
    });
  });
}

async function runProvider(provider, mcpEnv, prompt) {
  const result = await runProviderRaw(provider, mcpEnv, prompt);
  if (streamsDir)
    writeFileSync(join(streamsDir, `${provider}-${++streamSeq}.jsonl`), result.stream);
  return result;
}

async function runProviderRaw(provider, mcpEnv, prompt) {
  const work = mkdtempSync(join(tmpdir(), `t8-${provider}-`));
  try {
    if (provider === 'codex') {
      const envArgs = Object.entries(mcpEnv).flatMap(([key, value]) => [
        '-c',
        `mcp_servers.agentbrowser.env.${key}=${JSON.stringify(value)}`,
      ]);
      const result = await spawnAsync(
        'codex',
        [
          'exec',
          '--ephemeral',
          '--ignore-user-config',
          '--approve-for-me',
          '--skip-git-repo-check',
          '--json',
          '-c',
          `mcp_servers.agentbrowser.command=${JSON.stringify(process.execPath)}`,
          '-c',
          `mcp_servers.agentbrowser.args=${JSON.stringify([MCP_BIN])}`,
          ...envArgs,
          prompt,
        ],
        { cwd: work, timeout: 600_000 }
      );
      return {
        code: result.status,
        stream: result.stdout ?? '',
        stderr: (result.stderr ?? '').slice(-2000),
      };
    }
    const config = join(work, 'mcp.json');
    writeFileSync(
      config,
      JSON.stringify({
        mcpServers: { agentbrowser: { command: process.execPath, args: [MCP_BIN], env: mcpEnv } },
      })
    );
    const result = await spawnAsync(
      'claude',
      [
        '-p',
        prompt,
        '--mcp-config',
        config,
        '--strict-mcp-config',
        '--allowedTools',
        'mcp__agentbrowser__*',
        '--output-format',
        'stream-json',
        '--verbose',
      ],
      { cwd: work, timeout: 600_000 }
    );
    return {
      code: result.status,
      stream: result.stdout ?? '',
      stderr: (result.stderr ?? '').slice(-2000),
    };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/**
 * Tool names the provider actually invoked on the agentbrowser server, read from the invocation
 * events only (Claude Code's init event lists every available tool, so a text scan would count
 * tools that were merely offered).
 */
function toolCalls(stream) {
  const names = new Set();
  for (const line of stream.split('\n')) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    // Codex: {"type":"item.*","item":{"type":"mcp_tool_call","server":"agentbrowser","tool":...}}
    const item = event?.item;
    if (item?.type === 'mcp_tool_call' && item.server === 'agentbrowser') names.add(item.tool);
    // Claude Code: assistant messages carrying tool_use blocks named mcp__agentbrowser__<tool>.
    if (event?.type === 'assistant') {
      for (const block of event.message?.content ?? []) {
        const match = block?.type === 'tool_use' && /^mcp__agentbrowser__(.+)$/.exec(block.name);
        if (match) names.add(match[1]);
      }
    }
  }
  return [...names].sort();
}

// ---------------------------------------------------------------- dimensions
async function qualify(provider, fixtureBase, serviceBase, operatorKey) {
  const results = [];

  // D1: unbound tool-call fidelity and structured results, verified at the fixture.
  {
    const value = `QUAL-${nonce()}`;
    const before = hits.length;
    const run = await runProvider(
      provider,
      { AGENTBROWSER_BASE_URL: serviceBase, AGENTBROWSER_API_KEY: operatorKey },
      `Use only the agentbrowser MCP tools. Create a browser session with tenantId "qual". ` +
        `Navigate its page to ${fixtureBase}/form. Take a snapshot. Fill the "First name" field ` +
        `with exactly ${value} and click the "Apply" button (use the act tool with refs from the ` +
        `snapshot). Then close the session. Finally report the snapshot's revision number and ` +
        `whether the password field's value was visible to you.`
    );
    const submitted = hits
      .slice(before)
      .some((hit) => hit.path === '/submit' && hit.query.first === value);
    results.push({
      dimension: 'tool-call fidelity (unbound create/navigate/snapshot/act/close)',
      pass: run.code === 0 && submitted,
      evidence: {
        exitCode: run.code,
        fixtureSawSubmission: submitted,
        toolsCalled: toolCalls(run.stream),
        structuredContentSeen: /structuredContent|structured_content/.test(run.stream),
        passwordValueCrossedBridge: run.stream.includes(SECRET),
      },
      ...(run.code !== 0 ? { stderrTail: run.stderr } : {}),
    });
  }

  // D2: delegated act/navigate with operation IDs, verified by the service's operation records.
  {
    const created = await rest(serviceBase, operatorKey, 'POST', '/v1/sessions', {
      tenantId: 'qual',
      controlMode: 'delegated',
    });
    const sessionId = created.json.sessionId;
    const path = `/v1/sessions/${sessionId}`;
    const page = await rest(serviceBase, operatorKey, 'POST', `${path}/pages`, undefined, {
      'x-agentbrowser-operation-id': 'qual-page',
    });
    const pageId = page.json.pageId;
    const review = await rest(serviceBase, operatorKey, 'POST', `${path}/control/prepare-resume`);
    const grant = await rest(serviceBase, operatorKey, 'POST', `${path}/control/delegate`, {
      epoch: review.json.epoch,
    });
    const navId = `q-nav-${nonce()}`;
    const fillId = `q-act-${nonce()}`;
    const value = `DELEG-${nonce()}`;
    const before = hits.length;
    const run = await runProvider(
      provider,
      {
        AGENTBROWSER_BASE_URL: serviceBase,
        AGENTBROWSER_API_KEY: grant.json.token,
        AGENTBROWSER_SESSION_ID: sessionId,
      },
      'Use only the agentbrowser MCP tools. This connection is bound to one browser session; its ' +
        `page id is ${pageId}. Navigate that page to ${fixtureBase}/form with operationId ` +
        `"${navId}". Observe the page, then use act to fill the "First name" field with exactly ` +
        `${value} using operationId "${fillId}". Report what the observation showed.`
    );
    const nav = await rest(serviceBase, operatorKey, 'GET', `${path}/operations/${navId}`);
    const fill = await rest(serviceBase, operatorKey, 'GET', `${path}/operations/${fillId}`);
    await rest(serviceBase, operatorKey, 'POST', `${path}/control/takeover`);
    await rest(serviceBase, operatorKey, 'DELETE', path);
    results.push({
      dimension: 'delegated navigate/act with operation IDs (operator-verified records)',
      pass:
        run.code === 0 &&
        nav.json?.status === 'completed' &&
        nav.json?.dispatched === true &&
        fill.json?.status === 'completed' &&
        fill.json?.dispatched === true &&
        hits.slice(before).some((hit) => hit.path === '/form'),
      evidence: {
        exitCode: run.code,
        navigateRecord: nav.json,
        actRecord: fill.json,
        toolsCalled: toolCalls(run.stream),
        passwordValueCrossedBridge: run.stream.includes(SECRET),
      },
      ...(run.code !== 0 ? { stderrTail: run.stderr } : {}),
    });
  }

  // D3: image reference privacy — a screenshot reaches the model as an artifact reference, never
  // inline image bytes, and the observation withholds the password. (HTML is deliberately inline
  // and not secret-redacted, ADR-020, so it is not a privacy dimension here.)
  {
    const run = await runProvider(
      provider,
      { AGENTBROWSER_BASE_URL: serviceBase, AGENTBROWSER_API_KEY: operatorKey },
      `Use only the agentbrowser MCP tools. Create a browser session with tenantId "qual", ` +
        `navigate its page to ${fixtureBase}/form, observe it, and take a screenshot. Report the ` +
        `screenshot's artifactId exactly as returned, then close the session.`
    );
    const artifactIds = [...new Set(run.stream.match(/art_[0-9]+_[0-9a-z]+/g) ?? [])];
    // Base64 PNG or JPEG bytes in an MCP image block or a data URL.
    const inlineImage = /"data"\s*:\s*"(iVBOR|\/9j\/)|base64,(iVBOR|\/9j\/)/;
    results.push({
      dimension: 'image reference privacy (artifact ref, no inline bytes, redacted observation)',
      pass:
        run.code === 0 &&
        artifactIds.length > 0 &&
        !inlineImage.test(run.stream) &&
        !run.stream.includes(SECRET),
      evidence: {
        exitCode: run.code,
        artifactIdsInStream: artifactIds,
        inlineImageBytesInStream: inlineImage.test(run.stream),
        passwordValueCrossedBridge: run.stream.includes(SECRET),
        toolsCalled: toolCalls(run.stream),
      },
      ...(run.code !== 0 ? { stderrTail: run.stderr } : {}),
    });
  }

  results.push({
    dimension: 'cancellation',
    pass: null,
    evidence: {
      note: 'Not exercisable headlessly: neither provider CLI exposes a way to cancel one in-flight tool call from a scripted run. The bridge-side behaviour (notifications/cancelled aborts the HTTP request, no response) is qualified end to end in packages/mcp-server/src/cancellation.test.ts, including the compiled Bun binary (#485 review).',
    },
  });
  return results;
}

// ---------------------------------------------------------------- main
const versions = {
  codex: spawnSync('codex', ['--version'], { encoding: 'utf8' }).stdout?.trim(),
  claude: spawnSync('claude', ['--version'], { encoding: 'utf8' }).stdout?.trim(),
  node: process.version,
};
await new Promise((resolve) => fixture.listen(0, '127.0.0.1', resolve));
const fixtureBase = `http://127.0.0.1:${fixture.address().port}`;
const operatorKey = `qual-${nonce()}${nonce()}`;
const service = await startService(operatorKey);
const report = { startedAt: new Date().toISOString(), versions, providers: {} };
try {
  for (const provider of providers) {
    report.providers[provider] = await qualify(provider, fixtureBase, service.base, operatorKey);
  }
} finally {
  service.child.kill();
  fixture.close();
}
report.finishedAt = new Date().toISOString();
const text = JSON.stringify(report, null, 2);
if (outFile) writeFileSync(outFile, `${text}\n`);
console.log(text);
const failed = Object.values(report.providers)
  .flat()
  .some((result) => result.pass === false);
process.exit(failed ? 1 : 0);
