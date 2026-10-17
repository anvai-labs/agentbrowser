// Every CLI test worker owns its cache; tests must never write to the user's home cache.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'vitest';

const previous = process.env.AGENTBROWSER_ARTIFACT_DIR;
const directory = mkdtempSync(join(tmpdir(), 'agentbrowser-cli-cache-'));
process.env.AGENTBROWSER_ARTIFACT_DIR = directory;
afterAll(() => {
  if (previous === undefined) delete process.env.AGENTBROWSER_ARTIFACT_DIR;
  else process.env.AGENTBROWSER_ARTIFACT_DIR = previous;
  rmSync(directory, { recursive: true, force: true });
});
