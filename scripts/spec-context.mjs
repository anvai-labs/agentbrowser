#!/usr/bin/env node
/** Dependency-free, all-or-nothing loader for the modular specification manifest. */
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const defaultRoot = fileURLToPath(new URL('../docs/spec/', import.meta.url));
const utf8 = new TextDecoder('utf-8', { fatal: true });
const hash = (content) => createHash('sha256').update(content).digest('hex');
const bytes = (content) => Buffer.byteLength(content, 'utf8');
const record = (value) => value && typeof value === 'object' && !Array.isArray(value);

function fail(message) {
  throw new Error(`Invalid spec context: ${message}`);
}

function stringArray(value, name) {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || !entry))
    fail(`${name} must be an array of non-empty strings`);
  return value;
}

function positiveInteger(value, name) {
  if (!Number.isInteger(value) || value <= 0) fail(`${name} must be a positive integer`);
  return value;
}

function decodeUtf8(value, name) {
  try {
    return utf8.decode(value);
  } catch {
    fail(`${name} is not valid UTF-8`);
  }
}

function validateGraph(nodes, dependencyOf, label) {
  const visiting = new Set();
  const visited = new Set();
  const visit = (id, trail = []) => {
    if (!nodes[id]) fail(`${label} references unknown ${label} ${id}`);
    if (visiting.has(id)) fail(`${label} dependency cycle: ${[...trail, id].join(' -> ')}`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of dependencyOf(nodes[id], id)) visit(dependency, [...trail, id]);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of Object.keys(nodes)) visit(id);
}

function validateManifest(manifest) {
  if (!record(manifest) || manifest.schemaVersion !== 1) fail('manifest schemaVersion must be 1');
  if (!record(manifest.modules) || Object.keys(manifest.modules).length === 0)
    fail('manifest modules are required');
  if (!record(manifest.modes) || !record(manifest.views) || !record(manifest.tasks))
    fail('manifest modes, views and tasks are required');
  if (!record(manifest.limits)) fail('manifest limits are required');

  stringArray(manifest.always, 'always');
  positiveInteger(manifest.limits.maxModuleBytes, 'limits.maxModuleBytes');
  positiveInteger(manifest.limits.maxCoreBytes, 'limits.maxCoreBytes');
  positiveInteger(manifest.limits.maxTaskPacketBytes, 'limits.maxTaskPacketBytes');

  const paths = new Set();
  for (const [id, module] of Object.entries(manifest.modules)) {
    if (!record(module) || typeof module.path !== 'string' || !module.path.endsWith('.md'))
      fail(`module ${id} must declare a Markdown path`);
    if (isAbsolute(module.path) || module.path.split(/[\\/]/).includes('..'))
      fail(`module ${id} path must stay under the spec root`);
    if (paths.has(module.path)) fail(`module ${id} has a duplicate path`);
    paths.add(module.path);
    stringArray(module.requires, `module ${id} requires`);
  }
  validateGraph(manifest.modules, (module) => module.requires, 'module');
  for (const id of manifest.always) {
    if (!manifest.modules[id]) fail(`always references unknown module ${id}`);
  }

  for (const [id, mode] of Object.entries(manifest.modes)) {
    if (!record(mode) || typeof mode.module !== 'string' || !manifest.modules[mode.module])
      fail(`mode ${id} references an unknown module`);
  }
  for (const [id, view] of Object.entries(manifest.views)) {
    if (!record(view)) fail(`view ${id} must be an object`);
    stringArray(view.modules, `view ${id} modules`);
    positiveInteger(view.maxBytes, `view ${id} maxBytes`);
    for (const moduleId of view.modules) {
      if (!manifest.modules[moduleId]) fail(`view ${id} references unknown module ${moduleId}`);
    }
  }
  if (typeof manifest.defaultView !== 'string' || !manifest.views[manifest.defaultView])
    fail('defaultView references an unknown view');

  for (const [id, task] of Object.entries(manifest.tasks)) {
    if (!record(task) || typeof task.module !== 'string' || !manifest.modules[task.module])
      fail(`task ${id} references an unknown module`);
    stringArray(task.dependsOn, `task ${id} dependsOn`);
    stringArray(task.modes, `task ${id} modes`);
    for (const mode of task.modes) {
      if (!manifest.modes[mode]) fail(`task ${id} references unknown mode ${mode}`);
    }
    if (task.conditionalDependencies !== undefined) {
      if (!Array.isArray(task.conditionalDependencies))
        fail(`task ${id} conditionalDependencies must be an array`);
      for (const [index, condition] of task.conditionalDependencies.entries()) {
        if (!record(condition))
          fail(`task ${id} conditional dependency ${index} must be an object`);
        if (condition.modes === undefined && typeof condition.slice !== 'string')
          fail(`task ${id} conditional dependency ${index} needs modes or a slice`);
        if (condition.modes !== undefined)
          stringArray(condition.modes, `task ${id} conditional dependency ${index} modes`);
        stringArray(condition.dependsOn, `task ${id} conditional dependency ${index} dependsOn`);
        for (const mode of condition.modes ?? []) {
          if (!manifest.modes[mode])
            fail(`task ${id} conditional dependency references unknown mode ${mode}`);
        }
      }
    }
  }
  validateGraph(
    manifest.tasks,
    (task) => [
      ...task.dependsOn,
      ...(task.conditionalDependencies ?? []).flatMap((condition) => condition.dependsOn),
    ],
    'task'
  );
  return manifest;
}

