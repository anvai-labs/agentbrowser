/** Extracted-package acceptance. All browser/service imports are anchored to the supplied package. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { createRequire, isBuiltin } from 'node:module';
import { createServer as createTcpServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { checkCli, checkMcp, runExecutable } from './release-smoke.mjs';
import { validateArtifact, validatePdf } from './artifact-validation.mjs';
export { validateArtifact } from './artifact-validation.mjs';

const MAX_OUTPUT = 1024 * 1024;
const childScript = fileURLToPath(new URL('./package-acceptance-child.mjs', import.meta.url));

async function containedPath(root, path) {
  const actual = await realpath(path);
  const suffix = relative(root, actual);
  assert.ok(!suffix.startsWith('..') && !isAbsolute(suffix), `Dependency escapes extracted server package: ${path} -> ${actual}`);
  return actual;
}

/** Required runtime closure, without requiring exported metadata or a JS entrypoint for type packages. */
export async function auditDependencyClosure(serverRoot, expectedVersion) {
  const root = await realpath(serverRoot);
  const pending = [join(root, 'package.json')];
  const visited = new Set();
  let edges = 0;
  while (pending.length) {
    const manifestPath = await containedPath(root, pending.pop());
    if (visited.has(manifestPath)) continue;
    visited.add(manifestPath);
    assert.ok(visited.size <= 10_000, 'Package dependency closure exceeds package limit');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    if (expectedVersion && manifest.name?.startsWith('@agentbrowser/')) {
      assert.equal(manifest.version, expectedVersion, `Packaged ${manifest.name} version mismatch`);
    }
    const require = createRequire(manifestPath);
    const dependencies = new Map(Object.keys(manifest.dependencies ?? {}).map((name) => [name, true]));
    for (const name of Object.keys(manifest.optionalDependencies ?? {})) dependencies.set(name, false);
    for (const name of Object.keys(manifest.peerDependencies ?? {})) {
      if (!dependencies.has(name)) dependencies.set(name, manifest.peerDependenciesMeta?.[name]?.optional !== true);
    }
    for (const [name, required] of dependencies) {
      assert.ok(++edges <= 100_000, 'Package dependency closure exceeds edge limit');
      assert.match(name, /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i, 'Invalid dependency package name');
      assert.ok(!name.split('/').some((part) => part === '.' || part === '..'), 'Invalid dependency package path');
      let metadataPath;
      // Metadata resolution follows Node's package search order. It deliberately
      // does not require package.json to be exported by the dependency.
      for (const searchRoot of require.resolve.paths(name) ?? []) {
        const candidate = join(searchRoot, name, 'package.json');
        try {
          await stat(candidate);
          metadataPath = await containedPath(root, candidate);
          break;
        } catch (error) {
          if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
        }
      }
      if (!metadataPath) {
        assert.ok(!required || isBuiltin(name), `Required packaged dependency ${name} is missing`);
        continue;
      }
      const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
      const typesOnly = (metadata.types || metadata.typings) && !metadata.main && !metadata.exports;
      if (!typesOnly && !isBuiltin(name)) {
        try { await containedPath(root, require.resolve(name)); }
        catch (error) {
          // Subpath-only exports are valid; requiring the bare name is not.
          if (error.code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') throw error;
        }
      }
      pending.push(metadataPath);
    }
  }
  return { packages: visited.size, dependencyEdges: edges };
}

export async function resolvePackagedModules(serverRoot, expectedVersion, options = {}) {
  assert.equal(typeof expectedVersion, 'string', 'Expected package version is required');
  assert.ok(expectedVersion.length > 0, 'Expected package version is required');
  const root = await realpath(serverRoot);
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  assert.equal(manifest.name, '@agentbrowser/api', 'Expected extracted API server package');
  assert.equal(manifest.version, expectedVersion, 'Server package version mismatch');
  const stamp = JSON.parse(await readFile(join(root, 'VERSION.json'), 'utf8'));
  assert.equal(stamp.version, expectedVersion, 'Packaged provenance version mismatch');
  assert.match(stamp.commit, /^[a-f0-9]{40}$/, 'Packaged provenance omitted commit');
  if (options.expectedCommit) assert.equal(stamp.commit, options.expectedCommit, 'Packaged commit mismatch');
  assert.ok(stamp.dirty === undefined || typeof stamp.dirty === 'boolean', 'Invalid packaged dirty stamp');
  assert.ok(!stamp.dirty || options.allowDirty === true, 'Dirty package requires explicit --allow-dirty; not release evidence');
  const contained = (path) => containedPath(root, path);
  // Inspect the entire extracted tree, not only selected entrypoints. A core
  // or transitive-dependency symlink must never silently load checkout code.
  const directories = [{ path: root, depth: 0 }];
  const visited = new Set([root]);
  let entries = 0;
  while (directories.length) {
    const directory = directories.pop();
    for (const entry of await readdir(directory.path, { withFileTypes: true })) {
      assert.ok(++entries <= 100_000, 'Extracted package tree exceeds audit entry limit');
      const candidate = join(directory.path, entry.name);
      const actual = entry.isSymbolicLink() ? await contained(candidate) : candidate;
      if ((entry.isDirectory() || (entry.isSymbolicLink() && (await stat(actual)).isDirectory())) && !visited.has(actual)) {
        assert.ok(directory.depth < 100, 'Extracted package tree exceeds audit depth limit');
        visited.add(actual); directories.push({ path: actual, depth: directory.depth + 1 });
      }
    }
  }
  const require = createRequire(join(root, 'package.json'));
  const closure = await auditDependencyClosure(root, expectedVersion);
  const api = await contained(join(root, 'dist/index.js'));
  const engine = await contained(require.resolve('@agentbrowser/engine-playwright'));
  const policy = await contained(require.resolve('@agentbrowser/policy'));
  const engineRequire = createRequire(engine);
  const playwright = await contained(engineRequire.resolve('playwright'));
  const playwrightCli = await contained(join(dirname(engineRequire.resolve('playwright/package.json')), 'cli.js'));
  return { root, api, engine, policy, playwright, playwrightCli, commit: stamp.commit, dirty: stamp.dirty ?? false, closure };
}

export async function apiRequest(baseUrl, path, options = {}) {
  const controller = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([options.signal, controller.signal])
    : controller.signal;
  let reader;
  try { return await within((async () => {
  const response = await (options.fetch ?? fetch)(`${baseUrl}${path}`, {
    method: options.method ?? 'GET', signal,
    headers: { ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}), ...(options.key ? { authorization: `Bearer ${options.key}` } : {}) },
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });
  let length = 0;
  const chunks = [];
  reader = response.body?.getReader();
    if (reader) for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.length;
      assert.ok(length <= (options.maxBytes ?? 8 * 1024 * 1024), 'HTTP response exceeded acceptance byte limit');
      chunks.push(value);
    }
  let result;
  try { result = JSON.parse(Buffer.concat(chunks).toString()); }
  catch { throw new Error('Invalid JSON response'); }
  if (!(options.statuses ?? [200, 201]).includes(response.status)) {
    throw new Error(`Unexpected HTTP status ${response.status} for ${options.method ?? 'GET'} ${path} (${result.error?.code ?? 'no error code'})`, { cause: result.error });
  }
  return result;
  })(), options.timeoutMs ?? 10_000, 'HTTP request'); }
  finally {
    controller.abort(new Error('HTTP request ownership ended'));
    if (reader) await within(reader.cancel(), 1000, 'HTTP reader cleanup');
  }
}

