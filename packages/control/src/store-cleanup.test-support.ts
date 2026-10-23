import type { ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface FixturePaths {
  readonly base: string;
  readonly directory: string;
  readonly anchorDirectory: string;
}

/**
 * The sqlite suites' shared cleanup + layout: one registry per suite file holding the
 * spawned children (SIGKILLed and awaited in `dispose`) and the temp store trees
 * (removed after), plus `freshPaths` — the 0700 store layout (anchor too unless
 * `anchor: false`) under a tagged temp base that registers itself for removal. Wire
 * `dispose()` in the suite's afterEach; it attempts EVERY registration even when one
 * fails, so a stuck file cannot orphan the rest.
 */
export function storeCleanup() {
  const children: { child: ChildProcess; exited: Promise<unknown> }[] = [];
  const directories: string[] = [];
  return {
    registerChild(child: ChildProcess, exited: Promise<unknown>) {
      children.push({ child, exited });
    },
    freshPaths(prefix: string, options: { anchor?: boolean } = {}) {
      const base = mkdtempSync(join(realpathSync(tmpdir()), prefix));
      directories.push(base);
      const directory = join(base, 'store');
      mkdirSync(directory, { mode: 0o700 });
      const anchorDirectory = join(base, 'anchor');
      if (options.anchor !== false) mkdirSync(anchorDirectory, { mode: 0o700 });
      const paths: FixturePaths = { base, directory, anchorDirectory };
      return paths;
    },
    async dispose() {
      const failures: unknown[] = [];
      while (children.length > 0) {
        const entry = children[0];
        try {
          if (entry.child.exitCode === null && entry.child.signalCode === null)
            entry.child.kill('SIGKILL');
          await entry.exited;
          children.shift();
        } catch (error) {
          children.shift();
          failures.push(error);
        }
      }
      while (directories.length > 0) {
        const directory = directories[0];
        try {
          rmSync(directory, { recursive: true, force: true });
          directories.shift();
        } catch (error) {
          directories.shift();
          failures.push(error);
        }
      }
      if (failures.length > 0) throw failures[0];
    },
  };
}
