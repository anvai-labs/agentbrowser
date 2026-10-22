import { FakeEngine } from '@agentbrowser/testkit';
import { AgentBrowserService } from '../service.js';

/**
 * The focused service suites' shared setup (F2/F4 era): a live session + page on the
 * stub origin, one observed ref, and the FakeEngine page behind it. Pass an engine the
 * suite has already specialized (spies, elements); omit it for a plain FakeEngine.
 */
export async function setupObservedPage(engine = new FakeEngine()) {
  const service = new AgentBrowserService({ engine });
  const session = await service.createSession({ tenantId: 't1' });
  const pageId = (await service.createPage(session.sessionId)).pageId;
  await service.navigate(session.sessionId, pageId, { url: 'https://example.com/' });
  const observation = await service.observe(session.sessionId, pageId, { mode: 'interactive' });
  const ref = observation.elements[0]?.ref;
  if (!ref) throw new Error('no elements observed');
  const engineSessionId = engine.getSessionIds()[0];
  if (engineSessionId === undefined) throw new Error('no engine session');
  const fakePage = engine.getFakePage(engineSessionId, pageId);
  if (!fakePage) throw new Error('no fake page');
  return { engine, service, session, pageId, ref, fakePage };
}
