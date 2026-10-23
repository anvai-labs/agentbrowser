import type { ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The sqlite suites' shared cleanup + layout: one registry per suite file holding the
 * spawned children (SIGKILLed and awaited in `dispose`) and the temp store/anchor trees
 * (removed after), plus `freshPaths` — the 0700 store/anchor layout under a tagged temp
 * base that registers itself for removal. Wire `dispose()` in the suite's afterEach.
 */
export function storeCleanup() {
  const children: { child: ChildProcess; exited: Promise<unknown> }[] = [];
  const directories: string[] = [];
  return {
    registerChild(child: ChildProcess, exited: Promise<unknown>) {
      children.push({ child, exited });
    },
    freshPaths(prefix: string) {
      const base = mkdtempSync(join(realpathSync(tmpdir()), prefix));
      directories.push(base);
      const directory = join(base, 'store');
      const anchorDirectory = join(base, 'anchor');
      mkdirSync(directory, { mode: 0o700 });
      mkdirSync(anchorDirectory, { mode: 0o700 });
      return { base, directory, anchorDirectory };
    },
    async dispose() {
      await Promise.all(
        children.splice(0).map(async ({ child, exited }) => {
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
          await exited;
        })
      );
      for (const directory of directories.splice(0))
        rmSync(directory, { recursive: true, force: true });
    },
  };
}
