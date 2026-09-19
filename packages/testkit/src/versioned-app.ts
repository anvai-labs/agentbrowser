import { randomUUID } from 'node:crypto';
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

/** Controlled-fixture identity supplied by application authority, never by page input. */
export interface CounterIntentScope {
  tenant: string;
  resource: string;
  sessionId: string;
  sessionIncarnation: string;
}
export interface CounterUiIntent {
  readonly scope: Readonly<CounterIntentScope>;
  readonly command: Readonly<CounterCommand>;
}
export interface CounterUiReceipt extends CounterReceipt {
  scope: CounterIntentScope;
  channel: 'reserved_ui';
  eventId: string;
}
const SCOPE_KEYS = ['tenant', 'resource', 'sessionId', 'sessionIncarnation'] as const;
function intentScopeFrom(scope: CounterIntentScope): Readonly<CounterIntentScope> {
  const snapshot = {
    tenant: scope.tenant,
    resource: scope.resource,
    sessionId: scope.sessionId,
    sessionIncarnation: scope.sessionIncarnation,
  };
  if (
    Object.values(snapshot).some(
      (value) => typeof value !== 'string' || !value.length || value.length > 128
    )
  )
    throw new Error('INVALID_INTENT_SCOPE');
  return Object.freeze(snapshot);
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
  // Exactly one reservation per fixture instance; lifetime ends with this local app.
  let intent: CounterUiIntent | undefined;
  let uiToken: string | undefined;
  let claimed = false;
  let uiReceipt: CounterUiReceipt | undefined;
  const requireIntent = (scope: CounterIntentScope, operationId: string) => {
    const identity = intentScopeFrom(scope);
    const reserved = intent;
    if (
      !reserved ||
      operationId !== reserved.command.operationId ||
      SCOPE_KEYS.some((key) => identity[key] !== reserved.scope[key])
    )
      throw new Error('INTENT_SCOPE_MISMATCH');
    return reserved;
  };
  const reserveIntent = (scope: CounterIntentScope, amount: number): CounterUiIntent => {
    if (intent) throw new Error('INTENT_ALREADY_RESERVED');
    const identity = intentScopeFrom(scope);
    const command = Object.freeze(
      commandFrom({ operationId: randomUUID(), expectedVersion: oracle.snapshot().version, amount })
    );
    const token = randomUUID();
    intent = Object.freeze({ scope: identity, command });
    uiToken = token;
    return intent;
  };
  const claimIntent = (scope: CounterIntentScope, operationId: string, input: unknown) => {
    const reserved = requireIntent(scope, operationId);
    const expected = commandFrom(input);
    if (
      claimed ||
      expected.operationId !== operationId ||
      expected.expectedVersion !== reserved.command.expectedVersion ||
      expected.amount !== reserved.command.amount ||
      oracle.receipt(operationId) ||
      oracle.snapshot().version !== reserved.command.expectedVersion
    )
      throw new Error('INTENT_NOT_FRESH');
    claimed = true;
  };
  const intentReceipt = (
    scope: CounterIntentScope,
    operationId: string
  ): CounterUiReceipt | undefined => {
    requireIntent(scope, operationId);
    return uiReceipt ? { ...uiReceipt, scope: { ...uiReceipt.scope } } : undefined;
  };
  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const json = (status: number, data: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    };
    const pathname = new URL(req.url ?? '/', 'http://fixture.invalid').pathname;
    if (req.method === 'GET' && pathname === '/state') return json(200, oracle.snapshot());
    if (req.method === 'GET' && pathname.startsWith('/receipts/')) {
      const id = pathname.slice('/receipts/'.length);
      const receipt = id === intent?.command.operationId ? undefined : oracle.receipt(id);
      return json(receipt ? 200 : 404, receipt ?? { error: 'UNKNOWN_OPERATION' });
    }
    const uiSubmit = intent !== undefined && pathname === `/ui-submit/${uiToken}`;
    if (req.method === 'POST' && (pathname === '/commands' || uiSubmit)) {
      try {
        let body = '';
        for await (const chunk of req) {
          body += chunk;
          if (body.length > 4096) return json(413, { error: 'BODY_TOO_LARGE' });
        }
        const input = JSON.parse(body);
        let receipt: CounterReceipt;
        if (uiSubmit && intent) {
          if (
            !claimed ||
            !input ||
            Object.keys(input).join(',') !== 'amount' ||
            input.amount !== intent.command.amount
          )
            throw new Error('INTENT_CONFLICT');
          if (uiReceipt) receipt = uiReceipt;
          else {
            // No await between freshness check, counter transition and event creation.
            if (oracle.receipt(intent.command.operationId)) throw new Error('INTENT_CONFLICT');
            const eventId = randomUUID();
            const committed = oracle.execute(intent.command);
            uiReceipt = {
              ...committed,
              scope: { ...intent.scope },
              channel: 'reserved_ui',
              eventId,
            };
            receipt = uiReceipt;
          }
        } else {
          const command = commandFrom(input);
          if (command.operationId === intent?.command.operationId)
            throw new Error('INTENT_CONFLICT');
          receipt = oracle.execute(command);
        }
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
      <form id="form" action="${intent ? `/ui-submit/${uiToken}` : '/commands'}"><label>Amount <input id="amount" type="text" inputmode="numeric" value="${intent?.command.amount ?? 1}"></label>
      <button id="add" disabled>Add</button></form><p id="status" role="status">Loading</p>
      <script>
      const form = document.getElementById('form'), amount = document.getElementById('amount'),
        add = document.getElementById('add'), status = document.getElementById('status');
      const reserved = ${JSON.stringify(intent?.command ?? null)};
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
        pending ??= reserved ?? { operationId: crypto.randomUUID(), expectedVersion: version, amount: Number(amount.value) };
        try {
          // A previous response may have been lost. Reconcile before sending again.
          const known = reserved ? { ok: false } : await fetch('/receipts/' + pending.operationId);
          const response = known.ok ? known : await fetch(form.action, { method: 'POST', body: JSON.stringify(reserved ? { amount: Number(amount.value) } : pending) });
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
    reserveIntent,
    claimIntent,
    intentReceipt,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  };
}
