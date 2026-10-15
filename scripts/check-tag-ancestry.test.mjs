import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkTagAncestry } from './check-tag-ancestry.mjs';

/** A throwaway repository: main with two commits, develop with one commit main lacks. */
function repository() {
  const root = mkdtempSync(join(tmpdir(), 'agentbrowser-tag-ancestry-'));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'release@example.invalid');
  git('config', 'user.name', 'Release Test');
  git('config', 'commit.gpgsign', 'false');
  const commit = (message) => {
    writeFileSync(join(root, 'file.txt'), message);
    git('add', 'file.txt');
    git('commit', '-q', '-m', message);
    return git('rev-parse', 'HEAD');
  };
  const first = commit('first');
  const tip = commit('main tip');
  git('checkout', '-q', '-b', 'develop');
  const developOnly = commit('develop only');
  git('checkout', '-q', 'main');
  return {
    root,
    first,
    tip,
    developOnly,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test('a tag on main (its tip or any earlier commit) is an ancestor and passes', () => {
  const repo = repository();
  try {
    assert.deepEqual(checkTagAncestry(repo.root, { commit: repo.tip, mainRef: 'main' }), {
      commit: repo.tip,
      mainRef: 'main',
    });
    assert.equal(
      checkTagAncestry(repo.root, { commit: repo.first, mainRef: 'main' }).commit,
      repo.first
    );
  } finally {
    repo.cleanup();
  }
});

test('a tag on a commit main does not contain is refused (R14: off-main tags cannot publish)', () => {
  const repo = repository();
  try {
    assert.throws(
      () => checkTagAncestry(repo.root, { commit: repo.developOnly, mainRef: 'main' }),
      /is not reachable from main/
    );
  } finally {
    repo.cleanup();
  }
});

test('an unknown commit or a missing main ref fails closed, never as a pass', () => {
  const repo = repository();
  try {
    assert.throws(
      () => checkTagAncestry(repo.root, { commit: '0'.repeat(40), mainRef: 'main' }),
      /Cannot verify tag ancestry/
    );
    assert.throws(
      () => checkTagAncestry(repo.root, { commit: repo.tip, mainRef: 'origin/main' }),
      /Cannot verify tag ancestry/
    );
    assert.throws(() => checkTagAncestry(repo.root, { commit: '', mainRef: 'main' }), /commit/);
  } finally {
    repo.cleanup();
  }
});

const script = fileURLToPath(new URL('./check-tag-ancestry.mjs', import.meta.url));
const runCli = (cwd, args, env = process.env) =>
  spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8', env });

test('the CLI the workflow runs exits 0 on main, 1 off main, 1 without --commit', () => {
  const repo = repository();
  try {
    const onMain = runCli(repo.root, ['--commit', repo.tip, '--main-ref', 'main']);
    assert.equal(onMain.status, 0, onMain.stderr);
    assert.match(onMain.stdout, /is reachable from main/);
    const offMain = runCli(repo.root, ['--commit', repo.developOnly, '--main-ref', 'main']);
    assert.equal(offMain.status, 1);
    assert.match(offMain.stderr, /is not reachable from main/);
    assert.equal(runCli(repo.root, ['--main-ref', 'main']).status, 1);
  } finally {
    repo.cleanup();
  }
});

test('a missing git binary (spawn status null) fails closed through the CLI', () => {
  const repo = repository();
  try {
    const result = runCli(repo.root, ['--commit', repo.tip, '--main-ref', 'main'], {
      ...process.env,
      PATH: '',
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Cannot verify tag ancestry/);
  } finally {
    repo.cleanup();
  }
});

/** Split release.yml into job blocks keyed by job id. */
function jobs(workflow) {
  const body = workflow.slice(workflow.indexOf('\njobs:\n') + '\njobs:\n'.length);
  const map = new Map();
  for (const block of body.split(/\n(?= {2}[\w-]+:\n)/)) {
    const id = /^ {2}([\w-]+):\n/.exec(block)?.[1];
    if (id) map.set(id, block);
  }
  return map;
}

/** `needs: a` and `needs: [a, b]` both parse to a list. */
function needsOf(block) {
  const raw = /^ {4}needs: (.+)$/m.exec(block)?.[1]?.trim();
  if (raw === undefined) return [];
  return raw.startsWith('[')
    ? raw
        .slice(1, -1)
        .split(',')
        .map((value) => value.trim())
    : [raw];
}

test('the tag-guard step runs exactly the ancestry check, unconditionally, on full history', () => {
  const workflow = readFileSync(
    new URL('../.github/workflows/release.yml', import.meta.url),
    'utf8'
  );
  const guard = jobs(workflow).get('tag-guard');
  assert.ok(guard, 'Missing tag-guard job');
  assert.match(guard, /fetch-depth: 0/, 'tag-guard needs history to compare against main');
  assert.doesNotMatch(
    guard,
    /^ {4}(if|continue-on-error):/m,
    'tag-guard job must be unconditional'
  );
  const step = guard.slice(guard.indexOf('- name: Verify the tag commit is on main'));
  assert.ok(step.startsWith('- name: Verify the tag commit is on main'), 'Missing ancestry step');
  assert.doesNotMatch(
    step,
    /^\s*(if|continue-on-error):/m,
    'the ancestry step must not be skippable'
  );
  assert.doesNotMatch(step, /\|\|\s*true|;\s*true\b/, 'the ancestry step must not swallow failure');
  const commands = step
    .split('\n')
    .slice(2)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));
  assert.deepEqual(commands, [
    'git fetch --no-tags origin +refs/heads/main:refs/remotes/origin/main',
    'node scripts/check-tag-ancestry.mjs --commit "$GITHUB_SHA" --main-ref origin/main',
  ]);
});

test('every other release job depends on tag-guard, directly or transitively', () => {
  const workflow = readFileSync(
    new URL('../.github/workflows/release.yml', import.meta.url),
    'utf8'
  );
  const graph = jobs(workflow);
  assert.ok(graph.size > 5, 'Expected the release jobs');
  const reaches = (id, seen = new Set()) => {
    if (id === 'tag-guard') return true;
    if (seen.has(id)) return false;
    seen.add(id);
    return needsOf(graph.get(id) ?? '').some((dependency) => reaches(dependency, seen));
  };
  for (const id of graph.keys()) {
    if (id === 'tag-guard') continue;
    assert.ok(reaches(id), `job ${id} does not depend on tag-guard`);
    // A job-level `if:` that mentions any status function replaces GitHub's implicit
    // success() — so `success() || x` or `always()` would run after a failed tag-guard. Only a
    // bare `success()` (equivalent to no status function) is allowed.
    const condition = /^ {4}if: (.+)$/m.exec(graph.get(id) ?? '')?.[1]?.trim();
    if (condition !== undefined && /\b(always|cancelled|failure|success)\(\)/.test(condition)) {
      assert.match(
        condition.replace(/^\$\{\{\s*|\s*\}\}$/g, ''),
        /^success\(\)$/,
        `job ${id} could run despite a failed tag-guard: if: ${condition}`
      );
    }
  }
});
