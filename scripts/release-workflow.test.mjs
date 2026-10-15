import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readdir, readFile } from 'node:fs/promises';

// Structural guards on the release workflow: the Windows service ships only
// as the bundled-Node zip. v1.17.0's single-file server exe (Bun froze
// Playwright's __dirname to the CI checkout) must not come back.
const workflow = await readFile(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');

/** The text of one top-level job (from its key to the next job key). */
function job(name) {
  const start = workflow.search(new RegExp(`^  ${name}:$`, 'm'));
  assert.ok(start >= 0, `release.yml has no ${name} job`);
  const rest = workflow.slice(start + 1);
  const next = rest.search(/^ {2}[a-z][a-z0-9-]*:$/m);
  return next < 0 ? workflow.slice(start) : workflow.slice(start, start + 1 + next);
}

const needs = (name) => (job(name).match(/^ {4}needs: \[([^\]]*)\]/m)?.[1] ?? '').split(',').map((n) => n.trim());

test('no single-file server executable is built or published', () => {
  assert.doesNotMatch(workflow, /server_artifact|packages\/api\/scripts\/compile\.mjs|agentbrowser-server-windows-x64\.exe/);
});

test('a windows-bundle job assembles and clean-room smokes the zip on Windows', () => {
  const bundle = job('windows-bundle');
  assert.match(bundle, /runs-on: windows-/);
  assert.match(bundle, /scripts\/package-server\.mjs[^\n]*--target win32-x64/);
  assert.match(bundle, /compile-launcher\.mjs/);
  assert.match(bundle, /scripts\/assemble-windows-bundle\.mjs/);
  assert.match(bundle, /windows-bundle-smoke\.mjs[\s\S]*--require-symlink/);
  // One smoke run without provisioned browsers: the first-start download users take.
  assert.match(bundle, /Remove-Item Env:PLAYWRIGHT_BROWSERS_PATH[\s\S]*windows-bundle-smoke\.mjs/);
  // The bundle carries the exact standalone CLI/MCP bytes built by `binaries`.
  assert.match(bundle, /agentbrowser-cli-windows-x64\.exe/);
  assert.match(bundle, /agentbrowser-mcp-windows-x64\.exe/);
  assert.ok(needs('windows-bundle').includes('binaries'));
  assert.match(bundle, /name: agentbrowser-windows-x64\.zip/);
});

test('nothing publishes unless the Windows bundle passed', () => {
  for (const publisher of ['npm-publish', 'release']) {
    assert.ok(needs(publisher).includes('windows-bundle'), `${publisher} must need windows-bundle`);
  }
});

test('the release job no longer builds its own flat zip, and checksums the bundle', () => {
  const release = job('release');
  assert.doesNotMatch(release, /zip -X -j/);
  assert.match(release, /sha256sum[^\n]*agentbrowser-windows-x64\.zip/);
});

// T9 S1c: least privilege and immutable action references across EVERY workflow.
const workflowDir = new URL('../.github/workflows/', import.meta.url);
const workflows = Object.fromEntries(
  await Promise.all(
    (await readdir(workflowDir))
      .filter((name) => /\.ya?ml$/.test(name))
      .sort()
      .map(async (name) => [name, await readFile(new URL(name, workflowDir), 'utf8')])
  )
);

test('every action is pinned to a full commit SHA with its version as a comment', () => {
  assert.ok(Object.keys(workflows).length >= 4, 'workflow discovery found too few files');
  let count = 0;
  for (const [name, text] of Object.entries(workflows)) {
    for (const line of text.split('\n')) {
      if (!/\buses\s*:/.test(line)) continue;
      count += 1;
      // Local actions are part of the checkout; they may not climb out of it.
      const local = /^\s*(?:-\s+)?uses: (\.\/\S*)\s*$/.exec(line);
      if (local) {
        assert.doesNotMatch(local[1], /\.\./, `${name}: local action escapes the checkout`);
        continue;
      }
      // Only the plain line form is accepted (no flow maps, quotes, docker:// or short SHAs).
      assert.match(
        line,
        /^\s*(?:-\s+)?uses: [A-Za-z0-9_.-]+\/[A-Za-z0-9_.\/-]+@[0-9a-f]{40} # v\d+\.\d+\.\d+$/,
        `${name}: unpinned or uncommented action reference: ${line.trim()}`
      );
    }
  }
  assert.ok(count >= 67, `expected the workflows' action references, found ${count}`);
});

