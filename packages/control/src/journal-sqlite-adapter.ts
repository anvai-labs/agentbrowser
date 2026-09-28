/** Bounded manager and raw adapter factory over the concrete SQLite journal child
 * (J2b.2 step 2). Deliberately absent from the control barrel: nothing here is wired
 * into the service, and no public capability is enabled.
 *
 * One manager owns ONE storage child for all namespace handles (never one child per
 * open). The child self-exits after the last live handle closes and all in-flight
 * calls settle; parent death orphans it into refusing work through the owner's
 * disconnect seal. A second handle for a live namespace is refused at the manager
 * before the child sees it. Calls that outlive their caller's timeout settle from
 * the bounded correlation map when the child replies, or as uncertain on child exit.
 */
import { type ChildProcess, fork } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import type { JournalSqliteStoreOptions } from './journal-sqlite-store.js';
import type { RawJournalNamespace, RawOperationJournalAdapter } from './journal-types.js';

export interface JournalSqliteAdapterOptions extends JournalSqliteStoreOptions {
  /** Compiled child entry; defaults to the sibling of this compiled module. */
  childModulePath?: string;
  /**
   * Extra argv appended verbatim to the child spawn. Operational escape hatch
   * (operator diagnostics) and qualification seam (the crash-barrier gates arm
   * their instrumented child through it); the production child ignores argv
   * beyond its own options.
   */
  childArgv?: string[];
}

interface ChildReply {
  readonly kind?: unknown;
  readonly openId?: unknown;
  readonly correlationId?: unknown;
  readonly outcome?: unknown;
  readonly reason?: unknown;
  readonly namespace?: unknown;
  readonly ownerFence?: unknown;
}

const READY_TIMEOUT_MS = 30_000;

export async function openJournalSqliteOperationJournalAdapter(
  options: JournalSqliteAdapterOptions
): Promise<
  RawOperationJournalAdapter & {
    dispose(): Promise<void>;
    /** OS pid of the storage child, for operator diagnostics and forced teardown. */
    readonly childPid: number | undefined;
  }
