import { type ChildProcess, fork } from 'node:child_process';
import { once } from 'node:events';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const children: { child: ChildProcess; exited: Promise<unknown> }[] = [];
const directories: string[] = [];
function paths() {
  const base = mkdtempSync(join(realpathSync(tmpdir()), 'journal-owner-'));
  directories.push(base);
  const directory = join(base, 'store');
  const anchorDirectory = join(base, 'anchor');
  mkdirSync(directory, { mode: 0o700 });
  mkdirSync(anchorDirectory, { mode: 0o700 });
  return { directory, anchorDirectory, restoreGeneration: 'generation-1' };
}
function start(options: object, fault = '') {
  const child = fork(
    new URL('./journal-sqlite-store.test-support.ts', import.meta.url),
    [JSON.stringify(options), fault],
    {
      execArgv: ['--experimental-strip-types'],
      cwd: tmpdir(),
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    }
  );
  const exited = once(child, 'exit');
  void exited.catch(() => {});
  children.push({ child, exited });
  const messages: unknown[] = [];
  let pending: ((value: unknown) => void) | undefined;
  let stderr = '';
  child.stderr?.on('data', (data) => {
    stderr += data;
  });
  child.on('message', (message) => {
    if (pending) {
      const resolve = pending;
      pending = undefined;
      resolve(message);
    } else messages.push(message);
  });
  return {
    child,
    exited,
    async next() {
      if (messages.length) return messages.shift();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          new Promise((resolve) => {
            pending = resolve;
          }),
          exited.then(() => {
            throw new Error(`Child exited: ${stderr}`);
          }),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('Child reply deadline')), 10000);
          }),
        ]);
      } finally {
        clearTimeout(timer);
        pending = undefined;
      }
    },
    async stop() {
      child.kill('SIGKILL');
      await exited;
    },
  };
}
afterEach(async () => {
  await Promise.all(
    children.splice(0).map(async ({ child, exited }) => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await exited;
    })
  );
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
async function initialize(options: ReturnType<typeof paths>) {
  const owner = start({ ...options, initialize: true });
  expect(await owner.next()).toMatchObject({ phase: 'opened', witness: { commitSeq: 0 } });
  return owner;
}

describe('internal SQLite owner and external commit witness (real child processes)', () => {
  it('excludes contenders and reopens the exact durable witness after clean close', async () => {
    const options = paths();
    const owner = await initialize(options);
    const contender = start(options);
    expect(await contender.next()).toMatchObject({ phase: 'refused' });
    owner.child.send('mutate');
    const ack = await owner.next();
    expect(ack).toMatchObject({ phase: 'ack', witness: { commitSeq: 1 } });
    owner.child.send('close');
    await owner.exited;
    const reopened = start(options);
    expect(await reopened.next()).toMatchObject({
      phase: 'opened',
      witness: (ack as { witness: unknown }).witness,
    });
    reopened.child.send('inspect');
    expect(await reopened.next()).toEqual({ phase: 'observed', count: 1 });
  });
  it.each(['before_commit', 'after_commit', 'after_anchor'])(
    'classifies process loss at %s without repairing the pair',
    async (fault) => {
      const options = paths();
      const initial = await initialize(options);
      initial.child.send('close');
      await initial.exited;
      const owner = start(options, fault);
      expect(await owner.next()).toMatchObject({ phase: 'opened' });
      owner.child.send('mutate');
      expect(await owner.next()).toEqual({ phase: fault });
      await owner.stop();
      const reopened = start(options);
      expect(await reopened.next()).toMatchObject(
        fault === 'after_commit'
          ? { phase: 'refused' }
          : { phase: 'opened', witness: { commitSeq: fault === 'before_commit' ? 0 : 1 } }
      );
      if (fault === 'after_anchor') {
        reopened.child.send('inspect');
        expect(await reopened.next()).toEqual({ phase: 'observed', count: 1 });
      }
    }
  );
  it('seals after anchor failure, withholds ACK and refuses reopen', async () => {
    const options = paths();
    const initial = await initialize(options);
    initial.child.send('close');
    await initial.exited;
    const owner = start(options, 'anchor_error');
    expect(await owner.next()).toMatchObject({ phase: 'opened' });
    owner.child.send('mutate');
    expect(await owner.next()).toEqual({ phase: 'error', error: 'Journal store unavailable' });
    owner.child.send('mutate');
    expect(await owner.next()).toEqual({ phase: 'error', error: 'Journal store unavailable' });
    await owner.stop();
    expect(await start(options).next()).toMatchObject({ phase: 'refused' });
  });
  it.each(['missing', 'malformed', 'stale', 'wrong_generation'])(
    'refuses %s anchor/generation',
    async (change) => {
      const options = paths();
      const owner = await initialize(options);
      const anchor = join(options.anchorDirectory, 'commit.json');
      const old = readFileSync(anchor);
      owner.child.send('mutate');
      expect(await owner.next()).toMatchObject({ phase: 'ack' });
      owner.child.send('close');
      await owner.exited;
      if (change === 'missing') unlinkSync(anchor);
      if (change === 'malformed') writeFileSync(anchor, '{}');
      if (change === 'stale') writeFileSync(anchor, old);
      expect(
        await start({
          ...options,
          restoreGeneration: change === 'wrong_generation' ? 'other' : options.restoreGeneration,
        }).next()
      ).toMatchObject({ phase: 'refused' });
    }
  );
  it.each(['symlink', 'hardlink', 'public_directory', 'overlap', 'partial'])(
    'rejects unsafe layout %s',
    async (change) => {
      const options = paths();
      if (change === 'public_directory') chmodSync(options.directory, 0o755);
      if (change === 'overlap') options.anchorDirectory = options.directory;
      if (change === 'partial')
        writeFileSync(join(options.directory, 'owner.sqlite'), '', { mode: 0o600 });
      if (change === 'symlink' || change === 'hardlink') {
        const target = join(options.anchorDirectory, 'target');
        writeFileSync(target, '', { mode: 0o600 });
        if (change === 'symlink') symlinkSync(target, join(options.directory, 'owner.sqlite'));
        else linkSync(target, join(options.directory, 'owner.sqlite'));
      }
      expect(await start({ ...options, initialize: true }).next()).toMatchObject({
        phase: 'refused',
      });
      expect(existsSync(join(options.directory, 'journal.sqlite'))).toBe(false);
    }
  );
  it('refuses restoring an old DB against the current external anchor', async () => {
    const options = paths();
    const owner = await initialize(options);
    owner.child.send('close');
    await owner.exited;
    const backup = join(options.directory, 'snapshot');
    copyFileSync(join(options.directory, 'journal.sqlite'), backup);
    const writer = start(options);
    expect(await writer.next()).toMatchObject({ phase: 'opened' });
    writer.child.send('mutate');
    expect(await writer.next()).toMatchObject({ phase: 'ack' });
    writer.child.send('close');
    await writer.exited;
    copyFileSync(backup, join(options.directory, 'journal.sqlite'));
    expect(await start(options).next()).toMatchObject({ phase: 'refused' });
  });
  it('leaves interrupted initialization quarantined instead of recreating a pair', async () => {
    const options = paths();
    const owner = start({ ...options, initialize: true }, 'init_after_commit');
    expect(await owner.next()).toEqual({ phase: 'init_after_commit' });
    await owner.stop();
    expect(await start(options).next()).toMatchObject({ phase: 'refused' });
    expect(await start({ ...options, initialize: true }).next()).toMatchObject({
      phase: 'refused',
    });
  });
  it('rejects duplicate owners in one child without releasing the existing lock', async () => {
    const options = paths();
    const owner = await initialize(options);
    owner.child.send('duplicate');
    expect(await owner.next()).toEqual({ phase: 'error', error: 'Journal store unavailable' });
    expect(await start(options).next()).toMatchObject({ phase: 'refused' });
    owner.child.send('mutate');
    expect(await owner.next()).toMatchObject({ phase: 'ack' });
  });
  it('does not ACK a failed anchor directory fsync even when the new pair is visible', async () => {
    const options = paths();
    const initial = await initialize(options);
    initial.child.send('close');
    await initial.exited;
    const owner = start(options, 'directory_sync_error');
    expect(await owner.next()).toMatchObject({ phase: 'opened' });
    owner.child.send('mutate');
    expect(await owner.next()).toEqual({ phase: 'error', error: 'Journal store unavailable' });
    owner.child.send('mutate');
    expect(await owner.next()).toEqual({ phase: 'error', error: 'Journal store unavailable' });
  });
  it('rolls back callback failure, seals the handle, and preserves the previous pair', async () => {
    const options = paths();
    const owner = await initialize(options);
    owner.child.send('callback_error');
    expect(await owner.next()).toEqual({ phase: 'error', error: 'Journal store unavailable' });
    owner.child.send('mutate');
    expect(await owner.next()).toEqual({ phase: 'error', error: 'Journal store unavailable' });
    owner.child.send('close');
    await owner.exited;
    expect(await start(options).next()).toMatchObject({
      phase: 'opened',
      witness: { commitSeq: 0 },
    });
  });
  it('cannot initialize a second store against an already reserved anchor directory', async () => {
    const options = paths();
    await initialize(options);
    const original = readFileSync(join(options.anchorDirectory, 'commit.json'));
    const other = paths();
    expect(
      await start({ ...other, anchorDirectory: options.anchorDirectory, initialize: true }).next()
    ).toMatchObject({ phase: 'refused' });
    expect(readFileSync(join(options.anchorDirectory, 'commit.json'))).toEqual(original);
  });
  it('creates private files and advances sequence and nonce together', async () => {
    const options = paths();
    const owner = await initialize(options);
    for (const path of [
      join(options.directory, 'owner.sqlite'),
      join(options.directory, 'journal.sqlite'),
      join(options.anchorDirectory, 'commit.json'),
    ]) {
      expect(statSync(path).mode & 0o777).toBe(0o600);
    }
    owner.child.send('mutate');
    owner.child.send('mutate');
    const first = (await owner.next()) as { witness: { commitNonce: string; commitSeq: number } };
    const second = (await owner.next()) as typeof first;
    expect(first.witness.commitSeq).toBe(1);
    expect(second.witness.commitSeq).toBe(2);
    expect(second.witness.commitNonce).not.toBe(first.witness.commitNonce);
  });
  it.each(['commitNonce', 'commitSeq', 'storeUUID', 'formatVersion', 'oversize', 'temp'])(
    'rejects anchor mismatch %s',
    async (change) => {
      const options = paths();
      const owner = await initialize(options);
      owner.child.send('close');
      await owner.exited;
      const path = join(options.anchorDirectory, 'commit.json');
      const value = JSON.parse(readFileSync(path, 'utf8'));
      if (change === 'temp')
        writeFileSync(join(options.anchorDirectory, 'commit.pending'), '{}', { mode: 0o600 });
      else if (change === 'oversize') writeFileSync(path, ' '.repeat(1025));
      else {
        value[change] =
          change === 'commitSeq' || change === 'formatVersion'
            ? 2
            : '00000000-0000-4000-8000-000000000000';
        writeFileSync(path, JSON.stringify(value));
      }
      expect(await start(options).next()).toMatchObject({ phase: 'refused' });
    }
  );
  it('uses the compiled module from an unrelated process working directory', async () => {
    const options = paths();
    const owner = start({ ...options, initialize: true });
    expect(await owner.next()).toMatchObject({ phase: 'opened' });
    owner.child.send('mutate');
    expect(await owner.next()).toMatchObject({ phase: 'ack', witness: { commitSeq: 1 } });
  });
  it('serializes concurrent first initialization against the same anchor', async () => {
    const first = paths();
    const second = { ...paths(), anchorDirectory: first.anchorDirectory };
    const contenders = [
      start({ ...first, initialize: true }),
      start({ ...second, initialize: true }),
    ];
    const replies = (await Promise.all(contenders.map((child) => child.next()))) as {
      phase: string;
    }[];
    expect(replies.map((reply) => reply.phase).sort()).toEqual(['opened', 'refused']);
  });
  it.each([
    'retained',
    'transaction_escape',
    'witness_escape',
    'return_capability',
    'pragma_escape',
    'attach_escape',
  ])('refuses callback capability escape %s', async (action) => {
    const options = paths();
    const owner = await initialize(options);
    owner.child.send(action);
    expect(await owner.next()).toEqual({ phase: 'error', error: 'Journal store unavailable' });
  });
  it('rejects a cloned store sharing an anchor while the original owns it', async () => {
    const original = paths();
    const initial = await initialize(original);
    initial.child.send('close');
    await initial.exited;
    const clone = { ...paths(), anchorDirectory: original.anchorDirectory };
    copyFileSync(join(original.directory, 'owner.sqlite'), join(clone.directory, 'owner.sqlite'));
    copyFileSync(
      join(original.directory, 'journal.sqlite'),
      join(clone.directory, 'journal.sqlite')
    );
    const owner = start(original);
    expect(await owner.next()).toMatchObject({ phase: 'opened' });
    expect(await start(clone).next()).toMatchObject({ phase: 'refused' });
  });
  it.each(['whitespace', 'duplicate'])('rejects noncanonical anchor JSON: %s', async (change) => {
    const options = paths();
    const owner = await initialize(options);
    owner.child.send('close');
    await owner.exited;
    const anchor = join(options.anchorDirectory, 'commit.json');
    const raw = readFileSync(anchor, 'utf8');
    writeFileSync(
      anchor,
      change === 'whitespace' ? ` ${raw}` : raw.replace('{', '{"formatVersion":1,')
    );
    expect(await start(options).next()).toMatchObject({ phase: 'refused' });
  });
  it('refuses an async result and denies its later attempted write', async () => {
    const options = paths();
    const owner = await initialize(options);
    owner.child.send('async_escape');
    expect(await owner.next()).toEqual({ phase: 'error', error: 'Journal store unavailable' });
    expect(await owner.next()).toEqual({
      phase: 'late_refused',
      error: 'Journal store unavailable',
    });
  });
  it('revokes retained methods before a microtask can write', async () => {
    const options = paths();
    const owner = await initialize(options);
    owner.child.send('microtask');
    expect(await owner.next()).toEqual({
      phase: 'late_refused',
      error: 'Journal store unavailable',
    });
  });
  it('retains both lifetime locks when checkpoint is blocked by a real reader', async () => {
    const options = paths();
    const owner = await initialize(options);
    owner.child.send('hold_reader');
    expect(await owner.next()).toEqual({ phase: 'reader_held' });
    owner.child.send('mutate');
    expect(await owner.next()).toMatchObject({ phase: 'ack' });
    owner.child.send('close');
    expect(await owner.next()).toEqual({ phase: 'error', error: 'Journal store unavailable' });
    expect(await start(options).next()).toMatchObject({ phase: 'refused' });
    await owner.stop();
    expect(await start(options).next()).toMatchObject({
      phase: 'opened',
      witness: { commitSeq: 1 },
    });
  });
  it('withholds ACK when the recreated WAL directory cannot be synced', async () => {
    const options = paths();
    const initial = await initialize(options);
    initial.child.send('close');
    await initial.exited;
    const owner = start(options, 'store_directory_sync_error');
    expect(await owner.next()).toMatchObject({ phase: 'opened' });
    owner.child.send('mutate');
    expect(await owner.next()).toEqual({ phase: 'error', error: 'Journal store unavailable' });
    await owner.stop();
    expect(await start(options).next()).toMatchObject({ phase: 'refused' });
  });
  it('exits on parent IPC loss and releases ownership only through actual exit', async () => {
    const options = paths();
    const owner = await initialize(options);
    owner.child.disconnect();
    await owner.exited;
    expect(await start(options).next()).toMatchObject({ phase: 'opened' });
  });
});
