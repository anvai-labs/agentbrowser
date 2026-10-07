import { type Server, createServer } from 'node:http';
import { expect, it } from 'vitest';
import { PlaywrightChromiumEngine } from './index.js';

// Security regression: observed element values must never disclose secrets.
// The ARIA snapshot carries plaintext values for password inputs (both the
// inline `textbox "Name": value` syntax and the `/value:` annotation), so the
// engine must classify sensitivity at the trusted DOM-binding boundary and
// withhold values before refStore, diff state, fingerprints or the response.
// All credentials here are synthetic canaries; no real secrets.

const CANARY = 'SYNTH-REDACT-CANARY-3f9k2';

const loginPage = `<!DOCTYPE html><html><body><form id="f">
<label>User <input type="text" id="user" autocomplete="username"></label>
<label>Pass <input type="password" id="pw" autocomplete="current-password"></label>
<label>NewPass <input type="text" id="newpw" autocomplete="new-password"></label>
<label>Code <input type="text" id="otp" autocomplete="one-time-code" inputmode="numeric"></label>
<label>Cvc <input type="text" id="cvc" autocomplete="cc-csc" inputmode="numeric"></label>
<label>Plain <input type="text" id="plain"></label>
<label>Notes <textarea id="notes"></textarea></label>
<button type="button" id="toggle" onclick="const p=document.getElementById('tpw');p.type=p.type==='password'?'text':'password'">Toggle</button>
<label>TogglePw <input type="password" id="tpw"></label>
<label>Explicit <input type="text" id="explicit"></label>
<iframe src="/frame" title="Frame"></iframe>
</form></body></html>`;

const framePage = `<!DOCTYPE html><html><body><form>
<label>FramePass <input type="password" id="fpw"></label>
<label>FramePlain <input type="text" id="fplain"></label>
</form></body></html>`;

