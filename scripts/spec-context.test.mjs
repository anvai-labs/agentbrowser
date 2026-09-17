import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { checkSpecContext, loadSpecContext, main } from './spec-context.mjs';

const roots = [];
test.after(async () =>
  Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })))
);

async function fixture(update = (manifest) => manifest) {
  const root = await mkdtemp(join(tmpdir(), 'agentbrowser-spec-context-'));
  roots.push(root);
  const files = {
    'core.md': 'core invariant\n',
    'qa.md': 'qa mode\n',
    'appsec.md': 'appsec mode\n',
    'bounty.md': 'bounty mode\n',
    'contracts.md': 'contract details\n',
    'task-protocol.md': 'task protocol\n',
    't0.md': 'foundation task\n',
    't1.md': 'profile task\n',
  };
  let manifest = {
    schemaVersion: 1,
    status: 'fixture',
    purpose: 'test',
    always: ['core'],
    defaultView: 'agent',
    limits: {
      maxModuleBytes: 1024,
      maxCoreBytes: 1024,
      maxTaskPacketBytes: 1024,
      unit: 'UTF-8 bytes including emitted framing for complete bundle limits',
    },
    modules: {
      core: { path: 'core.md', requires: [] },
      'mode-qa': { path: 'qa.md', requires: ['core'] },
      'mode-appsec': { path: 'appsec.md', requires: ['core'] },
      'mode-bounty': { path: 'bounty.md', requires: ['mode-appsec'] },
      contracts: { path: 'contracts.md', requires: ['core'] },
      'task-protocol': { path: 'task-protocol.md', requires: ['core'] },
      'task-t0': { path: 't0.md', requires: ['task-protocol', 'contracts'] },
      'task-t1': { path: 't1.md', requires: ['task-protocol', 'contracts'] },
    },
    modes: {
      qa: { module: 'mode-qa', purpose: 'qa' },
      appsec: { module: 'mode-appsec', purpose: 'appsec' },
      bounty: { module: 'mode-bounty', purpose: 'bounty' },
    },
    views: {
      agent: { modules: [], maxBytes: 4096 },
      contracts: { modules: ['contracts'], maxBytes: 4096 },
      task: { modules: [], requiresTask: true, maxBytes: 4096 },
    },
    tasks: {
      t0: {
        module: 'task-t0',
        status: 'complete',
        dependsOn: [],
        modes: ['qa', 'appsec', 'bounty'],
      },
      t1: { module: 'task-t1', status: 'not_started', dependsOn: ['t0'], modes: ['qa'] },
    },
  };
  manifest = update(structuredClone(manifest));
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  await writeFile(join(root, 'manifest.json'), JSON.stringify(manifest));
  return { root, manifest };
}

test('loads deterministic dependency closure with hashes and exact complete-output bytes', async () => {
  const { root } = await fixture();
  const first = await loadSpecContext({ root, mode: 'qa', view: 'contracts', format: 'json' });
  const second = await loadSpecContext({ root, mode: 'qa', view: 'contracts', format: 'json' });
  assert.equal(first.output, second.output);
  assert.equal(first.serializedBytes, Buffer.byteLength(first.output));
  assert.deepEqual(
    first.modules.map(({ id }) => id),
    ['core', 'mode-qa', 'contracts']
  );
  assert.ok(first.modules.every(({ sha256 }) => /^[a-f0-9]{64}$/.test(sha256)));
  assert.equal(JSON.parse(first.output).serializedBytes, first.serializedBytes);
});

test('includes core for every mode and lets only bounty inherit appsec', async () => {
  const { root } = await fixture();
  const qa = await loadSpecContext({ root, mode: 'qa' });
  const bounty = await loadSpecContext({ root, mode: 'bounty' });
  assert.deepEqual(
    qa.modules.map(({ id }) => id),
    ['core', 'mode-qa']
  );
  assert.deepEqual(
    bounty.modules.map(({ id }) => id),
    ['core', 'mode-appsec', 'mode-bounty']
  );
});

test('the repository manifest keeps core universal and appsec inheritance bounty-only', async () => {
  for (const mode of ['qa', 'operations', 'audit', 'appsec', 'bounty', 'forms', 'application']) {
    const context = await loadSpecContext({ mode });
    const ids = context.modules.map(({ id }) => id);
    assert.equal(ids.includes('core'), true, `${mode} omitted core`);
    assert.equal(ids.includes('mode-appsec'), mode === 'appsec' || mode === 'bounty');
  }
});

