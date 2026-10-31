// Diagnostic-only flattened CDP transport. No Playwright connection or engine API.
import { EventEmitter } from 'node:events';

export class RawCdp extends EventEmitter {
  #socket;
  #pending = new Map();
  #detached = new Set();
  #id = 0;
  #closed = false;
  #message;
  #disconnect;
  constructor(socket, { capacity = 32, timeoutMs = 2000, record = () => {} } = {}) {
    super();
    this.#socket = socket;
    this.capacity = capacity;
    this.timeoutMs = timeoutMs;
    this.record = record;
    this.#message = event => {
      let message;
      try {
        if (typeof event.data !== 'string' || Buffer.byteLength(event.data) > 262144) throw new Error('message capacity');
        message = JSON.parse(event.data);
        if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error('invalid envelope');
        if (message.id !== undefined) {
          if (!Number.isSafeInteger(message.id) || message.id < 1 || (!('result' in message) && !message.error)) throw new Error('invalid response');
        } else {
          if (typeof message.method !== 'string' || !message.params || typeof message.params !== 'object') throw new Error('invalid event');
          if (['Target.attachedToTarget', 'Target.detachedFromTarget'].includes(message.method) && typeof message.params.sessionId !== 'string') throw new Error('invalid session');
          if (message.method === 'Target.attachedToTarget' && (!message.params.targetInfo || typeof message.params.targetInfo.targetId !== 'string' || typeof message.params.targetInfo.type !== 'string' || typeof message.params.targetInfo.url !== 'string')) throw new Error('invalid target');
        }
      } catch { this.close(new Error('malformed or oversized CDP message')); return; }
      if (message.id !== undefined) {
        const pending = this.#pending.get(message.id);
        if (!pending || (message.sessionId ?? null) !== pending.sessionId) return;
        this.record({ kind: message.error ? 'command-error' : 'command-ack', commandId: message.id, method: pending.method, sessionId: pending.sessionId });
        this.#pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result);
      } else {
        if (message.method === 'Target.detachedFromTarget') {
          if (this.#detached.size >= 16) { this.close(new Error('detached-session capacity')); return; }
          this.#detached.add(message.params.sessionId);
          for (const pending of this.#pending.values()) if (pending.sessionId === message.params.sessionId) pending.fail(new Error('CDP session detached'));
        }
        this.emit('event', message);
      }
    };
    this.#disconnect = () => this.close(new Error('CDP connection closed'));
    socket.addEventListener('message', this.#message);
    socket.addEventListener('close', this.#disconnect);
    socket.addEventListener('error', this.#disconnect);
  }
  get pendingCount() { return this.#pending.size; }
  get closed() { return this.#closed; }
  send(method, params = {}, sessionId = null, timeoutMs = this.timeoutMs) {
    if (this.#closed || this.#socket.readyState !== 1) return Promise.reject(new Error('CDP connection closed'));
    if (this.#detached.has(sessionId)) return Promise.reject(new Error('CDP session detached'));
    if (this.#pending.size >= this.capacity) return Promise.reject(new Error('CDP command capacity'));
    const id = ++this.#id;
    const text = JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) });
    if (Buffer.byteLength(text) > 262144) return Promise.reject(new Error('CDP outbound capacity'));
    return new Promise((resolve, reject) => {
      const fail = error => {
        const pending = this.#pending.get(id);
        if (!pending) return;
        this.#pending.delete(id);
        clearTimeout(pending.timer);
        reject(error);
      };
      const timer = setTimeout(() => fail(new Error(`CDP timeout: ${method}`)), timeoutMs);
      this.#pending.set(id, { resolve, reject, timer, fail, sessionId, method });
      try {
        // No deferred dispatch: this timestamp immediately precedes socket.send.
        this.record({ kind: 'command-send', commandId: id, method, sessionId,
          ...(method === 'Target.setAutoAttach' ? { parameters: params } : {}) });
        this.#socket.send(text);
      } catch (error) { fail(error); }
    });
  }
  close(error = new Error('CDP connection closed')) {
    if (this.#closed) return;
    this.#closed = true;
    this.#socket.removeEventListener('message', this.#message);
    this.#socket.removeEventListener('close', this.#disconnect);
    this.#socket.removeEventListener('error', this.#disconnect);
    for (const pending of this.#pending.values()) pending.fail(error);
    this.#detached.clear();
    this.#socket.close();
    this.emit('closed', error);
    this.removeAllListeners();
  }
}

export async function connectCdp(endpoint, options) {
  const socket = new WebSocket(endpoint);
  await new Promise((resolve, reject) => {
    const finish = error => {
      clearTimeout(timer);
      socket.removeEventListener('open', open);
      socket.removeEventListener('error', fail);
      socket.removeEventListener('close', fail);
      if (error) { socket.close(); reject(error); } else resolve();
    };
    const open = () => finish();
    const fail = () => finish(new Error('CDP connection failed'));
    const timer = setTimeout(() => finish(new Error('CDP connect timeout')), 3000);
    socket.addEventListener('open', open);
    socket.addEventListener('error', fail);
    socket.addEventListener('close', fail);
  });
  return new RawCdp(socket, options);
}
