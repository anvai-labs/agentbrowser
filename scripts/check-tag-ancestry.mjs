#!/usr/bin/env node
/**
 * T9 S1a / R14: a release tag may publish only when its commit is reachable from main.
 * `git merge-base --is-ancestor` exits 0 for an ancestor and 1 for a non-ancestor; any other
 * outcome (unknown commit, missing ref) is an error, so the check fails closed.
 */
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function checkTagAncestry(root, { commit, mainRef = 'origin/main' } = {}) {
  if (typeof commit !== 'string' || commit.length === 0)
    throw new Error('A tag commit is required');
  const result = spawnSync('git', ['merge-base', '--is-ancestor', commit, mainRef], {
    cwd: root,
    encoding: 'utf8',
  });
  if (result.status === 0) return { commit, mainRef };
  if (result.status === 1)
    throw new Error(
      `Tag commit ${commit} is not reachable from ${mainRef}: release tags must be cut from main`
    );
  throw new Error(
    `Cannot verify tag ancestry of ${commit} against ${mainRef}: ${(result.stderr || result.error?.message || 'git failed').trim()}`
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    const value = (flag) => {
      const index = args.indexOf(flag);
      return index >= 0 ? args[index + 1] : undefined;
    };
    const commit = value('--commit');
    const mainRef = value('--main-ref') ?? 'origin/main';
    if (commit === undefined)
      throw new Error('Usage: check-tag-ancestry.mjs --commit <sha> [--main-ref origin/main]');
    checkTagAncestry(process.cwd(), { commit, mainRef });
    console.log(`Tag commit ${commit} is reachable from ${mainRef}.`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
