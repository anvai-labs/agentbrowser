#!/usr/bin/env node
/** Root package.json is the product-version authority. Default mode is read-only. */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const sourceModules = ['api', 'cli'];
const semver = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export function synchronizeVersions(root, { write = false, tag } = {}) {
  const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const parsed = typeof version === 'string' ? semver.exec(version) : null;
  if (!parsed || parsed[1]?.split('.').some((identifier) => /^0\d+$/.test(identifier))) throw new Error('Root product version must be semver');
  if (tag !== undefined && tag !== `v${version}`) throw new Error(`Tag ${tag} does not match product version v${version}`);
  const changes = [];
  for (const entry of readdirSync(join(root, 'packages'), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(root, 'packages', entry.name, 'package.json');
    if (!existsSync(path)) continue;
    const original = readFileSync(path, 'utf8');
    const manifest = JSON.parse(original);
    if (manifest.version !== version) changes.push([path, `${JSON.stringify({ ...manifest, version }, null, 2)}\n`]);
  }
  for (const name of sourceModules) {
    const path = join(root, 'packages', name, 'src', 'product-version.ts');
    const generated = `// Generated from root package.json by pnpm release:sync. Do not edit.\nexport const PRODUCT_VERSION = '${version}';\n`;
    if (!existsSync(path) || readFileSync(path, 'utf8') !== generated) changes.push([path, generated]);
  }
  if (!write && changes.length) throw new Error(`Version drift: run pnpm release:sync\n${changes.map(([path]) => path).join('\n')}`);
  if (write) for (const [path, content] of changes) writeFileSync(path, content);
  return { version, changed: changes.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    const tagIndex = args.indexOf('--tag');
    const tag = tagIndex >= 0 ? args[tagIndex + 1] : undefined;
    const remaining = args.filter((_arg, index) => index !== tagIndex && index !== (tagIndex >= 0 ? tagIndex + 1 : -1));
    if (remaining.some((arg) => arg !== '--write') || (tagIndex >= 0 && tag === undefined)) throw new Error('Usage: sync-versions.mjs [--write] [--tag vX.Y.Z]');
    const result = synchronizeVersions(dirname(dirname(fileURLToPath(import.meta.url))), { write: remaining.includes('--write'), tag });
    console.log(`Product ${result.version}: ${result.changed} synchronized file(s); versions consistent.`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
