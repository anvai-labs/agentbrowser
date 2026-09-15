import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProfile, Browser, launch, WEBDRIVER_BIDI_WEBSOCKET_ENDPOINT_REGEX } from '@puppeteer/browsers';
import { connectBidiProbe } from './bidi-probe-connection.mjs';

export const SESSION_CANDIDATE = Object.freeze({ candidate: 'session-bidi-v1', driver: 'direct-bidi-probe-v1', browser: 'firefox/155.0.1' });

/** Standalone feasibility controller. No Puppeteer connection or production engine. */
export async function launchSessionEgressBrowser({ executablePath, target, deny, errors, intercepted }) {
  const profile = await mkdtemp(join(tmpdir(), 'agentbrowser-session-bidi-'));
  let process;
  let connection;
  let closed = false;
  const pending = new Set();
  const details = { scope: 'session', subscribeAcknowledged: false, interceptAcknowledged: false, fixtureContexts: 0, blockedEvents: 0, contextlessBlockedEvents: 0 };
  const close = async () => {
    if (closed) return; closed = true;
    try { if (process) await process.close(); }
    finally {
      connection?.close(); await Promise.allSettled([...pending]);
      await rm(profile, { recursive: true, force: true });
    }
  };
  try {
    await createProfile(Browser.FIREFOX, { path: profile, preferences: {} });
    process = launch({ executablePath, args: ['--headless', '--no-remote', '--profile', profile, '--remote-debugging-port=0', 'about:blank'] });
    const endpoint = await process.waitForLineOutput(WEBDRIVER_BIDI_WEBSOCKET_ENDPOINT_REGEX, 10_000);
    connection = await connectBidiProbe(new URL('/session', endpoint).href);
    const session = await connection.send('session.new', { capabilities: {} });
    connection.onEvent(event => {
      if (event.method !== 'network.beforeRequestSent' || !event.params.isBlocked) return;
      const { request, context } = event.params;
      details.blockedEvents++;
      if (context === null) details.contextlessBlockedEvents++;
      const url = new URL(request.url);
      // BiDi exposes WebSocket URLs as ws:, while some high-level drivers normalize them.
      const httpOrigin = url.origin.replace(/^ws:/, 'http:').replace(/^wss:/, 'https:');
      const block = deny && httpOrigin === target && url.pathname.startsWith('/target/');
      if (block) {
        const key = url.searchParams.get('run'); intercepted.set(key, (intercepted.get(key) ?? 0) + 1);
      }
      const command = connection.send(block ? 'network.failRequest' : 'network.continueRequest', { request: request.request });
      pending.add(command);
      command.then(() => pending.delete(command), error => {
        pending.delete(command); errors.push({ phase: 'session-interception', message: error.message });
        connection.close(error);
      });
    });
    await connection.send('session.subscribe', { events: ['network.beforeRequestSent'] });
    details.subscribeAcknowledged = true;
    // Omit contexts and URL patterns deliberately: this is the scope under test.
    await connection.send('network.addIntercept', { phases: ['beforeRequestSent'] });
    details.interceptAcknowledged = true;
    return {
      driver: SESSION_CANDIDATE.driver, details,
      version: async () => `${session.capabilities.browserName}/${session.capabilities.browserVersion}`,
      async newPage() {
        const { context } = await connection.send('browsingContext.create', { type: 'tab' });
        details.fixtureContexts++;
        return {
          goto: url => connection.send('browsingContext.navigate', { context, url, wait: 'complete' }),
          async evaluate(fn, argument) {
            // Only owned fixture functions and JSON data cross this diagnostic seam.
            const expression = `(${fn.toString()})(${JSON.stringify(argument) ?? 'undefined'})`;
            const result = await connection.send('script.evaluate', { expression, target: { context }, awaitPromise: true });
            if (result.type === 'exception') throw new Error(`Fixture evaluation: ${result.exceptionDetails.text}`);
            if (!['string', 'number', 'boolean', 'undefined', 'null'].includes(result.result.type)) throw new Error('Unsupported fixture result type');
            return result.result.type === 'null' ? null : result.result.value;
          },
          close: () => connection.send('browsingContext.close', { context }),
        };
      },
      close,
    };
  } catch (error) { await close(); throw error; }
}
