/**
 * T5 J-e: process loss at every boundary of a durable application write, through the real
 * service with the real SQLite journal. A child process is SIGKILLed at the boundary; the store
 * (read-only) and an independent effect counter are the oracles; a new process then reopens the
 * same namespace. Nothing is replayed: there is no recovery path that re-executes (J3/J4 are
 * proposed), and the classification is what an operator would read.
 */
import { fork } from 'node:child_process';
import { once } from 'node:events';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const CHILD = fileURLToPath(
  new URL('./test-support/journal-process-loss-child.mjs', import.meta.url)
);
const cleanup: string[] = [];
afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

function layout() {
  const base = mkdtempSync(join(realpathSync(tmpdir()), 'journal-loss-'));
  cleanup.push(base);
  mkdirSync(join(base, 'store'), { mode: 0o700 });
  mkdirSync(join(base, 'anchor'), { mode: 0o700 });
  writeFileSync(join(base, 'key'), `key-1:${'ef'.repeat(32)}\n`, { mode: 0o600 });
  return {
    base,
    store: join(base, 'store'),
    counter: join(base, 'effects'),
    env: {
      AGENTBROWSER_JOURNAL_DIR: join(base, 'store'),
      AGENTBROWSER_JOURNAL_ANCHOR_DIR: join(base, 'anchor'),
      AGENTBROWSER_JOURNAL_KEY_FILE: join(base, 'key'),
      AGENTBROWSER_JOURNAL_RESTORE_GENERATION: 'generation-1',
      AGENTBROWSER_JOURNAL_ACCEPT_UNTIL: '2099-01-01T00:00:00Z',
      AGENTBROWSER_JOURNAL_INITIALIZE: '1',
    } as Record<string, string>,
  };
}

/** Runs the child to `phase`, then SIGKILLs it (or lets it finish for 'done'/'reopened'). */
async function runChild(
  args: { env: Record<string, string>; mode: string; counterFile: string; operationId: string },
  kill: boolean
) {
  const child = fork(CHILD, [JSON.stringify(args)], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let stderr = '';
  child.stderr?.on('data', (chunk) => {
    stderr += chunk;
  });
  const [message] = (await Promise.race([
    once(child, 'message'),
    once(child, 'exit').then(() => {
      throw new Error(`child exited early: ${stderr.slice(-800)}`);
    }),
  ])) as [{ phase: string; health?: string; namespace?: string }];
  if (kill) child.kill('SIGKILL');
  const [code, signal] = (await once(child, 'exit')) as [number | null, string | null];
  return { message, code, signal };
}

type Row = { revision: number; dispatched: boolean; terminal?: { status: string } };
function rows(store: string): Row[] {
  const database = new DatabaseSync(join(store, 'journal.sqlite'), { readOnly: true });
  try {
    return (
      database.prepare('SELECT revision, record FROM journal_record').all() as Array<{
        revision: number;
        record: string;
      }>
    ).map((row) => {
      const record = JSON.parse(row.record) as {
        dispatched: boolean;
        terminal?: { status: string };
      };
      return {
        revision: Number(row.revision),
        dispatched: record.dispatched,
        terminal: record.terminal,
      };
    });
  } finally {
    database.close();
  }
}
const effects = (counter: string) =>
  existsSync(counter) ? readFileSync(counter, 'utf8').length : 0;

describe('process loss through the service (real store, SIGKILL)', () => {
  it.each([
    // [kill point, expected rows, effects]
    ['before-intent', [], 0],
    ['before-effect', [{ revision: 2, dispatched: true, terminal: undefined }], 0],
    ['after-effect', [{ revision: 2, dispatched: true, terminal: undefined }], 1],
    ['after-terminal', [{ revision: 3, dispatched: true, terminal: { status: 'completed' } }], 1],
  ] as const)(
    'killed %s: the record classifies the loss, the effect ran at most once, and the next process reopens the namespace',
    async (mode, expected, expectedEffects) => {
      const l = layout();
      const killed = await runChild(
        { env: l.env, mode, counterFile: l.counter, operationId: `loss-${mode}` },
        true
      );
      expect(killed.message.phase).toBe(mode);
      expect(killed.signal).toBe('SIGKILL');
      expect(rows(l.store)).toMatchObject(expected);
      expect(effects(l.counter)).toBe(expectedEffects);

      // The next process (no initialize) reacquires the dead owner's namespace.
      const { AGENTBROWSER_JOURNAL_INITIALIZE: _first, ...later } = l.env;
      const reopened = await runChild(
        { env: later, mode: 'reopen', counterFile: l.counter, operationId: 'unused' },
        false
      );
      expect(reopened.message).toMatchObject({
        phase: 'reopened',
        health: 'open',
        namespace: 'agentbrowser',
      });
      expect(reopened.code).toBe(0);
      // Reopening replays nothing: the record and the effect count are unchanged.
      expect(rows(l.store)).toMatchObject(expected);
      expect(effects(l.counter)).toBe(expectedEffects);
    },
    120_000
  );

  it('an uninterrupted durable write ends completed with exactly one effect', async () => {
    const l = layout();
    const done = await runChild(
      { env: l.env, mode: 'complete', counterFile: l.counter, operationId: 'whole' },
      false
    );
    expect(done.message.phase).toBe('done');
    expect(done.code).toBe(0);
    expect(rows(l.store)).toMatchObject([
      { revision: 3, dispatched: true, terminal: { status: 'completed' } },
    ]);
    expect(effects(l.counter)).toBe(1);
  }, 120_000);

  it.each([
    ['different key material under the same key id (key loss)', `key-1:${'01'.repeat(32)}`],
    ['a new key id for the same namespace (rotation in place)', `key-2:${'ef'.repeat(32)}`],
  ])(
    'refuses %s; the namespace and its records are untouched',
    async (_name, keyLine) => {
      const l = layout();
      const first = await runChild(
        { env: l.env, mode: 'complete', counterFile: l.counter, operationId: 'kept' },
        false
      );
      expect(first.message.phase).toBe('done');
      const before = rows(l.store);
      writeFileSync(join(l.base, 'key'), `${keyLine}\n`, { mode: 0o600 });
      const { AGENTBROWSER_JOURNAL_INITIALIZE: _first, ...later } = l.env;
      const child = fork(
        CHILD,
        [JSON.stringify({ env: later, mode: 'reopen', counterFile: l.counter, operationId: 'x' })],
        {
          stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        }
      );
      let stderr = '';
      child.stderr?.on('data', (chunk) => {
        stderr += chunk;
      });
      const [code] = (await once(child, 'exit')) as [number | null];
      expect(code).not.toBe(0);
      // Refused as a configuration mismatch: rotate by configuring a new namespace instead.
      expect(stderr).toMatch(/configuration/);
      expect(stderr).not.toMatch(/(ef){4}|(01){4}/);
      expect(rows(l.store)).toEqual(before);
    },
    120_000
  );
});
