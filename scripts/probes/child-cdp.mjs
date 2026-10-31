// Diagnostic-only bridge for pinned Chromium's non-flattened child sessions.
// Not a production transport abstraction: this CDP mechanism is deprecated.
import { EventEmitter } from 'node:events';

export class ChildCdp extends EventEmitter {
  #parent;
  #sessionId;
  #pending = new Map();
  #nextId = 0;
  #closed = false;
  #receive;
  #detach;
  constructor(parent, sessionId, { timeoutMs = 2000, capacity = 32 } = {}) {
    super();
    this.#parent = parent;
    this.#sessionId = sessionId;
    this.timeoutMs = timeoutMs;
    this.capacity = capacity;
    this.#receive = event => {
      if (event.sessionId !== sessionId) return;
      let message;
      try { message = JSON.parse(event.message); }
      catch { this.close(new Error('malformed child CDP message')); return; }
      if (message.id !== undefined) {
        const pending = this.#pending.get(message.id);
        if (!pending) return;
        this.#pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result);
      } else if (message.method) this.emit(message.method, message.params);
    };
    this.#detach = event => {
      if (event.sessionId === sessionId) this.close(new Error('child CDP detached'));
    };
    parent.on('Target.receivedMessageFromTarget', this.#receive);
    parent.on('Target.detachedFromTarget', this.#detach);
  }
  get pendingCount() { return this.#pending.size; }
  send(method, params = {}) {
    if (this.#closed) return Promise.reject(new Error('child CDP closed'));
    if (this.#pending.size >= this.capacity) return Promise.reject(new Error('child CDP capacity exceeded'));
    const id = ++this.#nextId;
    return new Promise((resolve, reject) => {
      const fail = error => {
        const pending = this.#pending.get(id);
        if (!pending) return;
        this.#pending.delete(id);
        clearTimeout(pending.timer);
        reject(error);
      };
      const timer = setTimeout(() => fail(new Error(`child CDP timeout: ${method}`)), this.timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      Promise.resolve().then(() => this.#pending.has(id) && this.#parent.send('Target.sendMessageToTarget', {
        sessionId: this.#sessionId, message: JSON.stringify({ id, method, params }),
      })).catch(fail);
    });
  }
  close(error = new Error('child CDP closed')) {
    if (this.#closed) return;
    this.#closed = true;
    this.#parent.off('Target.receivedMessageFromTarget', this.#receive);
    this.#parent.off('Target.detachedFromTarget', this.#detach);
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
    this.removeAllListeners();
  }
}