async function within(promise, timeoutMs, label) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} deadline exceeded`)), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}

/** Owns one process. A forced API kill is a failure: browser descendants are not proven drained. */
export async function withManagedChild(command, options, exercise) {
  const child = spawn(command[0], command.slice(1), {
    env: options.env ?? process.env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  const controller = new AbortController();
  let rejectFailure;
  let failureError;
  const failure = new Promise((_, reject) => { rejectFailure = reject; });
  failure.catch(() => {});
  const failed = (error) => {
    failureError ??= error;
    controller.abort(error);
    rejectFailure(error);
  };
  let ended = false;
  const closed = new Promise((resolve) => child.once('close', (code, signal) => {
    ended = true; resolve({ code, signal });
  }));
  child.on('error', failed);
  let outputBytes = 0;
  for (const stream of [child.stdout, child.stderr]) {
    stream.on('error', failed);
    stream.on('data', (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > (options.maxOutputBytes ?? MAX_OUTPUT)) failed(new Error('API child output exceeded limit'));
    });
  }
  const messages = [];
  let receiver;
  child.on('message', (value) => {
    if (receiver) { const receive = receiver; receiver = undefined; receive(value); }
    else if (messages.length < 16) messages.push(value);
    else failed(new Error('API child IPC output exceeded limit'));
  });
  const guard = (promise) => Promise.race([
    promise, failure, closed.then(({ code }) => { throw new Error(`API child exited early (${code})`); }),
  ]);
  const message = () => guard(messages.length ? Promise.resolve(messages.shift()) : new Promise((resolve) => {
    assert.equal(receiver, undefined, 'Concurrent IPC receives are not supported'); receiver = resolve;
  }));
  let sequence = 0;
  const rpc = async (method, params = {}) => {
    const id = ++sequence;
    child.send({ id, method, params }, (error) => { if (error) failed(error); });
    const reply = await message();
    assert.equal(reply.id, id, 'Unexpected child RPC reply');
    assert.ok(!reply.error, `Instrumented child failed: ${reply.error}`);
    return reply.result;
  };
  const timer = setTimeout(() => failed(new Error('API acceptance deadline exceeded')), options.timeoutMs ?? 90_000);
  let bodyError;
  let value;
  const body = Promise.resolve().then(() => exercise({ child, guard, message, rpc, signal: controller.signal }));
  body.catch(() => {});
  try { value = await guard(body); }
  catch (error) { bodyError = error; controller.abort(error); }
  let cleanupError;
  try {
    // The callback must settle too: a deadline cannot leave a workflow running
    // behind a PASS/FAIL result while its fixtures are being destroyed.
    await within(body.catch(() => {}), 5000, 'Workflow callback cleanup');
  } catch (error) { cleanupError = error; }
  try {
    clearTimeout(timer);
    if (!ended) {
      child.kill('SIGTERM');
      try {
        const result = await within(closed, options.shutdownMs ?? 10_000, 'API shutdown');
        if (!bodyError) assert.equal(result.code, 0, `API cleanup exited unsuccessfully (${result.code ?? result.signal})`);
      } catch (error) {
        if (!ended) {
          child.kill('SIGKILL');
          await within(closed, 2000, 'Forced child shutdown');
          throw new Error('Forced API cleanup: browser descendant cleanup remains unverified', { cause: bodyError ?? error });
        }
        throw error;
      }
    } else if (!bodyError) {
      assert.equal((await closed).code, 0, 'API cleanup exited unsuccessfully');
    }
  } catch (error) { cleanupError = error; }
  controller.abort(new Error('API process ownership ended'));
  if (cleanupError) throw new Error(`${cleanupError.message}${bodyError ? `; ${bodyError.message}` : ''}`, { cause: cleanupError });
  if (bodyError) throw bodyError;
  if (failureError) throw failureError;
  return value;
}

function cleanEnv(key) {
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (name.startsWith('AGENTBROWSER_') || /^(?:http|https|all|no)_proxy$/i.test(name) || ['HOST', 'PORT', 'NODE_PATH', 'NODE_OPTIONS', 'NODE_EXTRA_CA_CERTS', 'NODE_TLS_REJECT_UNAUTHORIZED', 'NODE_USE_ENV_PROXY'].includes(name)) delete env[name];
  }
  return { ...env, PATH: `${dirname(process.execPath)}:${env.PATH ?? ''}`, AGENTBROWSER_API_KEYS: `${key}:release-smoke` };
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return server.address().port;
}

async function waitFor(predicate, guard, label) {
  let stopped = false;
  try {
    await within(guard((async () => {
      while (!stopped && !(await predicate())) await new Promise((resolve) => setTimeout(resolve, 25));
    })()), 10_000, label);
  } finally { stopped = true; }
}

async function fixtures(directory) {
  const key = generateKeyPairSync('ec', { namedCurve: 'prime256v1', privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } }).privateKey;
  const keyPath = join(directory, 'fixture-key.pem');
  const certPath = join(directory, 'fixture-cert.pem');
  await writeFile(keyPath, key, { mode: 0o600 });
  const cert = (await runExecutable(['openssl', 'req', '-new', '-x509', '-key', keyPath, '-subj', '/CN=release-fixture', '-days', '2', '-addext', 'subjectAltName=IP:127.0.0.1'])).stdout;
  await writeFile(certPath, cert, { mode: 0o600 });
  const sockets = new Set();
  const stalled = new Set();
  const payload = Buffer.from('AgentBrowser packaged HTTP and TLS acceptance\n');
  let contacts = 0;
  const handler = (request, response) => {
    if (request.url === '/page') {
      response.setHeader('content-type', 'text/html');
      response.end('<!doctype html><title>Package acceptance</title><button onclick="document.title=\'Action complete\'">Continue</button><input id="choice" type="checkbox" aria-label="Choice" onclick="document.title=\'Unsafe action\'">');
    } else if (request.url === '/large') response.end(Buffer.alloc(4096, 120));
    else if (request.url === '/stall') {
      response.writeHead(200, { 'content-type': 'application/octet-stream' });
      response.write('pending'); stalled.add(request.socket);
      request.socket.once('close', () => stalled.delete(request.socket));
    } else { response.setHeader('content-type', 'application/octet-stream'); response.end(payload); }
  };
  const servers = [createHttpServer(handler), createHttpsServer({ key, cert }, handler)];
  const close = async () => {
    for (const socket of sockets) socket.destroy();
    await Promise.all(servers.map((server) => server.listening
      ? within(new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())), 2000, 'Fixture cleanup')
      : Promise.resolve()));
  };
  try {
    for (const server of servers) server.on('connection', (socket) => {
      contacts++; sockets.add(socket); socket.on('error', () => {});
      socket.once('close', () => sockets.delete(socket));
    });
    const http = `http://127.0.0.1:${await listen(servers[0])}`;
    const https = `https://127.0.0.1:${await listen(servers[1])}`;
    return { http, https, certPath, payload, stalled, get contacts() { return contacts; }, close };
  } catch (error) { await close(); throw error; }
}

