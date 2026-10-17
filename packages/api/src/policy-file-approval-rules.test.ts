/**
 * A policy file's approvalRules must classify actions. They used to be read only into the
 * document version: with AGENTBROWSER_POLICY_FILE set, no rule ever classified an action (the
 * environment approval policy is refused alongside a file), so a rule marking a control as a
 * transaction had no effect and the action stayed "unknown".
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPolicyFile } from '@agentbrowser/policy-engine';
import { FakeEngine } from '@agentbrowser/testkit';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { buildServer } from './server.js';

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'file-approval-rules-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const A = 'AgentBrowser::Action::';
const document = {
  version: 'agentbrowser-policy/v1',
  baseline: 'none',
  unknownRisk: 'allow',
  approvalRules: [
    {
      id: 'shop-place-order',
      hostname: 'shop.example.com',
      name: 'Place order',
      effect: 'transaction',
    },
  ],
  policies: [
    {
      key: 'operator.act.low-risk',
      ruleId: 'operator.act.low-risk',
      cedar: `@rule("operator.act.low-risk") permit(principal, action in [${A}"act", ${A}"act.unattended"], resource) when { ["read", "write-local", "unknown"].contains(context.effect) };`,
    },
    {
      key: 'operator.act.high-risk-attended',
      ruleId: 'operator.act.high-risk-attended',
      cedar: `@rule("operator.act.high-risk-attended") permit(principal, action == ${A}"act", resource) when { ["transaction"].contains(context.effect) };`,
    },
  ],
};

it('a policy file approval rule classifies the action it names', async () => {
  const path = join(dir, 'policy.json');
  await writeFile(path, JSON.stringify(document));
  const loaded = await loadPolicyFile(path, { apiKeysConfigured: false }, {});
  const engine = new FakeEngine();
  const server = await buildServer({
    engine,
    policy: {
      kind: 'file',
      authorizer: loaded.authorizer,
      version: loaded.authorizer.version,
      limits: loaded.limits,
      approval: { rules: loaded.document.approvalRules, unknownRisk: loaded.document.unknownRisk },
    },
  });
  try {
    const session = await server.inject({
      method: 'POST',
      url: '/v1/sessions',
      payload: { tenantId: 'local' },
    });
    const sessionId = session.json().sessionId as string;
    const page = await server.inject({ method: 'POST', url: `/v1/sessions/${sessionId}/pages` });
    const pageId = page.json().pageId as string;
    const base = `/v1/sessions/${sessionId}/pages/${pageId}`;
    await server.inject({
      method: 'POST',
      url: `${base}/navigate`,
      payload: { url: 'https://shop.example.com/cart' },
    });
    const raw = engine.getFakePage(engine.getSessionIds()[0] ?? '', pageId);
    raw?.setElements([
      { role: 'button', name: 'Place order' },
      { role: 'button', name: 'Continue shopping' },
    ]);
    const view = await server.inject({ method: 'POST', url: `${base}/observe`, payload: {} });
    const ref = (name: string) =>
      (view.json().elements as Array<{ name: string; ref: string }>).find((e) => e.name === name)
        ?.ref;

    const order = await server.inject({
      method: 'POST',
      url: `${base}/act`,
      payload: { action: 'click', target: { ref: ref('Place order') } },
    });
    expect(order.json().error).toMatchObject({ code: 'APPROVAL_REQUIRED' });

    const other = await server.inject({
      method: 'POST',
      url: `${base}/act`,
      payload: { action: 'click', target: { ref: ref('Continue shopping') } },
    });
    expect(other.statusCode, other.body).toBe(200);
  } finally {
    await server.close();
  }
});