function startServer(): Promise<{ origin: string; close: () => Promise<void> }> {
  const server = createServer((request, response) => {
    if (request.url === '/frame') {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(framePage);
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end(loginPage);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({
        origin: `http://127.0.0.1:${(address as { port: number }).port}`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

async function withLoginPage(
  run: (
    page: Awaited<
      ReturnType<Awaited<ReturnType<PlaywrightChromiumEngine['createSession']>>['newPage']>
    >
  ) => Promise<void>
) {
  const { origin, close } = await startServer();
  const engine = new PlaywrightChromiumEngine();
  try {
    const page = await (await engine.createSession({ headless: true })).newPage();
    await page.navigate({ url: `${origin}/login` });
    await run(page);
  } finally {
    await engine.close();
    await close();
  }
}

const refFor = (elements: Array<{ name?: string }>, name: string) =>
  elements.find((element) => element.name === name)?.ref;

/** Fill via a fresh observation: a successful action bumps the revision and
 * invalidates earlier refs, so each write re-observes first (as an operator
 * plan would). */
async function fillFresh(
  page: Parameters<NonNullable<Parameters<typeof withLoginPage>[0]>>[0],
  name: string,
  value: string,
  options: { sensitive?: boolean; expectValue?: string } = {}
) {
  const observed = await page.observe({});
  const entry = observed.elements.find((element) => element.name === name);
  if (!entry?.ref) throw new Error(`no ref for ${name}`);
  return page.act({
    type: 'fill',
    target: { ref: entry.ref },
    value,
    ...(options.sensitive !== undefined ? { sensitive: options.sensitive } : {}),
    ...(options.expectValue !== undefined ? { expectValue: options.expectValue } : {}),
  });
}

/** The whole observation — elements and all envelope fields — must stay canary-free. */
function assertNoCanary(observation: unknown) {
  expect(JSON.stringify(observation)).not.toContain(CANARY);
}

it('withholds native password values from default observations while preserving ordinary values', async () => {
  await withLoginPage(async (page) => {
    await fillFresh(page, 'Pass', CANARY);
    await fillFresh(page, 'Plain', 'ordinary@example.com');

    const second = await page.observe({});
    assertNoCanary(second);
    const pass = second.elements.find((element) => element.name === 'Pass');
    expect(pass).toBeDefined();
    expect(pass?.value).toBeUndefined();
    expect(pass?.valueRedacted).toBe(true);
    // Ordinary form evidence survives: bulk autofill verification depends on it.
    expect(second.elements.find((element) => element.name === 'Plain')?.value).toBe(
      'ordinary@example.com'
    );

    // Repeated observation (refStore/revision reuse) must not resurrect the value.
    const third = await page.observe({});
    assertNoCanary(third);
    expect(third.elements.find((element) => element.name === 'Pass')?.value).toBeUndefined();
  });
});

it('withholds password values under include:["formControls"]', async () => {
  await withLoginPage(async (page) => {
    await fillFresh(page, 'Pass', CANARY);
    await fillFresh(page, 'Plain', 'plain-value');
    const second = await page.observe({ include: ['formControls'] });
    assertNoCanary(second);
    expect(second.elements.find((element) => element.name === 'Pass')?.value).toBeUndefined();
    expect(second.elements.find((element) => element.name === 'Plain')?.value).toBe('plain-value');
  });
});

it('classifies credential autocomplete fields (password, OTP, payment) as sensitive', async () => {
  await withLoginPage(async (page) => {
    await fillFresh(page, 'NewPass', CANARY);
    await fillFresh(page, 'Code', CANARY);
    await fillFresh(page, 'Cvc', CANARY);
    const second = await page.observe({});
    assertNoCanary(second);
    for (const name of ['NewPass', 'Code', 'Cvc']) {
      const element = second.elements.find((candidate) => candidate.name === name);
      expect(element?.value).toBeUndefined();
      expect(element?.valueRedacted).toBe(true);
    }
    // The username field is ordinary evidence and stays visible.
    expect(second.elements.find((element) => element.name === 'User')?.valueRedacted).not.toBe(
      true
    );
  });
});

it('keeps explicitly marked hidden inputs redacted in native form evidence', async () => {
  const engine = new PlaywrightChromiumEngine();
  try {
    const page = await (await engine.createSession({ headless: true })).newPage();
    await page.navigate({
      url: 'data:text/html,<form action="." method="get"><input id="token" type="hidden" value="page-generated"><input id="marked" type="hidden"></form>',
    });
    const native = page.backingPage();
    // A hidden input cannot be observed or filled through refs; the mark path
    // is the attempted sensitive fill (the probe marks before the fill runs).
    // Mark it directly through the installed page policy to pin the
    // boundary: explicit marks override the hidden-token exception.
    await native.evaluate(() => {
      const marked = document.getElementById('marked');
      const policy = (
        globalThis as {
          __agentbrowserSensitivePolicy?: { mark(node: HTMLElement, explicit: boolean): boolean };
        }
      ).__agentbrowserSensitivePolicy;
      if (!policy || !marked) throw new Error('policy or node missing');
      policy.mark(marked, true);
      (marked as HTMLInputElement).value = 'SYNTH-HIDDEN-CANARY-9b1';
    });
    const evidence = await page.captureNativeForm();
    const control = evidence?.controls.find((entry) => entry.id === 'marked');
    expect(control?.valueRedacted).toBe(true);
    expect(control?.value).toBe('');
    expect(JSON.stringify(evidence)).not.toContain('SYNTH-HIDDEN-CANARY-9b1');
    // An unmarked hidden control keeps its page-generated token (witness
    // tamper evidence) — the documented exception.
    const unmarked = evidence?.controls.find((entry) => entry.id === 'token');
    expect(unmarked?.valueRedacted).toBe(false);
    expect(unmarked?.value).toBe('page-generated');
  } finally {
    await engine.close();
  }
});

it('honors explicit sensitive fills and survives show-password toggles', async () => {
  await withLoginPage(async (page) => {
    // Explicit sensitive fill into a plain text input.
    await fillFresh(page, 'Explicit', CANARY, { sensitive: true });
    // Password fill into a field whose type the page then toggles to text.
    await fillFresh(page, 'TogglePw', CANARY);
    const observed = await page.observe({});
    await page.act({ type: 'click', target: { ref: refFor(observed.elements, 'Toggle')! } });

    const second = await page.observe({});
    assertNoCanary(second);
    expect(second.elements.find((element) => element.name === 'Explicit')?.value).toBeUndefined();
    // After the toggle the input renders as a textbox with a plaintext DOM value.
    const toggled = second.elements.find((element) => element.name === 'TogglePw');
    expect(toggled?.value).toBeUndefined();
    expect(toggled?.valueRedacted).toBe(true);

    // And back to password type: still withheld on a later revision.
    await page.act({ type: 'click', target: { ref: refFor(second.elements, 'Toggle')! } });
    const third = await page.observe({});
    assertNoCanary(third);
  });
});

it('withholds frame-hosted password values while keeping frame text evidence', async () => {
  await withLoginPage(async (page) => {
    await fillFresh(page, 'FramePass', CANARY);
    await fillFresh(page, 'FramePlain', 'frame-ordinary');
    const second = await page.observe({});
    assertNoCanary(second);
    expect(second.elements.find((element) => element.name === 'FramePass')?.value).toBeUndefined();
    expect(second.elements.find((element) => element.name === 'FramePlain')?.value).toBe(
      'frame-ordinary'
    );
  });
});

it('keeps the canary out of action results, mismatch details and target fingerprints', async () => {
  await withLoginPage(async (page) => {
    // A sensitive mismatch must not echo expected/actual (existing contract)…
    const mismatch = await fillFresh(page, 'Pass', CANARY, {
      sensitive: true,
      expectValue: 'will-not-match',
    }).catch((error) => error);
    expect(mismatch).toMatchObject({ code: 'VALUE_MISMATCH' });
    expect(JSON.stringify(mismatch)).not.toContain(CANARY);

    // …and a later action on the ref must not carry the value out through the
    // semantic fingerprint channel either.
    await fillFresh(page, 'Pass', CANARY);
    const observed = await page.observe({});
    const passRef = refFor(observed.elements, 'Pass')!;
    const resolved = await page.resolve({ ref: passRef });
    expect(resolved.fingerprint).not.toContain(CANARY);
    const click = await page.act({
      type: 'click',
      target: { ref: refFor(observed.elements, 'Toggle')! },
    });
    const effects = Array.isArray(click) ? click : [click];
    for (const effect of effects) {
      const entry = effect as { targetFingerprint?: string };
      if (entry?.targetFingerprint) expect(entry.targetFingerprint).not.toContain(CANARY);
    }
  });
});

it('still verifies ordinary (non-sensitive) fills with expected and actual values', async () => {
  await withLoginPage(async (page) => {
    const ok = await fillFresh(page, 'Plain', 'abc', { expectValue: 'abc' });
    expect((ok as { result?: { verified?: boolean } }).result?.verified).toBe(true);
    const mismatch = await fillFresh(page, 'Plain', 'xyz', { expectValue: 'zzz' }).catch(
      (error) => error
    );
    // Ordinary fields keep diagnostic values: that is the bulk-fill contract.
    expect(JSON.stringify(mismatch)).toContain('zzz');
  });
});