async function workflow(baseUrl, key, fixture, process, options, report) {
  const sessions = new Set();
  const request = (path, args = {}) => process.guard(apiRequest(baseUrl, path, { key, signal: process.signal, ...args }));
  const surface = async (run, settings = {}) => {
    let child;
    const abort = () => child?.kill('SIGTERM');
    try {
      process.signal.throwIfAborted();
      return await run({ ...settings, onSpawn(value) {
        child = value;
        process.signal.addEventListener('abort', abort, { once: true });
        if (process.signal.aborted) abort();
      } });
    } finally { process.signal.removeEventListener('abort', abort); }
  };
  const create = async (policy = {}) => {
    const session = await request('/v1/sessions', { method: 'POST', body: { tenantId: 'release-smoke', policy } });
    sessions.add(session.sessionId);
    assert.equal(session.engine?.name, 'playwright-chromium', 'Acceptance must use real Chromium');
    assert.equal(session.idleTimeoutMs, options.profile === 'candidate' ? 600_000 : 120_000, 'Unexpected default idle timeout');
    const page = await request(`/v1/sessions/${session.sessionId}/pages`, { method: 'POST', body: {} });
    return { sessionId: session.sessionId, pageId: page.pageId, path: `/v1/sessions/${session.sessionId}/pages/${page.pageId}` };
  };
  const close = async (sessionId) => {
    await request(`/v1/sessions/${sessionId}`, { method: 'DELETE' });
    await request(`/v1/sessions/${sessionId}`, { statuses: [404] });
    sessions.delete(sessionId);
  };
  const expectCode = async (path, body, code, status = 403) => {
    const error = await request(path, { method: 'POST', body, statuses: [status] });
    assert.equal(error.error?.code, code);
  };
  const health = await request('/health');
  assert.equal(health.version, options.expectedVersion, 'Running server version mismatch');
  await process.guard(apiRequest(baseUrl, '/v1/sessions', { statuses: [401] }));
  await process.guard(apiRequest(baseUrl, '/v1/sessions', { key: 'incorrect-key', statuses: [401] }));
  try {
    const disabled = await create();
    const disabledContacts = fixture.contacts;
    await expectCode(`${disabled.path}/download`, { url: `${fixture.http}/file` }, 'DOWNLOAD_BLOCKED');
    assert.equal(fixture.contacts, disabledContacts, 'Disabled download contacted its destination');
    await close(disabled.sessionId);
    if (options.stock) {
      const page = await create({ allowDownloads: true });
      const contacts = fixture.contacts;
      await expectCode(`${page.path}/navigate`, { url: `${fixture.http}/page` }, 'POLICY_DENIED');
      await expectCode(`${page.path}/download`, { url: `${fixture.http}/file` }, 'POLICY_DENIED');
      assert.equal(fixture.contacts, contacts, 'Stock denied private endpoint received a TCP connection');
      await close(page.sessionId);
      report.push({ check: 'stock-version-auth-private-deny-download-default', status: 'pass' });
      return;
    }
    const page = await create({ allowDownloads: true, allowedHosts: ['127.0.0.1'], maxDownloadBytes: 1024 });
    await request(`${page.path}/navigate`, { method: 'POST', body: { url: `${fixture.http}/page` } });
    const listed = await request(`/v1/sessions/${page.sessionId}/pages`);
    assert.deepEqual(listed.pages.map((value) => ({ pageId: value.pageId, url: value.url })), [{ pageId: page.pageId, url: `${fixture.http}/page` }]);
    const observed = await request(`${page.path}/observe`, { method: 'POST', body: {} });
    assert.equal(observed.title, 'Package acceptance');
    const snapshot = await request(`${page.path}/snapshot`);
    const ref = snapshot.fields.find((field) => field.role === 'button' && field.label === 'Continue')?.ref;
    assert.ok(ref, 'Snapshot omitted actionable button');
    const action = await request(`${page.path}/act`, { method: 'POST', body: { action: 'click', target: { ref } } });
    assert.equal(action.status, 'success');
    assert.equal((await request(`${page.path}/snapshot`)).title, 'Action complete');
    for (const [route, kind] of [['screenshot', 'png'], ['pdf', 'pdf']]) {
      const metadata = await request(`${page.path}/${route}`, { method: 'POST', body: {} });
      const stored = await request(`/v1/sessions/${page.sessionId}/artifacts/${metadata.artifactId}`);
      assert.equal(stored.metadata?.artifactId, metadata.artifactId);
      const bytes = validateArtifact(stored, kind);
      if (kind === 'pdf') {
        const validation = await surface((settings) => validatePdf(bytes, settings));
        report.push({ check: 'packaged-PDF-parser-and-pages', status: 'pass', ...validation });
      }
    }
    for (const origin of [fixture.http, fixture.https]) {
      const metadata = await request(`${page.path}/download`, { method: 'POST', body: { url: `${origin}/file` } });
      const stored = await request(`/v1/sessions/${page.sessionId}/artifacts/${metadata.artifactId}`);
      assert.deepEqual(validateArtifact(stored, 'bytes'), fixture.payload);
    }
    await expectCode(`${page.path}/download`, { url: `${fixture.http}/large` }, 'DOWNLOAD_BLOCKED');
    const denied = await create({ allowDownloads: true, blockedHosts: ['127.0.0.1'] });
    const contacts = fixture.contacts;
    await expectCode(`${denied.path}/download`, { url: `${fixture.http}/file` }, 'POLICY_DENIED');
    assert.equal(fixture.contacts, contacts, 'Blocked host received TCP connection');
    await close(denied.sessionId);
    report.push({ check: 'packaged-browser-action-png-pdf-http-https-host-byte', status: 'pass' });

    if (options.profile === 'candidate') {
      const stalledPage = await create({ allowDownloads: true });
      const pending = request(`${stalledPage.path}/download`, { method: 'POST', body: { url: `${fixture.http}/stall` }, statuses: [404] });
      pending.catch(() => {});
      await waitFor(() => fixture.stalled.size === 1, process.guard, 'Upstream contact');
      await close(stalledPage.sessionId);
      assert.equal((await pending).error?.code, 'SESSION_NOT_FOUND');
      await waitFor(() => fixture.stalled.size === 0, process.guard, 'Cancelled upstream socket closure');
      await request(`/v1/sessions/${stalledPage.sessionId}`, { statuses: [404] });
      report.push({ check: 'session-close-cancels-packaged-download', status: 'pass' });
      await request(`${page.path}/navigate`, { method: 'POST', body: { url: `${fixture.http}/page` } });
      const beforeFallback = await request(`${page.path}/snapshot`);
      await process.rpc('snapshotMode', { pageId: page.pageId, mode: 'elements' });
      const fallback = await request(`${page.path}/snapshot`);
      assert.equal(fallback.revision, beforeFallback.revision, 'Unchanged element-to-document fallback churned revision');
      assert.deepEqual(fallback.fields.map((field) => field.ref), beforeFallback.fields.map((field) => field.ref), 'Unchanged fallback transition churned refs');
      const stable = await request(`${page.path}/snapshot`);
      const fallbackStats = await process.rpc('snapshotStats', { pageId: page.pageId });
      assert.ok(fallbackStats.elementFailures > 0 && fallbackStats.bodyCaptures > 0, 'Snapshot fallback hook was not exercised');
      assert.equal(fallbackStats.elementCaptures, 0, 'Fallback unexpectedly obtained element evidence');
      assert.equal(stable.revision, fallback.revision, 'Unchanged fallback churned refs');
      const button = fallback.fields.find((field) => field.role === 'button')?.ref;
      assert.ok(button);
      await request(`${page.path}/act`, { method: 'POST', body: { action: 'click', target: { ref: button } } });
      assert.equal((await request(`${page.path}/snapshot`)).title, 'Action complete');
      await request(`${page.path}/navigate`, { method: 'POST', body: { url: `${fixture.http}/page` } });
      const stale = await request(`${page.path}/snapshot`);
      const checkbox = stale.fields.find((field) => field.role === 'checkbox')?.ref;
      assert.ok(checkbox);
      await process.rpc('mutate', { pageId: page.pageId });
      await expectCode(`${page.path}/act`, { action: 'click', target: { ref: checkbox } }, 'STALE_TARGET', 400);
      assert.equal((await process.rpc('title', { pageId: page.pageId })), 'Package acceptance', 'Rejected stale action clicked');
      await process.rpc('snapshotMode', { pageId: page.pageId, mode: 'all' });
      const unavailable = await request(`${page.path}/snapshot`);
      const unsafe = unavailable.fields.find((field) => field.role === 'button')?.ref;
      assert.ok(unsafe);
      const missing = await request(`${page.path}/act`, { method: 'POST', body: { action: 'click', target: { ref: unsafe } }, statuses: [400] });
      assert.equal(missing.error?.code, 'STALE_TARGET');
      assert.equal(missing.error?.retryable, true);
      assert.equal(await process.rpc('title', { pageId: page.pageId }), 'Package acceptance', 'Missing evidence allowed an action');
      // An unnamed control still binds after the DOM-only fallback; prove its
      // element capture also fails, rather than stopping at the unbound case.
      await process.rpc('unnamedButton', { pageId: page.pageId });
      await process.rpc('snapshotMode', { pageId: page.pageId, mode: 'all' });
      const unproven = await request(`${page.path}/snapshot`);
      const unprovenRef = unproven.fields.find((field) => field.role === 'button')?.ref;
      assert.ok(unprovenRef);
      const unavailableStats = await process.rpc('snapshotStats', { pageId: page.pageId });
      assert.ok(unavailableStats.bodyFailures > 0 && unavailableStats.elementFailures > 0, 'Total snapshot failure hook was not exercised');
      assert.equal(unavailableStats.bodyCaptures + unavailableStats.elementCaptures, 0, 'Unexpected semantic capture in unavailable-evidence mode');
      const deniedAction = await request(`${page.path}/act`, { method: 'POST', body: { action: 'click', target: { ref: unprovenRef } }, statuses: [400] });
      assert.equal(deniedAction.error?.code, 'STALE_TARGET');
      assert.equal(deniedAction.error?.retryable, true);
      assert.equal(await process.rpc('title', { pageId: page.pageId }), 'Package acceptance', 'Unproven binding allowed an action');
      await process.rpc('snapshotMode', { pageId: page.pageId, mode: 'normal' });
      report.push({ check: 'instrumented-packaged-snapshot-evidence', status: 'pass' });
    } else report.push({ check: 'candidate-cancellation-snapshot-regressions', status: 'unsupported', reason: 'baseline profile' });

    await request(`${page.path}/navigate`, { method: 'POST', body: { url: `${fixture.http}/page` } });
    const cliEnv = { ...cleanEnv(key), AGENTBROWSER_BASE_URL: baseUrl, AGENTBROWSER_API_KEY: key };
    const cliArgs = ['--base-url', baseUrl, '--api-key', key, '--json'];
    const cliSnapshot = JSON.parse((await surface((settings) => runExecutable([...options.cli, ...cliArgs, 'snapshot', page.sessionId, page.pageId], settings), { env: cliEnv })).stdout);
    const cliRef = cliSnapshot.fields.find((field) => field.role === 'button')?.ref;
    assert.ok(cliRef);
    await surface((settings) => runExecutable([...options.cli, ...cliArgs, 'act', 'click', page.sessionId, page.pageId, cliRef], settings), { env: cliEnv });
    assert.equal((await request(`${page.path}/snapshot`)).title, 'Action complete');
    await surface((settings) => checkMcp(options.mcp, settings), { expectedVersion: options.expectedVersion, env: cliEnv, timeoutMs: 30_000, exercise: async ({ callTool }) => {
      const created = await callTool('browser_create', { tenantId: 'release-smoke' });
      sessions.add(created.sessionId);
      await callTool('browser_navigate', { sessionId: created.sessionId, pageId: created.pageId, url: `${fixture.http}/page` });
      assert.equal((await callTool('browser_snapshot', { sessionId: created.sessionId, pageId: created.pageId })).title, 'Package acceptance');
      await callTool('browser_close', { sessionId: created.sessionId });
      await request(`/v1/sessions/${created.sessionId}`, { statuses: [404] });
      sessions.delete(created.sessionId);
    } });
    report.push({ check: 'CLI-action-and-MCP-live-workflow', status: 'pass' });
    await close(page.sessionId);
  } finally {
    // Close every acquired session even if an assertion, child or tool failed.
    await Promise.all([...sessions].map((id) => apiRequest(baseUrl, `/v1/sessions/${id}`, { key, method: 'DELETE', timeoutMs: 2000, statuses: [200, 404] })));
  }
}