> {
  const childPath =
    options.childModulePath ?? fileURLToPath(new URL('./journal-sqlite-child.js', import.meta.url));
  const child: ChildProcess = fork(
    childPath,
    [
      JSON.stringify({
        directory: options.directory,
        anchorDirectory: options.anchorDirectory,
        restoreGeneration: options.restoreGeneration,
        initialize: options.initialize === true,
      }),
      ...(options.childArgv ?? []),
    ],
    { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], execArgv: [] }
  );
  const pendingOpen = new Map<number, (reply: ChildReply) => void>();
  const pendingCorrelation = new Map<number, (reply: ChildReply) => void>();
  let openSequence = 0;
  let correlationSequence = 0;
  /** namespaceId → live ownerFence; the manager-level second-handle refusal. */
  const liveNamespaces = new Map<string, string>();

  // Death (exit or channel error) makes the whole manager uncertain: pending calls
  // settle as faulted, and the namespace map clears — a dead manager cannot know
  // ownership (its fences are stale; a fresh generation acquires immediately).
  let dead = false;
  const settleAll = () => {
    for (const resolve of pendingOpen.values()) {
      resolve({ kind: 'uncertain', reason: 'io' });
    }
    pendingOpen.clear();
    for (const resolve of pendingCorrelation.values()) {
      resolve({ kind: 'faulted', correlationId: 0 });
    }
    pendingCorrelation.clear();
    liveNamespaces.clear();
  };
  const failDead = () => {
    if (dead) return;
    dead = true;
    settleAll();
  };
  const exited = once(child, 'exit');
  void exited.catch(() => {});
  void exited.then(failDead);
  // The callback form of send already swallows async delivery errors; this listener
  // is the belt to those braces — without it a channel error crashes the host.
  child.on('error', () => failDead());

  child.on('message', (message: ChildReply) => {
    if (message.kind === 'ready') return; // handshake consumed separately
    if (dead) return;
    if (message.openId !== undefined) {
      pendingOpen.get(message.openId as number)?.(message);
      return;
    }
    if (message.correlationId !== undefined) {
      pendingCorrelation.get(message.correlationId as number)?.(message);
    }
  });

  const sendRequest = (message: object): void => {
    if (dead) throw new Error('journal storage child has exited');
    // Callback form: async channel-close errors settle here, never as an
    // uncaught 'error' event that would crash the host process. The callback
    // delivers null on success — only a real error marks the manager dead.
    child.send(message, (error) => {
      if (error !== null && error !== undefined) failDead();
    });
  };
  const callOpen = (descriptor: RawJournalNamespace, openId: number): Promise<ChildReply> =>
    new Promise((resolve, reject) => {
      pendingOpen.set(openId, resolve);
      try {
        sendRequest({ kind: 'open', openId, descriptor });
      } catch (error) {
        pendingOpen.delete(openId);
        reject(error);
      }
    });
  const callCorrelated = (
    message: Record<string, unknown> & { correlationId: number }
  ): Promise<ChildReply> =>
    new Promise((resolve, reject) => {
      pendingCorrelation.set(message.correlationId, resolve);
      try {
        sendRequest(message);
      } catch (error) {
        pendingCorrelation.delete(message.correlationId);
        reject(error);
      }
    });

  // Readiness handshake: the child broadcasts once the store is acquired and its
  // message loop is live. A bootstrap failure exits nonzero and rejects here.
  await new Promise<void>((resolve, reject) => {
    // A timed-out or errored child keeps the store's exclusive locks: every
    // rejection path must kill it or the directory is wedged for all future
    // managers.
    const abandon = (message: string) => {
      cleanup();
      child.kill('SIGKILL');
      reject(new Error(message));
    };
    const timer = setTimeout(
      () => abandon('journal storage child never became ready'),
      READY_TIMEOUT_MS
    );
    const cleanup = () => clearTimeout(timer);
    const onMessage = (message: ChildReply) => {
      if (message.kind === 'ready') {
        child.off('message', onMessage);
        child.off('error', onError);
        cleanup();
        resolve();
      }
    };
    const onError = () => abandon('journal storage child channel error before ready');
    child.on('message', onMessage);
    child.on('error', onError);
    void exited.then(() => {
      child.off('message', onMessage);
      child.off('error', onError);
      cleanup();
      reject(new Error('journal storage child exited before ready'));
    });
  });

  const openRaw = async (request: RawJournalNamespace, signal: AbortSignal): Promise<unknown> => {
    // Death precedes every definite answer: a dead manager cannot claim ownership
    // or capacity — its fences are stale the moment the child exited.
    if (dead || signal.aborted) return { kind: 'uncertain', reason: 'io' };
    if (liveNamespaces.has(request.namespaceId))
      return { kind: 'definitely_not_opened', reason: 'ownership' };
    let reply: ChildReply;
    try {
      reply = await callOpen(request, ++openSequence);
    } catch {
      return { kind: 'uncertain', reason: 'io' };
    }
    if (reply.kind === 'faulted' || reply.kind === 'uncertain')
      return { kind: 'uncertain', reason: 'io' };
    if (reply.kind !== 'opened') return { kind: reply.kind, reason: reply.reason };
    const namespaceId = request.namespaceId;
    const ownerFence = reply.ownerFence as string;
    liveNamespaces.set(namespaceId, ownerFence);
    const call = async (kind: string, value: unknown) => {
      const correlationId = ++correlationSequence;
      let response: ChildReply;
      try {
        response = await callCorrelated({
          kind,
          correlationId,
          namespaceId,
          ownerFence,
          value,
        });
      } catch {
        throw new Error('private storage fault; no text crosses IPC');
      }
      if (response.kind === 'faulted')
        throw new Error('private storage fault; no text crosses IPC');
      return response.outcome;
    };
    const handle = {
      reserveIntent: (stamped: { value: unknown }) => call('reserveIntent', stamped.value),
      markDispatch: (stamped: { value: unknown }) => call('markDispatch', stamped.value),
      commitTerminal: (stamped: { value: unknown }) => call('commitTerminal', stamped.value),
      lookup: (stamped: { value: unknown }) => call('lookup', stamped.value),
      async close() {
        const correlationId = ++correlationSequence;
        const response = await callCorrelated({
          kind: 'close',
          correlationId,
          namespaceId,
          ownerFence,
        });
        liveNamespaces.delete(namespaceId);
        if (response.kind === 'faulted')
          throw new Error('private storage fault; no text crosses IPC');
        return (response.outcome as { readonly value: unknown }).value;
      },
    };
    return {
      kind: 'opened',
      namespace: reply.namespace as RawJournalNamespace,
      ownerFence,
      handle,
    };
  };

  return {
    async open(request: RawJournalNamespace, signal: AbortSignal) {
      return openRaw(request, signal);
    },
    /** OS pid of the storage child, for operator diagnostics and forced teardown. */
    childPid: child.pid,
    async dispose() {
      // Explicit teardown for a manager with no in-flight work: graceful shutdown
      // is the child's own last-handle-close exit; this reclaims a straggler.
      if (!dead && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await exited;
    },
  };
}
