import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { materializeHoisted } from './materialize-hoisted.mjs';

// Builds a pnpm-isolated-style tree: real package dirs in .pnpm/<id>/node_modules/<name>,
// dependencies as sibling symlinks, top-level deps as links in root/node_modules.
async function isolated(root, { rootDeps, packages }) {
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'app', version: '1.0.0', dependencies: Object.fromEntries(rootDeps.map((d) => [d.slice(0, d.indexOf('@', 1)), '*'])) }));
  await mkdir(join(root, 'dist'), { recursive: true });
  await writeFile(join(root, 'dist/index.js'), '');
  const dirOf = (id) => {
    const name = id.slice(0, id.indexOf('@', 1));
    return { name, dir: join(root, 'node_modules/.pnpm', id.replace('/', '+'), 'node_modules', name) };
  };
  for (const [id, spec] of Object.entries(packages)) {
    const { name, dir } = dirOf(id);
    await mkdir(dir, { recursive: true });
    const version = id.slice(id.indexOf('@', 1) + 1).split('_')[0];
    const manifest = { name, version, main: 'index.js', dependencies: {}, ...(spec.manifest ?? {}) };
    for (const dep of spec.deps ?? []) manifest.dependencies[dirOf(dep).name] = '*';
    for (const dep of spec.optional ?? []) (manifest.optionalDependencies ??= {})[dep] = '*';
    await writeFile(join(dir, 'package.json'), JSON.stringify(manifest));
    await writeFile(join(dir, 'index.js'), `module.exports = ${JSON.stringify(id)};`);
    for (const dep of spec.deps ?? []) {
      const target = dirOf(dep);
      const link = join(dirname2(dir, name), target.name);
      await mkdir(join(link, '..'), { recursive: true });
      await symlink(relative(join(link, '..'), target.dir), link);
    }
  }
  for (const dep of rootDeps) {
    const target = dirOf(dep);
    const link = join(root, 'node_modules', target.name);
    await mkdir(join(link, '..'), { recursive: true });
    await symlink(relative(join(link, '..'), target.dir), link);
  }
}
const dirname2 = (dir, name) => (name.startsWith('@') ? join(dir, '..', '..') : join(dir, '..'));

/** What Node actually loads from `from` for `name` in the materialized tree. */
function loads(tree, from, name) {
  const req = createRequire(join(tree, from, 'package.json'));
  return req(name);
}

async function withTrees(exercise) {
  const base = await mkdtemp(join(tmpdir(), 'materialize-'));
  try {
    await mkdir(join(base, 'iso'));
    await exercise(join(base, 'iso'), join(base, 'out'));
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

async function links(dir) {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isSymbolicLink()) found.push(join(entry.parentPath, entry.name));
  }
  return found;
}

test('flattens a simple graph with no links and identical resolution', async () => {
  await withTrees(async (iso, out) => {
    await isolated(iso, { rootDeps: ['a@1.0.0'], packages: { 'a@1.0.0': { deps: ['b@2.0.0'] }, 'b@2.0.0': {} } });
    const report = await materializeHoisted(iso, out);
    assert.deepEqual(await links(out), []);
    assert.equal(loads(out, '', 'a'), 'a@1.0.0');
    assert.equal(loads(out, 'node_modules/a', 'b'), 'b@2.0.0');
    assert.ok(!(await lstat(join(out, 'node_modules/.pnpm')).catch(() => null)), 'no pnpm store in output');
    assert.equal(await readFile(join(out, 'dist/index.js'), 'utf8'), '');
    assert.deepEqual(report.packages, ['a@1.0.0', 'b@2.0.0']);
  });
});

test('nests a conflicting version under its dependent', async () => {
  await withTrees(async (iso, out) => {
    await isolated(iso, {
      rootDeps: ['x@1.0.0', 'a@1.0.0'],
      packages: { 'x@1.0.0': {}, 'x@2.0.0': {}, 'a@1.0.0': { deps: ['x@2.0.0', 'b@1.0.0'] }, 'b@1.0.0': { deps: ['x@1.0.0'] } },
    });
    await materializeHoisted(iso, out);
    assert.equal(loads(out, '', 'x'), 'x@1.0.0');
    assert.equal(loads(out, 'node_modules/a', 'x'), 'x@2.0.0');
    // b needs x@1 even though its dependent a sees x@2: b must not land where a's x@2 shadows.
    const bFromA = createRequire(join(out, 'node_modules/a/package.json')).resolve('b/package.json');
    assert.equal(createRequire(bFromA)('x'), 'x@1.0.0');
  });
});

