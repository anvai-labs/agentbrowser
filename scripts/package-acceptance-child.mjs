/** Isolated instrumented packaged-service host. Never imported by production code. */
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { resolvePackagedModules } from './package-acceptance.mjs';

const modules = await resolvePackagedModules(process.argv[2], process.argv[3], {
  expectedCommit: process.argv[4], allowDirty: process.argv[5] === 'allow-dirty',
});
const { buildServer } = await import(pathToFileURL(modules.api));
const { PlaywrightChromiumEngine } = await import(pathToFileURL(modules.engine));
const { NetworkPolicy } = await import(pathToFileURL(modules.policy));
const playwright = await import(pathToFileURL(modules.playwright));
const { errors } = playwright.default ?? playwright;
const engine = new PlaywrightChromiumEngine();
const pages = new Set();
const modes = new Map();
let prototype;
let original;
const createSession = engine.createSession.bind(engine);
engine.createSession = async (options) => {
  const session = await createSession(options);
  const newPage = session.newPage.bind(session);
  session.newPage = async (options) => {
    const page = await newPage(options);
    pages.add(page);
    const backing = page.backingPage();
    backing.once('close', () => { pages.delete(page); modes.delete(backing); });
    if (!prototype) {
      prototype = Object.getPrototypeOf(backing.locator('body'));
      original = prototype.ariaSnapshot;
      prototype.ariaSnapshot = async function (options) {
        const state = modes.get(this.page());
        const kind = this.toString() === this.page().locator('body').toString() ? 'body' : 'element';
        if (state) state.stats[`${kind}Calls`]++;
        if (state?.mode === 'all' || (state?.mode === 'elements' && kind === 'element')) {
          state.stats[`${kind}Failures`]++;
          throw new errors.TimeoutError('Injected packaged snapshot timeout');
        }
        const result = await original.call(this, options);
        if (state) state.stats[`${kind}Captures`]++;
        return result;
      };
    }
    return page;
  };
  return session;
};

const server = await buildServer({
  engine,
  networkPolicy: new NetworkPolicy({ blockLoopback: false, blockPrivateIPs: true, blockMetadata: true }),
});
const baseUrl = await server.listen({ port: 0, host: '127.0.0.1' });

async function operator(params) {
  assert.ok(['grant', 'takeover'].includes(params.action), 'Unknown operator action');
  const session = await engine.createSession({});
  try {
    const ui = (await session.newPage()).backingPage();
    await ui.goto(`${baseUrl}/operator`);
    await ui.getByLabel('Operator key', { exact: true }).fill(params.key);
    await ui.getByRole('button', { name: 'Connect', exact: true }).click();
    await ui.getByLabel('Session ID', { exact: true }).fill(params.sessionId);
    await ui.getByRole('button', { name: 'Attach', exact: true }).click();
    await ui.waitForFunction(() => /HUMAN_ACTIVE|AGENT_ACTIVE/.test(document.querySelector('#status')?.textContent ?? ''));
    if (params.action === 'takeover') {
      await ui.getByRole('button', { name: 'Take over', exact: true }).click();
      await ui.waitForFunction(() => document.querySelector('#status')?.textContent.includes('HUMAN_ACTIVE'));
      return true;
    }
    await ui.getByRole('button', { name: 'Prepare fresh review', exact: true }).click();
    await ui.getByRole('button', { name: 'Delegate reviewed state', exact: true }).click();
    await ui.waitForFunction(() => Boolean(document.querySelector('#grant')?.value));
    return await ui.locator('#grant').inputValue();
  } finally { await session.close(); }
}
let shuttingDown;
const shutdown = () => {
  shuttingDown ??= (async () => {
    if (prototype) prototype.ariaSnapshot = original;
    await server.close();
    assert.equal(pages.size, 0, 'Packaged browser pages remain after shutdown');
    if (process.connected) process.disconnect();
  })().catch((error) => { console.error(error.message); process.exitCode = 1; if (process.connected) process.disconnect(); });
  return shuttingDown;
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
process.on('disconnect', shutdown);
let queue = Promise.resolve();
const reply = (value) => {
  if (process.connected) process.send(value, (error) => {
    if (error && !shuttingDown) { console.error('Packaged child IPC failed'); process.exitCode = 1; void shutdown(); }
  });
};
process.on('message', ({ id, method, params }) => {
  queue = queue.then(async () => {
    try {
      assert.ok(!shuttingDown, 'Packaged child is shutting down');
      const candidates = [...pages].filter((page) => params.pageId.endsWith(`_${page.id}`));
      assert.equal(candidates.length, 1, 'Instrumented page must resolve uniquely');
      const backing = candidates[0].backingPage();
      let result;
      if (method === 'snapshotMode') {
        assert.ok(['normal', 'elements', 'all'].includes(params.mode));
        modes.set(backing, { mode: params.mode, stats: {
          bodyCalls: 0, bodyFailures: 0, bodyCaptures: 0,
          elementCalls: 0, elementFailures: 0, elementCaptures: 0,
        } }); result = true;
      } else if (method === 'snapshotStats') {
        result = modes.get(backing)?.stats;
      } else if (method === 'mutate') {
        await backing.evaluate(() => { document.querySelector('#choice').checked = true; }); result = true;
      } else if (method === 'unnamedButton') {
        await backing.evaluate(() => {
          const button = document.querySelector('button');
          button.textContent = ''; button.style.width = '40px'; button.style.height = '20px';
        }); result = true;
      } else if (method === 'operator') result = await operator(params);
      else if (method === 'humanEdit') {
        await backing.getByLabel('Note', { exact: true }).fill('human edit'); result = true;
      } else if (method === 'title') result = await backing.title();
      else throw new Error('Unknown instrumented child method');
      reply({ id, result });
    } catch (error) { reply({ id, error: error.message }); }
  });
});
reply({ kind: 'ready', baseUrl, modules });