/** Every job of a workflow: key -> its text (from the key to the next job key). */
function jobsOf(text) {
  const body = text.slice(text.search(/^jobs:$/m));
  const keys = [...body.matchAll(/^ {2}([A-Za-z0-9_-]+):$/gm)];
  return new Map(
    keys.map((match, index) => [
      match[1],
      body.slice(match.index, keys[index + 1]?.index ?? body.length),
    ])
  );
}

/** A permissions block at the given indent as a sorted "scope: level" list; inline forms kept. */
function permissionsAt(text, indent) {
  const pad = ' '.repeat(indent);
  const inline = new RegExp(`^${pad}permissions:[ \\t]*(\\S.*)$`, 'm').exec(text);
  if (inline) return [`<inline> ${inline[1].trim()}`];
  const block = new RegExp(`^${pad}permissions:\\n((?:${pad}  [^\\n]*\\n)*)`, 'm').exec(text);
  if (!block) return undefined;
  return block[1]
    .split('\n')
    .filter((entry) => entry.trim() !== '' && !entry.trim().startsWith('#'))
    .map((entry) => entry.trim())
    .sort();
}

// The only grants beyond read anywhere: exact sets, so an added scope or level is refused.
const JOB_PERMISSIONS = {
  'release.yml/release': ['contents: write'],
  'release.yml/npm-publish': ['contents: read', 'id-token: write'],
  'docs.yml/deploy': ['id-token: write', 'pages: write'],
};

test('every workflow defaults to read-only contents and grants no write at the top level', () => {
  for (const [name, text] of Object.entries(workflows)) {
    const top = permissionsAt(text.slice(0, text.search(/^jobs:$/m)), 0);
    assert.deepEqual(top, ['contents: read'], `${name}: top-level permissions must be exactly contents: read`);
  }
});

test('job-level permissions grant exactly the allowlisted scopes and nothing else writes', () => {
  const seen = [];
  for (const [name, text] of Object.entries(workflows)) {
    // The regex reader must see the whole file: a plain `jobs:` line, jobs at two-space indent
    // with bare keys, and every `permissions:` line accounted for (top level + allowlisted jobs).
    assert.match(text, /^jobs:$/m, `${name}: jobs: must be a bare line (no trailing comment)`);
    const jobs = jobsOf(text);
    assert.ok(jobs.size > 0, `${name}: no jobs parsed (two-space job keys expected)`);
    const keyLines = text
      .slice(text.search(/^jobs:$/m))
      .split('\n')
      .filter((line) => /^\s+[^\s#-][^:]*:(?:\s|$)/.test(line) && /^ {1,3}\S/.test(line));
    for (const line of keyLines)
      assert.match(line, /^ {2}[A-Za-z0-9_-]+:$/, `${name}: job key not in the bare form: ${line}`);
    const declared = (text.match(/^\s*permissions\s*:/gm) ?? []).length;
    const recognised =
      1 + [...jobs.values()].filter((body) => permissionsAt(body, 4) !== undefined).length;
    assert.equal(declared, recognised, `${name}: a permissions block the reader does not see`);
    for (const [id, body] of jobs) {
      const granted = permissionsAt(body, 4);
      const key = `${name}/${id}`;
      if (granted === undefined) continue;
      seen.push(key);
      assert.deepEqual(granted, JOB_PERMISSIONS[key], `${key}: unexpected job permissions ${JSON.stringify(granted)}`);
    }
  }
  assert.deepEqual(seen.sort(), Object.keys(JOB_PERMISSIONS).sort());
});
