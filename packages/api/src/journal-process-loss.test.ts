/**
 * T5 J-e: process loss at each boundary of a durable application write, through the real
 * service with the real SQLite journal. The child reads the store at the hold point while alive
 * (so ordering is proven, not inferred from what flushed), then is SIGKILLed; the store
 * (read-only) and an independent effect counter are the oracles; a new process then starts the
 * full service on the same namespace. Nothing is replayed: no recovery path re-executes (J3/J4
 * are proposed). The test asserts raw record state, not J3's classification.
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
const BROWSER_CHILD = fileURLToPath(
  new URL('./test-support/browser-process-loss-child.mjs', import.meta.url)
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

/**
 * Runs the child to its hold point, then SIGKILLs it (or lets it finish for 'complete'/'reopen').
 * A synchronous hold (prepare) signals through a file, because a blocked thread cannot flush IPC.
 */
async function runChild(
  args: {
    env: Record<string, string>;
    mode: string;
    counterFile: string;
    operationId: string;
    kind?: string;
    recoverId?: string;
  },
  kill: boolean,
  script = CHILD
) {
  const signalFile = `${args.counterFile}.signal-${args.mode}`;
  const child = fork(script, [JSON.stringify({ ...args, signalFile })], {
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let stderr = '';
  child.stderr?.on('data', (chunk) => {
    stderr += chunk;
  });
  const exited = once(child, 'exit');
  const viaFile = (async () => {
    for (;;) {
      if (existsSync(signalFile)) {
        try {
          return [JSON.parse(readFileSync(signalFile, 'utf8'))];
        } catch {
          /* partially written; poll again */
        }
      }
      await new Promise((done) => setTimeout(done, 20));
    }
  })();
  const [message] = (await Promise.race([
    once(child, 'message'),
    viaFile,
    exited.then(() => {
      throw new Error(`child exited early: ${stderr.slice(-800)}`);
    }),
  ])) as [{ phase: string; rows?: Row[]; health?: string; namespace?: string }];
  if (kill) child.kill('SIGKILL');
  const [code, signal] = (await exited) as [number | null, string | null];
  return { message, code, signal, stderr };
}

type Row = { revision: number; dispatched: boolean; terminal?: { status: string } };
function rows(store: string): Row[] {
  // Right after a SIGKILL the orphaned storage child can still hold the store's lock; it exits
  // when it notices its parent is gone. A locked read is a wait, never a failure.
  const deadline = Date.now() + 10_000;
  for (;;) {
    let database: DatabaseSync | undefined;
    try {
      database = new DatabaseSync(join(store, 'journal.sqlite'), { readOnly: true });
      return readRows(database);
    } catch (error) {
      if (!isLockError(error) || Date.now() > deadline) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    } finally {
      database?.close();
    }
  }
}
// node:sqlite surfaces SQLITE_BUSY (errcode 5) as ERR_SQLITE_ERROR with this message; the
// message is kept as a belt in case the code shape changes again.
const isLockError = (error: unknown): boolean =>
  error !== null &&
  typeof error === 'object' &&
  ((error as { errcode?: unknown }).errcode === 5 ||
    /database is locked/i.test(String((error as Error).message ?? '')));
function readRows(database: DatabaseSync): Row[] {
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
}
const effects = (counter: string) =>
  existsSync(counter) ? readFileSync(counter, 'utf8').length : 0;

describe('process loss through the service (real store, SIGKILL)', () => {
  it.each([
    // [kill point, expected rows, effects]
    ['before-intent', [], 0],
    ['before-marker', [{ revision: 1, dispatched: false, terminal: undefined }], 0],
    ['before-effect', [{ revision: 2, dispatched: true, terminal: undefined }], 0],
    ['after-effect', [{ revision: 2, dispatched: true, terminal: undefined }], 1],
    [
      'after-terminal',
      [{ revision: 3, dispatched: true, terminal: { status: 'completed', evidenceRefIds: [] } }],
      1,
    ],
  ] as const)(
    'killed %s: the store records the expected state, the effect ran at most once, and the next process reopens the namespace',
    async (mode, expected, expectedEffects) => {
      const l = layout();
      const killed = await runChild(
        { env: l.env, mode, counterFile: l.counter, operationId: `loss-${mode}` },
        true
      );
      expect(killed.message.phase).toBe(mode);
      // Read by the child itself at the hold point, before the kill: the ordering is proven
      // while the process is alive, not inferred from what happened to be flushed afterwards.
      if (mode !== 'before-intent') expect(killed.message.rows).toEqual(expected);
      expect(killed.signal).toBe('SIGKILL');
      expect(rows(l.store)).toEqual(expected);
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
      // Starting the full service (adapters registered) on the reopened namespace replays
      // nothing: the record and the effect count are unchanged.
      expect(rows(l.store)).toEqual(expected);
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
    expect(rows(l.store)).toEqual([
      { revision: 3, dispatched: true, terminal: { status: 'completed', evidenceRefIds: [] } },
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
      // Refused precisely as a descriptor (key-check) mismatch, not any other open refusal.
      // Rotation means configuring a new namespace instead.
      expect(stderr).toMatch(/did not open \(definitely_not_opened: configuration\)/);
      expect(stderr).not.toMatch(/(ef){4}|(01){4}/);
      expect(rows(l.store)).toEqual(before);
    },
    120_000
  );
});

describe('process loss during a durable browser operation (B-dur-2c; real store, SIGKILL)', () => {
  // One crash row per owner (act, plan, autofill), at each boundary; the next process then runs
  // the operator's recovery writes on the record the kill left.
  const rowsFor = (kind: string) => {
    const browser = { adapter: 'browser', resource: kind };
    return [
      // [kill point, expected rows, effects]
      ['before-marker', [{ revision: 1, dispatched: false, terminal: undefined, ...browser }], 0],
      ['after-marker', [{ revision: 2, dispatched: true, terminal: undefined, ...browser }], 0],
      ['after-effect', [{ revision: 2, dispatched: true, terminal: undefined, ...browser }], 1],
    ] as const;
  };
  it.each(
    (['act', 'plan', 'autofill'] as const).flatMap((kind) =>
      rowsFor(kind).map(([mode, expected, effects]) => [kind, mode, expected, effects] as const)
    )
  )(
    'durable %s killed %s: the record holds the expected state, the effect ran at most once, nothing is replayed, and recovery closes or settles it',
    async (kind, mode, expected, expectedEffects) => {
      const l = layout();
      const operationId = `browser-${kind}-${mode}`;
      const killed = await runChild(
        { env: l.env, mode, counterFile: l.counter, operationId, kind },
        true,
        BROWSER_CHILD
      );
      expect(killed.message.phase).toBe(mode);
      expect(killed.message.rows).toEqual(expected);
      expect(killed.signal).toBe('SIGKILL');
      expect(effects(l.counter)).toBe(expectedEffects);

      const { AGENTBROWSER_JOURNAL_INITIALIZE: _first, ...later } = l.env;
      const reopened = await runChild(
        {
          env: later,
          mode: 'recover',
          counterFile: l.counter,
          operationId: 'unused',
          recoverId: operationId,
        },
        false,
        BROWSER_CHILD
      );
      expect(reopened.message).toMatchObject({ phase: 'reopened', health: 'open' });
      expect(reopened.code).toBe(0);
      // Nothing replayed: the effect count is unchanged by reopening and recovery.
      expect(effects(l.counter)).toBe(expectedEffects);
      const { recovery, rows: after } = reopened.message as {
        recovery?: Record<string, { ok: boolean; code?: string; value?: unknown }>;
        rows?: unknown;
      };
      const browser = { adapter: 'browser', resource: kind };
      if (mode === 'before-marker') {
        // Never dispatched: reconcile has nothing in doubt to ask about; close ends it (failed,
        // still undispatched, marked as superseded); settle then finds nothing to settle.
        expect(recovery?.reconcile).toMatchObject({ ok: false, code: 'OPERATION_CONFLICT' });
        expect(recovery?.close).toMatchObject({ ok: true, value: { closed: 1 } });
        expect(recovery?.settle).toMatchObject({ ok: false, code: 'NOT_FOUND' });
        expect(after).toEqual([
          {
            revision: 2,
            dispatched: false,
            terminal: { status: 'failed', evidenceRefIds: [`superseded.${operationId}`] },
            ...browser,
          },
        ]);
      } else {
        // In doubt: reconcile is refused (no adapter may own the reserved `browser` id); close
        // refuses a dispatched record; settle ends it as unknown — never replayed.
        expect(recovery?.reconcile).toMatchObject({ ok: false, code: 'CONTROL_REQUIRED' });
        expect(recovery?.close).toMatchObject({ ok: false, code: 'OPERATION_CONFLICT' });
        expect(recovery?.settle).toMatchObject({ ok: true, value: { settled: 1 } });
        expect(after).toEqual([
          {
            revision: 3,
            dispatched: true,
            terminal: { status: 'outcome_unknown', evidenceRefIds: [] },
            ...browser,
          },
        ]);
      }
    },
    120_000
  );

  it('an uninterrupted durable act ends completed with exactly one click', async () => {
    const l = layout();
    const done = await runChild(
      { env: l.env, mode: 'complete', counterFile: l.counter, operationId: 'browser-whole' },
      false,
      BROWSER_CHILD
    );
    expect(done.message.phase).toBe('done');
    expect(done.code).toBe(0);
    expect(rows(l.store)).toEqual([
      { revision: 3, dispatched: true, terminal: { status: 'completed', evidenceRefIds: [] } },
    ]);
    expect(effects(l.counter)).toBe(1);
  }, 120_000);
});