export async function checkPackagedServer(options) {
  assert.ok(['candidate', 'baseline'].includes(options.profile ?? 'candidate'), 'Unknown acceptance profile');
  options = { ...options, profile: options.profile ?? 'candidate' };
  const modules = await resolvePackagedModules(options.serverRoot, options.expectedVersion, options);
  assert.ok(options.cli?.length && options.mcp?.length, 'CLI and MCP command arrays are required');
  assert.ok(options.installBrowser || process.env.PLAYWRIGHT_BROWSERS_PATH, 'Set PLAYWRIGHT_BROWSERS_PATH to an existing cache or use --install-browser');
  const key = randomBytes(24).toString('hex');
  const baseEnv = cleanEnv(key);
  const cli = { command: options.cli, resolvedExecutable: await realpath(options.cli[0]), ...await checkCli(options.cli, { expectedVersion: options.expectedVersion, env: baseEnv }) };
  const mcp = { command: options.mcp, resolvedExecutable: await realpath(options.mcp[0]), ...await checkMcp(options.mcp, { expectedVersion: options.expectedVersion, env: baseEnv }) };
  const directory = await mkdtemp(join(tmpdir(), 'agentbrowser-package-acceptance-'));
  const report = [];
  let fixture;
  try {
    const env = { ...baseEnv, PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH ?? join(directory, 'browsers') };
    if (options.installBrowser) {
      await runExecutable([process.execPath, modules.playwrightCli, 'install', 'chromium'], {
        env, timeoutMs: 180_000, maxOutputBytes: 8 * MAX_OUTPUT,
      });
    }
    fixture = await fixtures(directory);
    const reservation = createTcpServer();
    const port = await listen(reservation);
    await new Promise((resolve) => reservation.close(resolve));
    const stockEnv = { ...env, HOST: '127.0.0.1', PORT: String(port) };
    const baseUrl = `http://127.0.0.1:${port}`;
    await withManagedChild([join(modules.root, 'agentbrowser-server')], { env: stockEnv }, async (process) => {
      await waitFor(async () => {
        try { await apiRequest(baseUrl, '/health', { timeoutMs: 300 }); return true; } catch { return false; }
      }, process.guard, 'Stock API readiness');
      await workflow(baseUrl, key, fixture, process, { ...options, stock: true }, report);
    });
    if (options.profile === 'baseline') {
      report.push({ check: 'injected-packaged-workflow', status: 'unsupported', reason: '1.8.4 lacks trusted ServerOptions.networkPolicy passthrough; no workspace fallback' });
    } else {
      await withManagedChild([process.execPath, childScript, modules.root, options.expectedVersion, modules.commit, options.allowDirty ? 'allow-dirty' : 'clean'], {
        env: { ...env, NODE_EXTRA_CA_CERTS: fixture.certPath },
      }, async (process) => {
        const ready = await process.message();
        assert.equal(ready.kind, 'ready', 'Packaged child did not become ready');
        assert.deepEqual(ready.modules, modules, 'Packaged child resolved unexpected dependencies');
        await workflow(ready.baseUrl, key, fixture, process, options, report);
      });
    }
  } finally {
    try { await fixture?.close(); }
    finally { await rm(directory, { recursive: true, force: true }); }
  }
  return { expectedVersion: options.expectedVersion, profile: options.profile, releaseEvidence: !modules.dirty && report.every((check) => check.status === 'pass'), platform: process.platform, arch: process.arch, node: process.version, modules, executables: { cli, mcp }, checks: report, cleanup: 'graceful API exits and fixture closure verified' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = new Map();
    for (let i = 2; i < process.argv.length; i++) {
      assert.ok(process.argv[i]?.startsWith('--'), 'Expected --option value pairs');
      assert.ok(!args.has(process.argv[i]), 'Duplicate acceptance option');
      if (['--install-browser', '--allow-dirty'].includes(process.argv[i])) args.set(process.argv[i], true);
      else {
        assert.ok(process.argv[i + 1] && !process.argv[i + 1].startsWith('--'), 'Expected --option value pairs');
        args.set(process.argv[i], process.argv[++i]);
      }
    }
    const allowed = ['--server-root', '--expected-version', '--expected-commit', '--cli', '--cli-entry', '--mcp', '--mcp-entry', '--profile', '--install-browser', '--allow-dirty', '--report'];
    assert.ok([...args.keys()].every((name) => allowed.includes(name)), 'Unknown acceptance option');
    for (const required of ['--server-root', '--expected-version', '--cli', '--mcp']) assert.ok(args.has(required), `Missing ${required}`);
    const command = (kind) => [resolve(args.get(`--${kind}`)), ...(args.has(`--${kind}-entry`) ? [resolve(args.get(`--${kind}-entry`))] : [])];
    const report = await checkPackagedServer({
      serverRoot: args.get('--server-root'), expectedVersion: args.get('--expected-version'),
      cli: command('cli'), mcp: command('mcp'), profile: args.get('--profile') ?? 'candidate',
      installBrowser: args.get('--install-browser') === true,
      expectedCommit: args.get('--expected-commit'), allowDirty: args.get('--allow-dirty') === true,
    });
    const output = JSON.stringify({ acceptance: report.checks.some((check) => check.status !== 'pass') ? 'PARTIAL' : 'PASS', ...report });
    if (args.has('--report')) await writeFile(resolve(args.get('--report')), `${output}\n`, { flag: 'wx', mode: 0o600 });
    console.log(output);
  } catch (error) { console.error(`package acceptance: FAIL - ${error.message}`); process.exitCode = 1; }
}