async function readManifest(root) {
  const boundary = await realpath(root);
  let manifest;
  try {
    manifest = JSON.parse(
      decodeUtf8(await readFile(join(boundary, 'manifest.json')), 'manifest.json')
    );
  } catch (error) {
    fail(`cannot read manifest: ${error instanceof Error ? error.message : 'unknown error'}`);
  }
  return { boundary, manifest: validateManifest(manifest) };
}

function dependencyClosure(manifest, roots) {
  const selected = [];
  const visited = new Set();
  const visit = (id) => {
    if (visited.has(id)) return;
    for (const dependency of manifest.modules[id].requires) visit(dependency);
    visited.add(id);
    selected.push(id);
  };
  for (const id of roots) visit(id);
  return selected;
}

function inside(boundary, candidate) {
  const path = relative(boundary, candidate);
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path));
}

async function readModule(boundary, manifest, id) {
  const declared = manifest.modules[id].path;
  const candidate = resolve(boundary, declared);
  if (!inside(boundary, candidate)) fail(`module ${id} path escapes the spec root`);
  let cursor = boundary;
  let finalEntry;
  for (const part of declared.split(/[\\/]/)) {
    cursor = join(cursor, part);
    let entry;
    try {
      entry = await lstat(cursor);
    } catch {
      fail(`module ${id} path does not exist`);
    }
    if (entry.isSymbolicLink()) fail(`module ${id} path contains a symbolic link`);
    finalEntry = entry;
  }
  if (!finalEntry?.isFile()) fail(`module ${id} path must be a regular file`);
  const actual = await realpath(candidate);
  if (!inside(boundary, actual)) fail(`module ${id} path escapes the spec root`);
  const content = decodeUtf8(await readFile(actual), `module ${id}`);
  const byteCount = bytes(content);
  const limit =
    id === 'core'
      ? manifest.limits.maxCoreBytes
      : Object.values(manifest.tasks).some((task) => task.module === id)
        ? manifest.limits.maxTaskPacketBytes
        : manifest.limits.maxModuleBytes;
  if (byteCount > limit) fail(`module ${id} exceeds its ${id === 'core' ? 'core ' : ''}budget`);
  return { id, path: declared, bytes: byteCount, sha256: hash(content), content };
}

function taskDependencies(task, mode) {
  return [
    ...task.dependsOn,
    ...(task.conditionalDependencies ?? [])
      .filter((condition) => condition.modes?.includes(mode))
      .flatMap((condition) => condition.dependsOn),
  ];
}

function select(manifest, { mode, view, task, ignoreTaskReadiness = false }) {
  if (typeof mode !== 'string' || !manifest.modes[mode]) fail(`Unknown mode: ${String(mode)}`);
  if (view !== undefined && !manifest.views[view]) fail(`Unknown view: ${view}`);
  let selectedView = view ?? manifest.defaultView;
  let selectedTask;
  if (task !== undefined) {
    selectedTask = manifest.tasks[task];
    if (!selectedTask) fail(`Unknown task: ${task}`);
    if (view !== undefined && view !== 'task') fail(`task ${task} requires the task view`);
    selectedView = 'task';
    if (!manifest.views.task?.requiresTask) fail('task view is not configured');
    if (!selectedTask.modes.includes(mode)) fail(`task ${task} is not available in mode ${mode}`);
    if (!ignoreTaskReadiness) {
      for (const dependency of taskDependencies(selectedTask, mode)) {
        const status = manifest.tasks[dependency].status;
        if (status !== 'complete') fail(`task ${task} dependency ${dependency} is ${status}`);
      }
    }
  } else if (manifest.views[selectedView].requiresTask) {
    fail(`view ${selectedView} requires a task`);
  }
  const roots = [
    ...manifest.always,
    manifest.modes[mode].module,
    ...manifest.views[selectedView].modules,
    ...(selectedTask ? [selectedTask.module] : []),
  ];
  return {
    selection: { mode, view: selectedView, ...(task ? { task } : {}) },
    moduleIds: dependencyClosure(manifest, roots),
    maxBytes: manifest.views[selectedView].maxBytes,
  };
}

