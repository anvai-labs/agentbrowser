import { UsageError } from '@agentbrowser/protocol';
import type { AgentBrowserClient, SessionResponse } from '@agentbrowser/sdk-typescript';

type Port = Partial<Pick<AgentBrowserClient['sessions'], 'get' | 'traceDenials'>>;
/** Connection-owned live diagnostics; never changes a backend session. */
export class ScopeTraceMonitor {
  private readonly observers = new Map<
    string,
    { controller: AbortController; task: Promise<void>; ready: Promise<void> }
  >();
  private readonly disabled = new Set<string>();
  private ended = false;
  constructor(
    private readonly sessions: Port,
    private readonly notify: (level: 'warning' | 'error' | 'info', data: unknown) => boolean
  ) {}
  async ensure(id: string): Promise<void> {
    const existing = this.observers.get(id);
    if (existing) return existing.ready;
    if (this.disabled.has(id)) return;
    if (!this.sessions.get) throw new UsageError('Client cannot inspect live denial trace support');
    const session = await this.sessions.get(id);
    if (!session) throw new UsageError('Trace session not found');
    await this.created(session);
  }
  async created(session: SessionResponse): Promise<void> {
    const id = session.sessionId;
    if (this.ended) throw new UsageError('MCP connection is closed');
    const existing = this.observers.get(id);
    if (existing) return existing.ready;
    if (session.trace !== 'denials') {
      if (this.disabled.size >= 128) {
        const first = this.disabled.values().next().value;
        if (first) this.disabled.delete(first);
      }
      this.disabled.add(id);
      if (session.trace === undefined && session.scope)
        this.notify('warning', {
          sessionId: id,
          message:
            'The service does not advertise live denial tracing; inspect retained scope events and upgrade the service.',
        });
      return;
    }
    const follow = this.sessions.traceDenials?.bind(this.sessions);
    if (!follow) throw new UsageError('Client cannot receive live scope denials');
    if (this.observers.size >= 32) throw new UsageError('MCP denial observer capacity reached');
    const controller = new AbortController();
    let resolveReady!: () => void;
    let rejectReady!: (error: unknown) => void;
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    const observer = { controller, task: Promise.resolve(), ready };
    this.observers.set(id, observer);
    observer.task = (async () => {
      try {
        for await (const event of follow(id, { signal: controller.signal, onReady: resolveReady }))
          if (!this.notify('warning', event))
            throw new Error('Trace notification delivery unavailable');
        resolveReady();
        if (!controller.signal.aborted)
          this.notify('info', { sessionId: id, message: 'Denial trace ended.' });
      } catch (error) {
        rejectReady(error);
        if (!controller.signal.aborted)
          this.notify('error', {
            sessionId: id,
            message: 'Live denial trace disconnected; inspect retained events before continuing.',
          });
      } finally {
        controller.abort();
        if (this.observers.get(id) === observer) this.observers.delete(id);
      }
    })();
    await ready;
  }
  closed(id: string): void {
    this.observers.get(id)?.controller.abort();
    this.disabled.delete(id);
  }
  async close(): Promise<void> {
    this.ended = true;
    const current = [...this.observers.values()];
    for (const entry of current) entry.controller.abort();
    await Promise.allSettled(current.map((entry) => entry.task));
    this.disabled.clear();
  }
}
