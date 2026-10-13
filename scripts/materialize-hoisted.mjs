/**
 * Turn a pnpm isolated deploy into an equivalent link-free (hoisted) tree.
 *
 * Windows cannot extract pnpm's symlinked layout without Developer Mode, so
 * the win32 server ships hoisted. pnpm 9's own hoisted `deploy` cannot be
 * used: it ignores pnpm-lock.yaml and re-resolves from the registry (and
 * fails across drive letters on Windows). Instead the lockfile-faithful
 * isolated deploy — the same tree macOS and Linux ship — stays the single
 * source of truth, and this module copies it into a hoisted layout:
 *
 * 1. Read the dependency graph the way Node will load it: every package's
 *    declared dependencies resolved with Node's node_modules lookup, from
 *    the package's real directory (so pnpm's layout is not assumed).
 * 2. Place packages breadth-first, each at the highest ancestor of its
 *    dependent that is free for that name, below any conflicting copy, and
 *    not shadowing a resolution already made through it (shallow trees keep
 *    Windows paths under MAX_PATH).
 * 3. Copy each placed package (refusing links inside packages), then
 *    re-verify every dependency edge against the written tree with the same
 *    lookup: the output must load exactly the instances the input loads.
 */
import assert from 'node:assert/strict';
import { copyFile, mkdir, readdir, readFile, realpath, stat } from 'node:fs/promises';
import { basename, dirname, join, relative } from 'node:path';

const TARGET = { os: 'win32', cpu: 'x64' };

async function isPackageDir(path) {
  try {
    return (await stat(join(path, 'package.json'))).isFile();
  } catch {
    return false;
  }
}