test('keeps peer-variant instances of one name@version apart', async () => {
  await withTrees(async (iso, out) => {
    await isolated(iso, {
      rootDeps: ['p@1.0.0_q@1.0.0', 'm@1.0.0'],
      packages: {
        'p@1.0.0_q@1.0.0': { deps: ['q@1.0.0'] },
        'p@1.0.0_q@2.0.0': { deps: ['q@2.0.0'] },
        'q@1.0.0': {}, 'q@2.0.0': {},
        'm@1.0.0': { deps: ['p@1.0.0_q@2.0.0'] },
      },
    });
    await materializeHoisted(iso, out);
    const pRoot = createRequire(join(out, 'package.json')).resolve('p/package.json');
    assert.equal(createRequire(pRoot)('q'), 'q@1.0.0');
    const pM = createRequire(join(out, 'node_modules/m/package.json')).resolve('p/package.json');
    assert.equal(createRequire(pM)('q'), 'q@2.0.0');
  });
});

test('handles scoped packages and dependency cycles', async () => {
  await withTrees(async (iso, out) => {
    await isolated(iso, {
      rootDeps: ['@s/a@1.0.0'],
      packages: { '@s/a@1.0.0': { deps: ['@s/b@1.0.0'] }, '@s/b@1.0.0': { deps: ['@s/a@1.0.0'] } },
    });
    await materializeHoisted(iso, out);
    assert.equal(loads(out, '', '@s/a'), '@s/a@1.0.0');
    assert.equal(loads(out, 'node_modules/@s/b', '@s/a'), '@s/a@1.0.0');
    assert.deepEqual(await links(out), []);
  });
});

test('fails on an unresolvable required dependency but tolerates an absent optional one', async () => {
  await withTrees(async (iso, out) => {
    await isolated(iso, { rootDeps: ['a@1.0.0'], packages: { 'a@1.0.0': { optional: ['fsevents'] } } });
    await materializeHoisted(iso, out);
  });
  await withTrees(async (iso, out) => {
    await isolated(iso, { rootDeps: ['a@1.0.0'], packages: { 'a@1.0.0': { manifest: { dependencies: { ghost: '*' } } } } });
    await assert.rejects(materializeHoisted(iso, out), /a@1\.0\.0.*ghost/s);
  });
});

test('refuses packages that cannot run on win32-x64', async () => {
  await withTrees(async (iso, out) => {
    await isolated(iso, { rootDeps: ['a@1.0.0'], packages: { 'a@1.0.0': { manifest: { os: ['darwin'] } } } });
    await assert.rejects(materializeHoisted(iso, out), /a@1\.0\.0.*win32/s);
  });
  await withTrees(async (iso, out) => {
    // A Windows-specific optional binary missing from a cross-built tree.
    await isolated(iso, { rootDeps: ['a@1.0.0'], packages: { 'a@1.0.0': { optional: ['@esbuild/win32-x64'] } } });
    await assert.rejects(materializeHoisted(iso, out), /@esbuild\/win32-x64/);
  });
});

test('refuses a link inside a package', async () => {
  await withTrees(async (iso, out) => {
    await isolated(iso, { rootDeps: ['a@1.0.0'], packages: { 'a@1.0.0': {} } });
    await symlink('index.js', join(iso, 'node_modules/.pnpm/a@1.0.0/node_modules/a/alias.js'));
    await assert.rejects(materializeHoisted(iso, out), /link/i);
  });
});

