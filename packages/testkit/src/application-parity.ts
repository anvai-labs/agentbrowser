import type { BrowserEngine, EnginePage } from '@agentbrowser/engine';
import { assertCounterOutcome, startVersionedApp } from './versioned-app.js';

async function until<T>(read: () => Promise<T>, accept: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 5000;
  let last: T | undefined;
  do {
    const value = await read();
    last = value;
    if (accept(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  } while (Date.now() < deadline);
  throw new Error(
    `Application fixture did not reach expected state: ${JSON.stringify(last).slice(0, 4000)}`
  );
}

async function clickAdd(page: EnginePage) {
  const observation = await until(
    () => page.observe({ mode: 'interactive' }),
    (state) => state.elements.some((element) => element.name === 'Add' && element.enabled)
  );
  const target = observation.elements.find((element) => element.name === 'Add');
  // This is a parity QUALIFIER: a missing element or ref means the engine
  // failed the fixture, and a thrown diagnostic beats an `undefined` ref
  // arriving at act() as an opaque protocol error.
  if (target?.ref === undefined) {
    throw new Error('parity fixture: no enabled "Add" element with a ref after observe()');
  }
  await page.act({ type: 'click', target: { ref: target.ref } });
}

/** Same executable fixture for every engine; application state is measured out of band. */
export async function qualifyApplicationParity(engine: BrowserEngine): Promise<void> {
  const app = await startVersionedApp({ loseFirstResponse: true });
  let session: Awaited<ReturnType<BrowserEngine['createSession']>> | undefined;
  try {
    session = await engine.createSession({});
    const page = await session.newPage();
    await page.navigate({ url: app.url });
    await clickAdd(page);
    // The click succeeded but its HTTP response was lost. The application still recorded one effect.
    await until(
      async () => app.oracle.snapshot(),
      (state) => state.version === 1
    );
    await until(
      () => page.observe({ mode: 'interactive' }),
      (state) => state.elements.some((element) => element.name?.includes('Outcome unknown.'))
    );
    await clickAdd(page); // UI explicitly reconciles the same application command ID.
    const recovered = await until(
      () => page.observe({ mode: 'interactive' }),
      (state) => state.elements.some((element) => element.name?.startsWith('Recorded '))
    );
    const recordedName = recovered.elements.find((element) =>
      element.name?.startsWith('Recorded ')
    )?.name;
    if (recordedName === undefined) {
      throw new Error('parity fixture: no "Recorded <id>" element after reconciliation');
    }
    const operationId = recordedName.slice('Recorded '.length);
    assertCounterOutcome(app.oracle, { operationId, expectedVersion: 0, amount: 1 });
    if (app.oracle.snapshot().version !== 1)
      throw new Error('UI reconciliation duplicated the effect');

    // Direct application seam can use the same version/receipt semantics, with no UI execution.
    const command = { operationId: 'direct-api', expectedVersion: 1, amount: 1 };
    const send = (body: unknown) =>
      fetch(`${app.url}/commands`, { method: 'POST', body: JSON.stringify(body) });
    const response = await send(command);
    if (!response.ok) throw new Error('Direct application command failed');
    assertCounterOutcome(app.oracle, command);
    await send(command);
    if (app.oracle.snapshot().version !== 2 || app.oracle.snapshot().total !== 2)
      throw new Error('API retry duplicated the effect');

    // The UI still displays version 1. A subsequent human click must conflict rather than overwrite.
    await clickAdd(page);
    await until(
      () => page.observe({ mode: 'interactive' }),
      (state) => state.elements.some((element) => element.name?.includes('VERSION_CONFLICT'))
    );
    if (app.oracle.snapshot().version !== 2)
      throw new Error('Stale UI overwrote application state');
  } finally {
    await session?.close();
    await app.close();
  }

  const broken = await startVersionedApp({ ignoreUiClicks: true });
  try {
    const session = await engine.createSession({});
    try {
      const page = await session.newPage();
      await page.navigate({ url: broken.url });
      await clickAdd(page);
      await until(
        () => page.observe({ mode: 'interactive' }),
        (state) => state.elements.some((element) => element.name === 'Click ignored')
      );
      if (broken.oracle.snapshot().version !== 0)
        throw new Error('Broken UI unexpectedly changed state');
      // A forged successful tool result cannot satisfy this oracle.
      let refused = false;
      try {
        assertCounterOutcome(broken.oracle, {
          operationId: 'claimed-success',
          expectedVersion: 0,
          amount: 1,
        });
      } catch {
        refused = true;
      }
      if (!refused) throw new Error('Oracle accepted a fabricated completion');
    } finally {
      await session.close();
    }
  } finally {
    await broken.close();
  }
}
