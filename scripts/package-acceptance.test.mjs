import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { apiRequest, auditDependencyClosure, resolvePackagedModules, validateArtifact, withManagedChild } from './package-acceptance.mjs';

test('artifact validation rejects empty, truncated and mismatched captures', () => {
  const capture = (bytes) => ({ metadata: { sizeBytes: bytes.length }, contentBase64: bytes.toString('base64') });
  assert.throws(() => validateArtifact(capture(Buffer.alloc(0)), 'png'), /empty/);
  assert.throws(() => validateArtifact(capture(Buffer.from('not a png')), 'png'), /PNG/);
  assert.throws(() => validateArtifact(capture(Buffer.from('%PDF-1.7')), 'pdf'), /PDF/);
  assert.throws(() => validateArtifact({ metadata: { sizeBytes: 99 }, contentBase64: 'eA==' }, 'bytes'), /size/);
  assert.equal(validateArtifact(capture(Buffer.from('payload')), 'bytes').toString(), 'payload');
});

test('package resolution rejects a checkout masquerading as an extracted package', async () => {
  await assert.rejects(resolvePackagedModules(process.cwd(), '1.8.5'), /package|server|extracted/i);
});

test('package resolution checks expected version before dependency loading', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agentbrowser-package-negative-'));
  try {
    await mkdir(join(directory, 'dist'));
    await writeFile(join(directory, 'package.json'), JSON.stringify({ name: '@agentbrowser/api', version: '0.0.0' }));
    await assert.rejects(resolvePackagedModules(directory, '1.8.5'), /version/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('package resolution rejects an escaped core dependency and dirty/mismatched provenance', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agentbrowser-package-boundary-'));
  const root = join(directory, 'server');
  try {
    await mkdir(join(root, 'node_modules/@agentbrowser'), { recursive: true });
    await mkdir(join(directory, 'outside-core'));
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: '@agentbrowser/api', version: '1.8.5' }));
    const stamp = { version: '1.8.5', commit: 'a'.repeat(40), dirty: true };
    await writeFile(join(root, 'VERSION.json'), JSON.stringify(stamp));
    await assert.rejects(resolvePackagedModules(root, '1.8.5'), /Dirty package/);
    await assert.rejects(resolvePackagedModules(root, '1.8.5', { expectedCommit: 'b'.repeat(40), allowDirty: true }), /commit mismatch/);
    await symlink(join(directory, 'outside-core'), join(root, 'node_modules/@agentbrowser/core'), 'dir');
    await assert.rejects(resolvePackagedModules(root, '1.8.5', { allowDirty: true }), /escapes extracted/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('dependency closure rejects ancestor transitive fallback and allows contained types-only dependencies', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agentbrowser-package-closure-'));
  const root = join(directory, 'server');
  const put = async (path, manifest) => {
    await mkdir(path, { recursive: true });
    await writeFile(join(path, 'package.json'), JSON.stringify(manifest));
    if (manifest.main) await writeFile(join(path, manifest.main), 'module.exports = {};');
  };
  try {
    await put(root, { name: 'server', dependencies: { parent: '1' } });
    await put(join(root, 'node_modules/parent'), { name: 'parent', main: 'index.cjs', dependencies: { nested: '1' }, optionalDependencies: { absent: '1' }, peerDependencies: { optionalPeer: '*' }, peerDependenciesMeta: { optionalPeer: { optional: true } } });
    await put(join(directory, 'node_modules/nested'), { name: 'nested', main: 'index.cjs' });
    await assert.rejects(auditDependencyClosure(root), /escapes extracted/);
    await put(join(root, 'node_modules/nested'), { name: 'nested', types: 'index.d.ts' });
    await writeFile(join(root, 'node_modules/nested/index.d.ts'), 'export interface Example {}');
    assert.equal((await auditDependencyClosure(root)).packages, 3);
    await put(join(directory, 'node_modules/absent'), { name: 'absent', main: 'index.cjs' });
    await assert.rejects(auditDependencyClosure(root), /escapes extracted/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('HTTP helper rejects error responses and malformed JSON', async () => {
  await assert.rejects(apiRequest('https://fixture.invalid', '/path', {
    fetch: async () => new Response(JSON.stringify({ error: { code: 'INTERNAL' } }), { status: 500 }),
  }), /500/);
  await assert.rejects(apiRequest('https://fixture.invalid', '/path', {
    fetch: async () => new Response('not json'),
  }), /JSON/);
});

test('HTTP helper rejects oversized bodies', async () => {
  await assert.rejects(apiRequest('https://fixture.invalid', '/path', {
    maxBytes: 8, fetch: async () => new Response('123456789'),
  }), /limit/);
});

test('HTTP deadline cancels stalled body consumption', async () => {
  let cancelled = false;
  const stream = new ReadableStream({ cancel() { cancelled = true; } });
  await assert.rejects(apiRequest('https://fixture.invalid', '/path', {
    timeoutMs: 30, fetch: async () => new Response(stream),
  }), /deadline/);
  assert.equal(cancelled, true);
});

test('managed child validates graceful shutdown and rejects late output/nonzero shutdown', async () => {
  for (const mode of ['clean', 'flood', 'nonzero']) {
    const command = [process.execPath, '-e', `process.on('SIGTERM',()=>{${mode === 'flood' ? 'process.stdout.write("x".repeat(4096));' : ''}process.exit(${mode === 'nonzero' ? 7 : 0});});process.send({ready:true});setInterval(()=>{},1000)`];
    const result = withManagedChild(command, { maxOutputBytes: 1024 }, async ({ message }) => { await message(); return 'done'; });
    if (mode === 'clean') assert.equal(await result, 'done');
    else await assert.rejects(result, mode === 'flood' ? /output/ : /cleanup.*unsuccessfully/);
  }
});

test('managed child deadline aborts waiting work and closes a never-ready child', async () => {
  let pid;
  await assert.rejects(withManagedChild([process.execPath, '-e', 'setInterval(()=>{},1000)'], {
    timeoutMs: 50,
  }, async ({ child, message }) => { pid = child.pid; await message(); }), /deadline/);
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});

test('managed child detects early exit and cleans an assertion failure', async () => {
  await assert.rejects(withManagedChild([process.execPath, '-e', 'process.exit(7)'], {}, async ({ guard }) => {
    await guard(new Promise(() => {}));
  }), /exited/);
  let pid;
  await assert.rejects(withManagedChild([process.execPath, '-e', 'setInterval(()=>{},1000)'], {}, async ({ child }) => {
    pid = child.pid;
    throw new Error('injected assertion');
  }), /injected assertion/);
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});

test('managed child rejects output flood and forced shutdown cannot pass cleanup', async () => {
  await assert.rejects(withManagedChild([process.execPath, '-e', 'process.stdout.write("x".repeat(4096));setInterval(()=>{},1000)'], {
    maxOutputBytes: 1024,
  }, async ({ guard }) => guard(new Promise(() => {}))), /output/);
  let pid;
  await assert.rejects(withManagedChild([process.execPath, '-e', 'process.on("SIGTERM",()=>{});process.send({ready:true});setInterval(()=>{},1000)'], {
    shutdownMs: 50, timeoutMs: 1000,
  }, async ({ child, message }) => {
    pid = child.pid;
    await message();
  }), /forced|cleanup/);
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});