/** Node's lookup for `name` from directory `from`, bounded to `top`. */
async function lookup(from, name, top) {
  let current = from;
  for (;;) {
    if (basename(current) !== 'node_modules') {
      const candidate = join(current, 'node_modules', name);
      if (await isPackageDir(candidate)) return realpath(candidate);
    }
    if (current === top) return undefined;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

/** npm's os/cpu semantics: '!x' excludes x; a positive list must name x. */
function admits(list, value) {
  if (!Array.isArray(list) || list.length === 0) return true;
  if (list.includes(`!${value}`)) return false;
  const positives = list.filter((entry) => !entry.startsWith('!'));
  return positives.length === 0 || positives.includes(value);
}

const runsOnTarget = (manifest) => admits(manifest.os, TARGET.os) && admits(manifest.cpu, TARGET.cpu);

/** Names a package ships inside itself (npm bundleDependencies; `true` = all). */
function bundledNames(manifest) {
  const bundled = manifest.bundleDependencies ?? manifest.bundledDependencies;
  if (bundled === true) return new Set(Object.keys(manifest.dependencies ?? {}));
  return new Set(Array.isArray(bundled) ? bundled : []);
}

// A cycle of conflicting versions (a@1 -> b@2 -> a@2 -> b@1 -> a@1) has no
// finite hoisted layout: each copy needs another nested copy. Real trees sit
// far below both bounds (the server: depth 3, ~1 placement per package).
const MAX_NESTING = 32;
const MAX_PLACEMENTS_PER_PACKAGE = 20;

async function readGraph(root) {
  const instances = new Map();
  const queue = [];
  const load = async (dir, isRoot = false) => {
    if (!instances.has(dir)) {
      const manifest = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
      const node = {
        dir,
        manifest,
        label: isRoot ? '(root)' : `${manifest.name}@${manifest.version}`,
        deps: new Map(),
      };
      instances.set(dir, node);
      queue.push(node);
    }
    return instances.get(dir);
  };
  const rootNode = await load(root, true);
  while (queue.length > 0) {
    const node = queue.shift();
    const { dependencies = {}, optionalDependencies = {}, peerDependencies = {} } = node.manifest;
    // Bundled dependencies travel inside their package (copyPackage keeps
    // them); they are not separate instances to place.
    const bundled = bundledNames(node.manifest);
    const edges = [
      ...Object.keys(dependencies)
        .filter((name) => !(name in optionalDependencies))
        .map((name) => [name, 'required']),
      ...Object.keys(optionalDependencies).map((name) => [name, 'optional']),
      ...Object.keys(peerDependencies)
        .filter((name) => !(name in dependencies) && !(name in optionalDependencies))
        .map((name) => [name, 'peer']),
    ]
      .filter(([name]) => !bundled.has(name))
      .sort(([a], [b]) => a.localeCompare(b));
    for (const [name, kind] of edges) {
      const dir = await lookup(node.dir, name, root);
      if (dir === undefined) {
        if (kind === 'required') {
          throw new Error(`${node.label} requires ${name}, which the deployed tree does not contain`);
        }
        if (kind === 'optional' && name.includes('win32')) {
          throw new Error(
            `${node.label}: Windows binary ${name} is missing (the tree was built on another platform); package on Windows`
          );
        }
        continue; // absent optional/peer: Node fails the same way at require time
      }
      const target = await load(dir);
      if (!runsOnTarget(target.manifest)) {
        if (kind === 'optional') continue; // e.g. fsevents on a macOS build host
        throw new Error(`${target.label} (needed by ${node.label}) does not support win32-x64`);
      }
      node.deps.set(name, target);
    }
  }
  return { rootNode, packageCount: instances.size };
}

function place(rootNode, packageCount) {
  const root = { path: '', node: rootNode, modules: new Map(), parent: undefined, depth: 0 };
  const placements = [root];
  const queue = [root];
  // Every resolution made so far: (placement, name) -> the placement holding it.
  // A new package may not land where it would shadow one of these.
  const resolved = [];
  const isWithin = (placement, ancestor) => {
    for (let at = placement; at; at = at.parent) if (at === ancestor) return true;
    return false;
  };
  const isAbove = (holder, level) => holder !== level && isWithin(level, holder);
  while (queue.length > 0) {
    const holder = queue.shift();
    for (const [name, target] of holder.node.deps) {
      let found;
      for (let at = holder; at && !found; at = at.parent) found = at.modules.get(name);
      if (found?.node === target) {
        resolved.push({ from: holder, name, to: found });
        continue;
      }
      // Highest level from the dependent upward that is still below any
      // conflicting copy, and under which no earlier resolution of this
      // name passes through to a higher holder (it would be shadowed).
      let into = holder;
      for (let level = holder.parent; level && level.modules.get(name) === undefined; level = level.parent) {
        // Compare by the directory that holds a package (its parent), not
        // the package itself.
        const shadows = resolved.some(
          (r) => r.name === name && isWithin(r.from, level) && isAbove(r.to.parent, level)
        );
        if (shadows) break;
        if (found && !isAbove(found.parent, level)) break;
        into = level;
      }
      assert.ok(!into.modules.has(name), `hoisting invariant broken for ${name}`);
      const placement = {
        path: join(into.path, 'node_modules', name),
        node: target,
        modules: new Map(),
        parent: into,
        depth: into.depth + 1,
      };
      if (placement.depth > MAX_NESTING || placements.length >= packageCount * MAX_PLACEMENTS_PER_PACKAGE) {
        throw new Error(
          `no finite hoisted layout: ${target.label} (needed by ${holder.node.label}) keeps requiring nested copies — a dependency cycle between conflicting versions`
        );
      }
      into.modules.set(name, placement);
      placements.push(placement);
      queue.push(placement);
      resolved.push({ from: holder, name, to: placement });
    }
  }
  return placements;
}

/** Copy a directory as is, refusing links (a Windows tree cannot carry them). */
async function copyTree(from, to, node, top) {
  await mkdir(to, { recursive: true });
  for (const entry of await readdir(from, { withFileTypes: true })) {
    const source = join(from, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`${node.label} contains a link (${relative(top, source)}); a Windows tree cannot carry links`);
    }
    if (entry.isDirectory()) await copyTree(source, join(to, entry.name), node, top);
    else if (entry.isFile()) await copyFile(source, join(to, entry.name));
  }
}

/**
 * Copy a package's own files; its dependencies come from the placement. A
 * package that bundles dependencies ships its whole real node_modules: npm
 * and pnpm keep the bundled packages there together with their own
 * (flattened) dependencies, so copying only the named ones would drop those.
 */
async function copyPackage(from, to, node, bundled) {
  await mkdir(to, { recursive: true });
  for (const entry of await readdir(from, { withFileTypes: true })) {
    const source = join(from, entry.name);
    if (entry.isDirectory() && entry.name === 'node_modules' && !entry.isSymbolicLink()) {
      if (bundled.length > 0) await copyTree(source, join(to, 'node_modules'), node, from);
      continue;
    }
    if (entry.isSymbolicLink()) {
      throw new Error(`${node.label} contains a link (${entry.name}); a Windows tree cannot carry links`);
    }
    if (entry.isDirectory()) await copyTree(source, join(to, entry.name), node, from);
    else if (entry.isFile()) await copyFile(source, join(to, entry.name));
  }
  for (const name of bundled) {
    if (!(await isPackageDir(join(from, 'node_modules', name)))) {
      throw new Error(`${node.label} bundles ${name}, but the deployed package does not contain it`);
    }
  }
}

export async function materializeHoisted(isolatedRoot, output) {
  const root = await realpath(isolatedRoot);
  const { rootNode, packageCount } = await readGraph(root);
  const placements = place(rootNode, packageCount);
  await mkdir(output, { recursive: true });
  for (const { path, node } of placements) {
    const bundled = node === rootNode ? [] : [...bundledNames(node.manifest)];
    await copyPackage(node.dir, join(output, path), node, bundled);
  }
  // Independent check on the written files: every edge must load the same instance.
  const top = await realpath(output);
  const byDir = new Map(placements.map((placement) => [join(top, placement.path), placement.node]));
  for (const { path, node } of placements) {
    for (const [name, target] of node.deps) {
      const resolved = await lookup(join(top, path), name, top);
      const loaded = resolved === undefined ? undefined : byDir.get(resolved);
      assert.equal(
        loaded,
        target,
        `hoisted tree resolves ${name} from ${node.label} to ${loaded?.label ?? 'nothing'}, expected ${target.label}`
      );
    }
  }
  const labels = [...new Set(placements.filter((p) => p.node !== rootNode).map((p) => p.node.label))].sort();
  return { packages: labels, placements: placements.length - 1, nested: placements.filter((p) => p.parent && p.parent.path !== '').length };
}