test('task selection enforces mode, readiness and the task view without loading dependency packets', async () => {
  const { root } = await fixture();
  const task = await loadSpecContext({ root, mode: 'qa', task: 't1' });
  assert.equal(task.selection.view, 'task');
  assert.deepEqual(
    task.modules.map(({ id }) => id),
    ['core', 'mode-qa', 'task-protocol', 'contracts', 'task-t1']
  );
  assert.ok(!task.modules.some(({ id }) => id === 'task-t0'));
  await assert.rejects(
    loadSpecContext({ root, mode: 'appsec', task: 't1' }),
    /not available.*appsec/
  );
  await assert.rejects(
    loadSpecContext({ root, mode: 'qa', task: 't1', view: 'contracts' }),
    /requires the task view/
  );

  const pending = await fixture((manifest) => {
    manifest.tasks.t0.status = 'active';
    return manifest;
  });
  await assert.rejects(
    loadSpecContext({ root: pending.root, mode: 'qa', task: 't1' }),
    /dependency t0 is active/
  );
});

test('rejects unknown IDs, missing dependencies and dependency cycles', async () => {
  const { root } = await fixture();
  await assert.rejects(loadSpecContext({ root, mode: 'missing' }), /Unknown mode/);
  await assert.rejects(loadSpecContext({ root, mode: 'qa', view: 'missing' }), /Unknown view/);

  const missing = await fixture((manifest) => {
    manifest.modules['mode-qa'].requires.push('absent');
    return manifest;
  });
  await assert.rejects(
    loadSpecContext({ root: missing.root, mode: 'qa' }),
    /unknown module absent/
  );

  const cycle = await fixture((manifest) => {
    manifest.modules.core.requires.push('mode-qa');
    return manifest;
  });
  await assert.rejects(loadSpecContext({ root: cycle.root, mode: 'qa' }), /cycle/i);
});

test('rejects absolute, traversing and symlinked module paths', async () => {
  for (const path of ['/tmp/outside.md', '../outside.md']) {
    const candidate = await fixture((manifest) => {
      manifest.modules.core.path = path;
      return manifest;
    });
    await assert.rejects(loadSpecContext({ root: candidate.root, mode: 'qa' }), /path/);
  }

  const linked = await fixture();
  const outside = join(dirname(linked.root), 'outside-spec-context.md');
  roots.push(outside);
  await writeFile(outside, 'outside\n');
  await symlink(outside, join(linked.root, 'linked.md'));
  linked.manifest.modules.core.path = 'linked.md';
  await writeFile(join(linked.root, 'manifest.json'), JSON.stringify(linked.manifest));
  await assert.rejects(loadSpecContext({ root: linked.root, mode: 'qa' }), /symbolic link/);
});

test('rejects duplicate paths, non-files and invalid UTF-8', async () => {
  const duplicate = await fixture((manifest) => {
    manifest.modules['mode-qa'].path = 'core.md';
    return manifest;
  });
  await assert.rejects(loadSpecContext({ root: duplicate.root, mode: 'qa' }), /duplicate path/);

  const directory = await fixture((manifest) => {
    manifest.modules.core.path = 'directory.md';
    return manifest;
  });
  await mkdir(join(directory.root, 'directory.md'));
  await assert.rejects(loadSpecContext({ root: directory.root, mode: 'qa' }), /regular file/);

  const invalid = await fixture();
  await writeFile(join(invalid.root, 'core.md'), Buffer.from([0xc3, 0x28]));
  await assert.rejects(loadSpecContext({ root: invalid.root, mode: 'qa' }), /UTF-8/);
});

test('enforces file and complete serialized budgets without partial CLI output', async () => {
  const oversized = await fixture((manifest) => {
    manifest.limits.maxCoreBytes = 2;
    return manifest;
  });
  await assert.rejects(loadSpecContext({ root: oversized.root, mode: 'qa' }), /core.*budget/);

  const total = await fixture((manifest) => {
    manifest.views.agent.maxBytes = 20;
    return manifest;
  });
  const stdout = [];
  const stderr = [];
  assert.equal(
    await main(['--mode', 'qa'], {
      root: total.root,
      stdout: (value) => stdout.push(value),
      stderr: (value) => stderr.push(value),
    }),
    1
  );
  assert.deepEqual(stdout, []);
  assert.match(stderr.join(''), /budget/);
});

test('validates every allowed actual manifest selection and reports exact counts', async () => {
  const result = await checkSpecContext();
  assert.deepEqual(result, { modules: 30, modes: 7, views: 6, tasks: 10, selections: 82 });
  const active = await loadSpecContext({ mode: 'qa', task: 't1' });
  assert.equal(active.selection.task, 't1');
  assert.ok(active.modules.some(({ id }) => id === 'task-t1'));
  assert.ok(!active.modules.some(({ id }) => id === 'task-t0'));
});
