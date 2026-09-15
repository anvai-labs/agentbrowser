import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

/** Owned-application example contract, independent of any browser or harness. */
export interface CounterCommand {
  operationId: string;
  expectedVersion: number;
  amount: number;
}
export interface CounterReceipt extends CounterCommand {
  version: number;
  total: number;
}

function commandFrom(value: unknown): CounterCommand {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('INVALID_COMMAND');
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).sort().join(',') !== 'amount,expectedVersion,operationId' ||
    typeof record.operationId !== 'string' ||
    !/^[A-Za-z0-9_-]{1,100}$/.test(record.operationId) ||
    !Number.isSafeInteger(record.expectedVersion) ||
    (record.expectedVersion as number) < 0 ||
    !Number.isInteger(record.amount) ||
    (record.amount as number) < 1 ||
    (record.amount as number) > 100
  )
    throw new Error('INVALID_COMMAND');
  return {
    operationId: record.operationId,
    expectedVersion: record.expectedVersion as number,
    amount: record.amount as number,
  };
}

/** In-memory fixture only. A real application needs a durable atomic transaction. */
export class VersionedCounter {
  private version = 0;
  private total = 0;
  private readonly receipts = new Map<string, CounterReceipt>();
  constructor(private readonly capacity = 1000) {}

  snapshot() {
    return { version: this.version, total: this.total };
  }
  receipt(operationId: string): CounterReceipt | undefined {
    const receipt = this.receipts.get(operationId);
    return receipt ? { ...receipt } : undefined;
  }
  execute(input: CounterCommand): CounterReceipt {
    const command = commandFrom(input);
    const previous = this.receipts.get(command.operationId);
    if (previous) {
      if (
        previous.expectedVersion !== command.expectedVersion ||
        previous.amount !== command.amount
      )
        throw new Error('OPERATION_CONFLICT');
      return { ...previous };
    }
    if (command.expectedVersion !== this.version) throw new Error('VERSION_CONFLICT');
    if (this.receipts.size >= this.capacity) throw new Error('CAPACITY_EXCEEDED');
    // No await between compare, effect and receipt: one atomic fixture transition.
    this.version += 1;
    this.total += command.amount;
    const receipt = { ...command, version: this.version, total: this.total };
    this.receipts.set(command.operationId, receipt);
    return { ...receipt };
  }
}

/** Read an independent oracle; never take a claimed tool result as outcome proof. */
export function assertCounterOutcome(oracle: VersionedCounter, expected: CounterCommand): void {
  const receipt = oracle.receipt(expected.operationId);
  if (
    !receipt ||
    receipt.expectedVersion !== expected.expectedVersion ||
    receipt.amount !== expected.amount ||
    receipt.version !== expected.expectedVersion + 1 ||
    oracle.snapshot().version < receipt.version
  ) {
    throw new Error('OUTCOME_NOT_VERIFIED');
  }
}

/** Local regression fixture, not a deployable unauthenticated application server. */
export async function startVersionedApp(
  options: { ignoreUiClicks?: boolean; loseFirstResponse?: boolean } = {}
) {
  const oracle = new VersionedCounter();
  let loseResponse = options.loseFirstResponse ?? false;
  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const json = (status: number, data: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    };
    const pathname = new URL(req.url ?? '/', 'http://fixture.invalid').pathname;
    if (req.method === 'GET' && pathname === '/state') return json(200, oracle.snapshot());
    if (req.method === 'GET' && pathname.startsWith('/receipts/')) {
      const receipt = oracle.receipt(pathname.slice('/receipts/'.length));
      return json(receipt ? 200 : 404, receipt ?? { error: 'UNKNOWN_OPERATION' });
    }
    if (req.method === 'POST' && pathname === '/commands') {
      try {
        let body = '';
        for await (const chunk of req) {
          body += chunk;
          if (body.length > 4096) return json(413, { error: 'BODY_TOO_LARGE' });
        }
        const receipt = oracle.execute(commandFrom(JSON.parse(body)));
        if (loseResponse) {
          loseResponse = false;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.flushHeaders();
          res.write('{');
          setImmediate(() => res.destroy());
          return;
        }
        return json(200, receipt);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'INVALID_COMMAND';
        return json(message.endsWith('CONFLICT') ? 409 : 400, { error: message });
      }
    }
    if (req.method !== 'GET' || pathname !== '/') return json(404, { error: 'NOT_FOUND' });
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<!doctype html><html lang="en"><meta charset="utf-8"><title>Versioned counter</title>
      <h1>Shared application state</h1><p>Version <output id="version">0</output>. Total <output id="total">0</output>.</p>
      <form id="form"><label>Amount <input id="amount" type="text" inputmode="numeric" value="1"></label>
      <button id="add" disabled>Add</button></form><p id="status" role="status">Loading</p>
      <script>
      const form = document.getElementById('form'), amount = document.getElementById('amount'),
        add = document.getElementById('add'), status = document.getElementById('status');
      let version = 0, pending;
      function show(text) { status.textContent = text; status.setAttribute('aria-label', text); }
      function render(state) {
        version = state.version;
        document.getElementById('version').textContent = state.version;
        document.getElementById('total').textContent = state.total;
      }
      fetch('/state').then(r => r.json()).then(state => { render(state); add.disabled = false; show('Ready'); });
      form.onsubmit = async event => {
        event.preventDefault();
        if (${options.ignoreUiClicks === true}) { show('Click ignored'); return; }
        add.disabled = true;
        pending ??= { operationId: crypto.randomUUID(), expectedVersion: version, amount: Number(amount.value) };
        try {
          // A previous response may have been lost. Reconcile before sending again.
          const known = await fetch('/receipts/' + pending.operationId);
          const response = known.ok ? known : await fetch('/commands', { method: 'POST', body: JSON.stringify(pending) });
          const receipt = await response.json();
          if (!response.ok) {
            show(receipt.error + ': reload and review current state');
            pending = undefined;
            return;
          }
          render(receipt); show('Recorded ' + receipt.operationId); pending = undefined;
        } catch { show('Outcome unknown. Add again to reconcile this operation.'); }
        finally { add.disabled = false; }
      };
      </script></html>`);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    oracle,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  };
}
