import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
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

test('the release tag-guard fetches main and runs the ancestry check before anything builds', () => {
  const workflow = readFileSync(
    new URL('../.github/workflows/release.yml', import.meta.url),
    'utf8'
  );
  const guard = workflow
    .split(/\n(?= {2}[\w-]+:)/)
    .find((block) => block.startsWith('  tag-guard:\n'));
  assert.ok(guard, 'Missing tag-guard job');
  assert.match(guard, /fetch-depth: 0/, 'tag-guard needs history to compare against main');
  assert.match(
    guard,
    /refs\/heads\/main:refs\/remotes\/origin\/main/,
    'tag-guard must fetch main explicitly'
  );
  assert.match(guard, /node scripts\/check-tag-ancestry\.mjs/);
  // Every job that builds or publishes depends on tag-guard, directly or through binaries.
  const binaries = workflow
    .split(/\n(?= {2}[\w-]+:)/)
    .find((block) => block.startsWith('  binaries:\n'));
  assert.match(binaries ?? '', /^ {4}needs: tag-guard\s*$/m);
});