function renderBundle(selection, modules, format, serializedBytes) {
  const contentBytes = modules.reduce((total, module) => total + module.bytes, 0);
  if (format === 'json') {
    return `${JSON.stringify(
      { schemaVersion: 1, selection, contentBytes, serializedBytes, modules },
      null,
      2
    )}\n`;
  }
  if (format !== 'markdown') fail(`Unknown format: ${format}`);
  const lines = [
    '# AgentBrowser specification context',
    '',
    `Selection: ${JSON.stringify(selection)}`,
    `Content bytes: ${contentBytes}`,
    `Serialized bytes: ${serializedBytes}`,
    '',
  ];
  for (const module of modules) {
    lines.push(
      `## Module \`${module.id}\``,
      '',
      `Path: \`${module.path}\`  `,
      `SHA-256: \`${module.sha256}\`  `,
      `UTF-8 bytes: ${module.bytes}`,
      '',
      module.content.replace(/\n$/, ''),
      ''
    );
  }
  return `${lines.join('\n')}\n`;
}

function serialize(selection, modules, format) {
  let expected = 0;
  for (let attempt = 0; attempt < 8; attempt++) {
    const output = renderBundle(selection, modules, format, expected);
    const actual = bytes(output);
    if (actual === expected) return { output, serializedBytes: actual };
    expected = actual;
  }
  fail('serialized byte count did not converge');
}

export async function loadSpecContext({
  root = defaultRoot,
  mode,
  view,
  task,
  format = 'markdown',
  ignoreTaskReadiness = false,
} = {}) {
  const { boundary, manifest } = await readManifest(root);
  const chosen = select(manifest, { mode, view, task, ignoreTaskReadiness });
  const modules = [];
  for (const id of chosen.moduleIds) modules.push(await readModule(boundary, manifest, id));
  const rendered = serialize(chosen.selection, modules, format);
  if (rendered.serializedBytes > chosen.maxBytes)
    fail(
      `${chosen.selection.view} output exceeds its complete serialized budget ` +
        `(${rendered.serializedBytes} > ${chosen.maxBytes} bytes)`
    );
  return { ...chosen, modules, ...rendered };
}

export async function checkSpecContext({ root = defaultRoot } = {}) {
  const { boundary, manifest } = await readManifest(root);
  for (const id of Object.keys(manifest.modules)) await readModule(boundary, manifest, id);
  let selections = 0;
  for (const mode of Object.keys(manifest.modes)) {
    for (const [view, descriptor] of Object.entries(manifest.views)) {
      if (descriptor.requiresTask) continue;
      await loadSpecContext({ root: boundary, mode, view });
      selections++;
    }
  }
  for (const [task, descriptor] of Object.entries(manifest.tasks)) {
    for (const mode of descriptor.modes) {
      await loadSpecContext({
        root: boundary,
        mode,
        task,
        ignoreTaskReadiness: true,
      });
      selections++;
    }
  }
  return {
    modules: Object.keys(manifest.modules).length,
    modes: Object.keys(manifest.modes).length,
    views: Object.keys(manifest.views).length,
    tasks: Object.keys(manifest.tasks).length,
    selections,
  };
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (['--list', '--check', '--help'].includes(argument)) {
      options[argument.slice(2)] = true;
      continue;
    }
    if (['--mode', '--view', '--task', '--format'].includes(argument)) {
      const value = argv[++index];
      if (!value || value.startsWith('--')) fail(`${argument} requires a value`);
      options[argument.slice(2)] = value;
      continue;
    }
    fail(`Unknown argument: ${argument}`);
  }
  return options;
}

export async function main(
  argv = process.argv.slice(2),
  {
    root = defaultRoot,
    stdout = (value) => process.stdout.write(value),
    stderr = (value) => process.stderr.write(value),
  } = {}
) {
  try {
    const options = parseArguments(argv);
    if (options.help) {
      stdout(
        'usage: spec-context --mode <id> [--view <id> | --task <id>] [--format markdown|json]\n       spec-context --list | --check\n'
      );
      return 0;
    }
    if (options.check) {
      stdout(`${JSON.stringify(await checkSpecContext({ root }))}\n`);
      return 0;
    }
    const { manifest } = await readManifest(root);
    if (options.list) {
      stdout(
        `${JSON.stringify(
          {
            schemaVersion: manifest.schemaVersion,
            defaultView: manifest.defaultView,
            modes: manifest.modes,
            views: manifest.views,
            tasks: manifest.tasks,
          },
          null,
          2
        )}\n`
      );
      return 0;
    }
    const result = await loadSpecContext({
      root,
      mode: options.mode,
      view: options.view,
      task: options.task,
      format: options.format ?? 'markdown',
    });
    stdout(result.output);
    return 0;
  } catch (error) {
    stderr(`${error instanceof Error ? error.message : 'Invalid spec context'}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