test('hoists a conflicting chain as high as is safe (keeps Windows paths short)', async () => {
  // The real htmlparser2 shape: root holds the new generation; htmlparser2
  // pins the old one, and needs the new `e` itself.
  await withTrees(async (iso, out) => {
    await isolated(iso, {
      rootDeps: ['u@4.0.0', 'h@10.0.0'],
      packages: {
        'u@4.0.0': { deps: ['s@3.0.0'] }, 's@3.0.0': { deps: ['e@7.0.0'] }, 'e@7.0.0': {},
        'h@10.0.0': { deps: ['u@3.0.0', 'e@7.0.0'] },
        'u@3.0.0': { deps: ['s@2.0.0'] }, 's@2.0.0': { deps: ['e@4.0.0'] }, 'e@4.0.0': {},
      },
    });
    await materializeHoisted(iso, out);
    const placed = async (path) => JSON.parse(await readFile(join(out, path, 'package.json'), 'utf8')).version;
    assert.equal(await placed('node_modules/h/node_modules/u'), '3.0.0');
    // s@2 is not needed by h, so it rises to h's level instead of nesting under u.
    assert.equal(await placed('node_modules/h/node_modules/s'), '2.0.0');
    // e@4 cannot rise to h's level: h itself resolves e to the root's e@7.
    assert.equal(await placed('node_modules/h/node_modules/s/node_modules/e'), '4.0.0');
    assert.equal(loads(out, 'node_modules/h', 'e'), 'e@7.0.0');
    assert.equal(loads(out, 'node_modules/h/node_modules/s', 'e'), 'e@4.0.0');
  });
});

test('fails with a clear error, instead of growing without bound, on a conflicting-version cycle', async () => {
  // a@1 -> b@2 -> a@2 -> b@1 -> a@1: no finite hoisted layout exists.
  await withTrees(async (iso, out) => {
    await isolated(iso, {
      rootDeps: ['a@1.0.0', 'b@1.0.0'],
      packages: {
        'a@1.0.0': { deps: ['b@2.0.0'] }, 'b@2.0.0': { deps: ['a@2.0.0'] },
        'a@2.0.0': { deps: ['b@1.0.0'] }, 'b@1.0.0': { deps: ['a@1.0.0'] },
      },
    });
    await assert.rejects(materializeHoisted(iso, out), /no finite hoisted layout/);
  });
});

test('ships bundled dependencies inside their package without placing them separately', async () => {
  await withTrees(async (iso, out) => {
    await isolated(iso, { rootDeps: ['a@1.0.0'], packages: { 'a@1.0.0': { manifest: { dependencies: { inner: '*' }, bundleDependencies: ['inner'] } } } });
    const inner = join(iso, 'node_modules/.pnpm/a@1.0.0/node_modules/a/node_modules/inner');
    await mkdir(inner, { recursive: true });
    await writeFile(join(inner, 'package.json'), JSON.stringify({ name: 'inner', version: '9.0.0', main: 'index.js' }));
    await writeFile(join(inner, 'index.js'), 'module.exports = "inner@9.0.0";');
    const report = await materializeHoisted(iso, out);
    assert.equal(loads(out, 'node_modules/a', 'inner'), 'inner@9.0.0');
    assert.deepEqual(report.packages, ['a@1.0.0']);
    await assert.rejects(lstat(join(out, 'node_modules/inner')), /ENOENT/);
  });
});

test("keeps a bundle's flattened dependencies, and fails closed on a missing bundled name", async () => {
  // npm-style bundle: a bundles x; x requires y; y sits flat in a/node_modules.
  const bundle = async (iso, names) => {
    const nm = join(iso, 'node_modules/.pnpm/a@1.0.0/node_modules/a/node_modules');
    for (const [name, deps] of names) {
      await mkdir(join(nm, name), { recursive: true });
      await writeFile(join(nm, name, 'package.json'), JSON.stringify({ name, version: '1.0.0', main: 'index.js', dependencies: Object.fromEntries(deps.map((d) => [d, '*'])) }));
      await writeFile(join(nm, name, 'index.js'), `module.exports = ${JSON.stringify(name)}${deps.map((d) => ` + require(${JSON.stringify(d)})`).join('')};`);
    }
  };
  await withTrees(async (iso, out) => {
    await isolated(iso, { rootDeps: ['a@1.0.0'], packages: { 'a@1.0.0': { manifest: { dependencies: { x: '*' }, bundleDependencies: ['x'] } } } });
    await bundle(iso, [['x', ['y']], ['y', []]]);
    await materializeHoisted(iso, out);
    assert.equal(loads(out, 'node_modules/a', 'x'), 'xy');
  });
  await withTrees(async (iso, out) => {
    await isolated(iso, { rootDeps: ['a@1.0.0'], packages: { 'a@1.0.0': { manifest: { dependencies: { x: '*' }, bundleDependencies: ['x'] } } } });
    await assert.rejects(materializeHoisted(iso, out), /a@1\.0\.0.*bundles x/s);
  });
});
