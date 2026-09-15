import assert from 'node:assert/strict';
import { readdir, readFile, realpath } from 'node:fs/promises';
import { join, sep } from 'node:path';

const forbidden = new Set(['playwright', 'playwright-core', 'puppeteer', 'puppeteer-core',
  '@agentbrowser/api', '@agentbrowser/engine-playwright', '@agentbrowser/engine-firefox',
  '@agentbrowser/engine-obscura', '@agentbrowser/engine-safari']);

export async function auditApplicationDeployment(directory, destination) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      const target = await realpath(path);
      assert.ok(target === destination || target.startsWith(destination + sep), `Escaping dependency: ${path}`);
    } else if (entry.isDirectory()) await auditApplicationDeployment(path, destination);
    if (entry.name === 'package.json') {
      const manifest = JSON.parse(await readFile(path, 'utf8'));
      assert.ok(!forbidden.has(manifest.name), `Browser dependency installed: ${manifest.name}`);
    }
  }
}
