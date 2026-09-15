/** Bounded diagnostic transport only; not a production WebDriver client. */
export class BidiProbeConnection {
  #socket; #pending = new Map(); #listeners = new Set(); #next = 0; #closed = false;
  #timeoutMs; #maxPending;
  constructor(socket, { timeoutMs = 5000, maxPending = 64 } = {}) {
    this.#socket = socket; this.#timeoutMs = timeoutMs; this.#maxPending = maxPending;
    socket.addEventListener('message', event => {
      if (this.#closed) return;
      let message;
      try { message = JSON.parse(event.data); }
      catch { this.close(new Error('Malformed BiDi message')); return; }
      if (message?.type === 'event' && typeof message.method === 'string') {
        try { for (const listener of this.#listeners) listener(message); }
        catch (error) { this.close(error); }
        return;
      }
      if (!['success', 'error'].includes(message?.type) || !Number.isSafeInteger(message.id)) {
        this.close(new Error('Malformed BiDi response')); return;
      }
      const pending = this.#pending.get(message.id);
      if (!pending) { this.close(new Error('Uncorrelated BiDi response')); return; }
      this.#pending.delete(message.id); clearTimeout(pending.timer);
      if (message.type === 'error') pending.reject(new Error(`${message.error}: ${message.message}`));
      else pending.resolve(message.result);
    });
    socket.addEventListener('close', () => this.close());
    socket.addEventListener('error', () => this.close(new Error('BiDi socket error')));
  }
  onEvent(listener) { this.#listeners.add(listener); return () => this.#listeners.delete(listener); }
  send(method, params = {}) {
    if (this.#closed) return Promise.reject(new Error('BiDi connection closed'));
    if (this.#pending.size >= this.#maxPending) return Promise.reject(new Error('BiDi command capacity exceeded'));
    return new Promise((resolve, reject) => {
      const id = ++this.#next;
      const timer = setTimeout(() => {
        const error = new Error(`BiDi command timed out: ${method}`); error.name = 'TimeoutError';
        this.close(error);
      }, this.#timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      try { this.#socket.send(JSON.stringify({ id, method, params })); }
      catch (error) { this.close(error); }
    });
  }
  close(error = new Error('BiDi connection closed')) {
    if (this.#closed) return;
    this.#closed = true;
    for (const pending of this.#pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.#pending.clear(); this.#listeners.clear(); this.#socket.close();
  }
}

export async function connectBidiProbe(url) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'ws:' || parsed.hostname !== '127.0.0.1') throw new Error('Probe requires an owned loopback endpoint');
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer); socket.removeEventListener('open', opened);
      socket.removeEventListener('error', failed); socket.removeEventListener('close', failed);
    };
    const opened = () => { cleanup(); resolve(); };
    const failed = () => { cleanup(); socket.close(); reject(new Error('BiDi connection failed')); };
    const timer = setTimeout(failed, 5000);
    socket.addEventListener('open', opened); socket.addEventListener('error', failed); socket.addEventListener('close', failed);
  });
  return new BidiProbeConnection(socket);
}
