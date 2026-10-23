/**
 * T5 B-dur-2b over HTTP: the wrapper's handling of `executionRequirement` on act/plan/autofill.
 * 'ephemeral' is the default made explicit (peeled before the identity, so it replays an omitted
 * request); 'durable' needs a controlled session and an open journal, and is refused before any
 * effect otherwise; any other value is a 400.
 */
import { describe, expect, it } from 'vitest';
import {
  agentHeaders,
  bindAndDelegate,
  buildApplicationServer,
  operatorHeaders,
} from './test-support/application-counter-http.js';
import { journalTree } from './test-support/journal-fixture.js';

async function controlledPage() {
  const { server } = await buildApplicationServer();
  const { path, token } = await bindAndDelegate(server, 'qa');
  let next = 0;
  const headers = (id = `op-${++next}`) => ({
    ...agentHeaders(token),
    'x-agentbrowser-operation-id': id,
  });
  const page = await server.inject({ method: 'POST', url: `${path}/pages`, headers: headers() });
  const pagePath = `${path}/pages/${page.json().pageId}`;
  return { server, pagePath, headers };
}

describe('executionRequirement on browser routes (B-dur-2b)', () => {
  it('refuses a value other than ephemeral or durable with 400', async () => {
    const { server, pagePath, headers } = await controlledPage();
    try {
      const response = await server.inject({
        method: 'POST',
        url: `${pagePath}/act`,
        headers: headers(),
        payload: { action: 'scroll', direction: 'down', executionRequirement: 'eventually' },
      });
      expect(response.statusCode).toBe(400);
    } finally {
      await server.close();
    }
  });

  it('explicit ephemeral is the omitted request: same identity, so it replays', async () => {
    const { server, pagePath, headers } = await controlledPage();
    try {
      const body = { action: 'scroll', direction: 'down' };
      const first = await server.inject({
        method: 'POST',
        url: `${pagePath}/act`,
        headers: headers('same-op'),
        payload: body,
      });
      expect(first.statusCode, first.body).toBe(200);
      const explicit = await server.inject({
        method: 'POST',
        url: `${pagePath}/act`,
        headers: headers('same-op'),
        payload: { ...body, executionRequirement: 'ephemeral' },
      });
      expect(explicit.statusCode).toBe(200);
      expect(explicit.json()).toMatchObject({ replay: true });
    } finally {
      await server.close();
    }
  });

  it.each(['act', 'plan', 'autofill'] as const)(
    'durable %s without an open journal is refused before any effect',
    async (route) => {
      const { server, pagePath, headers } = await controlledPage();
      try {
        const payload =
          route === 'act'
            ? { action: 'scroll', direction: 'down', executionRequirement: 'durable' }
            : route === 'plan'
              ? {
                  actions: [{ action: 'scroll', direction: 'down' }],
                  executionRequirement: 'durable',
                }
              : {
                  fields: [{ match: { label: 'Company' }, value: 'Acme' }],
                  executionRequirement: 'durable',
                };
        const response = await server.inject({
          method: 'POST',
          url: `${pagePath}/${route}`,
          headers: headers(),
          payload,
        });
        expect(response.statusCode).toBeGreaterThanOrEqual(400);
        expect(response.json().error.code).toBe('CONTROL_REQUIRED');
      } finally {
        await server.close();
      }
    }
  );

  it.each(['navigate', 'observe'])(
    'refuses executionRequirement on %s, which cannot journal (no silent fallback)',
    async (route) => {
      const { server, pagePath, headers } = await controlledPage();
      try {
        const response = await server.inject({
          method: 'POST',
          url: `${pagePath}/${route}`,
          headers: headers(),
          payload: {
            ...(route === 'navigate' ? { url: 'https://example.com/elsewhere' } : {}),
            executionRequirement: 'durable',
          },
        });
        expect(response.statusCode).toBe(400);
        expect(response.json().error.code).toBe('INVALID_REQUEST');
      } finally {
        await server.close();
      }
    }
  );

  it('durable on an uncontrolled session is refused (it needs an operation scope)', async () => {
    const { server } = await buildApplicationServer();
    try {
      const session = await server.inject({
        method: 'POST',
        url: '/v1/sessions',
        headers: operatorHeaders,
        payload: {},
      });
      const path = `/v1/sessions/${session.json().sessionId}`;
      const page = await server.inject({
        method: 'POST',
        url: `${path}/pages`,
        headers: operatorHeaders,
      });
      const response = await server.inject({
        method: 'POST',
        url: `${path}/pages/${page.json().pageId}/act`,
        headers: operatorHeaders,
        payload: { action: 'scroll', direction: 'down', executionRequirement: 'durable' },
      });
      expect(response.json().error).toMatchObject({
        code: 'CONTROL_REQUIRED',
        message: expect.stringMatching(/controlled session/),
      });
    } finally {
      await server.close();
    }
  });
});

describe('durable act end to end, with a real journal (B-dur-2b)', () => {
  it('journals the act and the lookup route shows it as a browser/act record', async () => {
    const { restore } = await journaledEnv('bdur2b-http-', '4c');
    let close: (() => Promise<void>) | undefined;
    try {
      const { server, pagePath, headers } = await controlledPage();
      close = () => server.close();
      const response = await server.inject({
        method: 'POST',
        url: `${pagePath}/act`,
        headers: headers('durable-scroll'),
        payload: { action: 'scroll', direction: 'down', executionRequirement: 'durable' },
      });
      expect(response.statusCode, response.body).toBe(200);
      const lookup = await server.inject({
        method: 'GET',
        url: '/v1/journal/operations/durable-scroll',
        headers: operatorHeaders,
      });
      expect(lookup.statusCode, lookup.body).toBe(200);
      expect(lookup.json()).toMatchObject({
        absent: false,
        records: [
          {
            classification: 'completed',
            application: { adapter: 'browser', resource: 'act' },
          },
        ],
      });
    } finally {
      await close?.();
      await restore();
    }
  }, 60_000);
});

describe('durable terminal mapping over HTTP, with a real journal (B-dur-2b)', () => {
  it('a plan step that lost its result is settled unknown; a known step refusal is failed_before_dispatch; both keep the report', async () => {
    const t = await journaledServer();
    try {
      const act = t.raw.act.bind(t.raw);
      let calls = 0;
      t.raw.act = async (action) => {
        calls += 1;
        if (calls === 2) throw new Error('engine transport closed');
        return act(action);
      };
      const plan = (id: string, actions: unknown[]) =>
        t.server.inject({
          method: 'POST',
          url: `${t.pagePath}/plan`,
          headers: t.headers(id),
          payload: { actions, executionRequirement: 'durable' },
        });
      const scroll = { action: 'scroll', direction: 'down' };
      const lost = await plan('plan-lost', [scroll, scroll]);
      expect(lost.statusCode, lost.body).toBe(200);
      expect(lost.json()).toMatchObject({ ok: false, completed: 1 });
      const known = await plan('plan-known', [{ action: 'click', target: { ref: 'e999_7' } }]);
      expect(known.statusCode, known.body).toBe(200);
      expect(known.json()).toMatchObject({ ok: false, completed: 0 });
      expect(await t.classification('plan-lost')).toBe('settled_unknown');
      expect(await t.classification('plan-known')).toBe('failed_before_dispatch');
    } finally {
      await t.close();
    }
  }, 60_000);
});

/** A private journal layout + environment swap shared by the durable suites (a fresh
 * tagged directory, key file, and the JOURNAL_* env). `restore` unsets the env and
 * removes the directory — it belongs in the caller's finally. */
async function journaledEnv(tag: string, keyHex: string) {
  const tree = journalTree(tag, keyHex);
  const saved = Object.fromEntries(Object.keys(tree.env).map((name) => [name, process.env[name]]));
  Object.assign(process.env, tree.env);
  const restore = async () => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    tree.dispose();
  };
  return { restore };
}

/** A delegated `qa` session on a server whose engine the test holds, with a real journal. */
async function journaledServer() {
  const { createHash } = await import('node:crypto');
  const { FakeEngine } = await import('@agentbrowser/testkit');
  const { buildServer } = await import('./server.js');
  const { restore } = await journaledEnv('bdur2b-known-', '6e');
  const engine = new FakeEngine();
  const server = await buildServer({
    engine,
    apiKeys: new Map([[createHash('sha256').update('owner').digest('hex'), 'owner']]),
  });
  const close = async () => {
    await server.close();
    await restore();
  };
  const create = await server.inject({
    method: 'POST',
    url: '/v1/sessions',
    headers: operatorHeaders,
    payload: { controlMode: 'delegated' },
  });
  const path = `/v1/sessions/${create.json().sessionId}`;
  const review = await server.inject({
    method: 'POST',
    url: `${path}/control/prepare-resume`,
    headers: operatorHeaders,
  });
  const grant = await server.inject({
    method: 'POST',
    url: `${path}/control/delegate`,
    headers: operatorHeaders,
    payload: { epoch: review.json().epoch, mode: 'qa' },
  });
  const headers = (id: string) => ({
    ...agentHeaders(grant.json().token as string),
    'x-agentbrowser-operation-id': id,
  });
  const page = await server.inject({
    method: 'POST',
    url: `${path}/pages`,
    headers: headers('pg'),
  });
  const pageId = page.json().pageId as string;
  const raw = engine.getFakePage(engine.getSessionIds()[0] ?? '', pageId);
  if (!raw) throw new Error('expected an engine page');
  const pagePath = `${path}/pages/${pageId}`;
  const observeRef = async (name: string) => {
    const view = await server.inject({
      method: 'POST',
      url: `${pagePath}/observe`,
      headers: headers(`observe-${name}-${Math.random()}`),
      payload: {},
    });
    return (view.json().elements as Array<{ name: string; ref: string }>).find(
      (element) => element.name === name
    )?.ref as string;
  };
  const classification = async (id: string) =>
    (
      await server.inject({
        method: 'GET',
        url: `/v1/journal/operations/${id}`,
        headers: operatorHeaders,
      })
    ).json().records?.[0]?.classification;
  return { server, raw, pagePath, headers, observeRef, classification, close };
}

describe('known versus unknown failures after the effect (B-dur-2b review)', () => {
  it('an unverified fill (the fill may have completed) is settled unknown, not failed', async () => {
    const t = await journaledServer();
    try {
      t.raw.setElements([{ role: 'textbox', name: 'Company' }]);
      const ref = await t.observeRef('Company');
      const act = t.raw.act.bind(t.raw);
      let effects = 0;
      t.raw.act = async (action) => {
        effects += 1;
        const result = await act(action);
        return { ...result, result: undefined };
      };
      const response = await t.server.inject({
        method: 'POST',
        url: `${t.pagePath}/act`,
        headers: t.headers('fill-unverified'),
        payload: {
          action: 'fill',
          target: { ref },
          value: 'Acme',
          expectValue: 'Acme',
          executionRequirement: 'durable',
        },
      });
      expect(response.json().error.code, response.body).toBe('ENGINE_UNSUPPORTED');
      expect(effects).toBe(1);
      expect(await t.classification('fill-unverified')).toBe('settled_unknown');
    } finally {
      await t.close();
    }
  }, 60_000);

  it('an engine failure after dispatch (lost result) is settled unknown over HTTP', async () => {
    const t = await journaledServer();
    try {
      t.raw.act = async () => {
        throw new Error('engine transport closed');
      };
      const response = await t.server.inject({
        method: 'POST',
        url: `${t.pagePath}/act`,
        headers: t.headers('act-lost'),
        payload: { action: 'scroll', direction: 'down', executionRequirement: 'durable' },
      });
      expect(response.statusCode).toBeGreaterThanOrEqual(400);
      expect(await t.classification('act-lost')).toBe('settled_unknown');
    } finally {
      await t.close();
    }
  }, 60_000);

  it.each(['act', 'plan'] as const)(
    'a durable %s whose click closed the page (the follow-up read fails) is settled unknown',
    async (route) => {
      const t = await journaledServer();
      try {
        t.raw.setElements([{ role: 'button', name: 'Close' }]);
        const ref = await t.observeRef('Close');
        const act = t.raw.act.bind(t.raw);
        const observe = t.raw.observe.bind(t.raw);
        let clicked = 0;
        t.raw.act = async (action) => {
          clicked += 1;
          return act(action);
        };
        t.raw.observe = async (request) => {
          if (clicked > 0)
            throw Object.assign(new Error('Page is closed'), { code: 'PAGE_NOT_FOUND' });
          return observe(request);
        };
        const step = { action: 'click', target: { ref }, observe: 'after' };
        const response = await t.server.inject({
          method: 'POST',
          url: `${t.pagePath}/${route}`,
          headers: t.headers(`closed-${route}`),
          payload:
            route === 'act'
              ? { ...step, executionRequirement: 'durable' }
              : { actions: [step], executionRequirement: 'durable' },
        });
        expect(clicked).toBe(1);
        if (route === 'plan') expect(response.json()).toMatchObject({ ok: false });
        else expect(response.statusCode).toBeGreaterThanOrEqual(400);
        expect(await t.classification(`closed-${route}`)).toBe('settled_unknown');
      } finally {
        await t.close();
      }
    },
    60_000
  );

  it('an act batch whose end-of-batch observation fails after its steps is settled unknown', async () => {
    const t = await journaledServer();
    try {
      const act = t.raw.act.bind(t.raw);
      const observe = t.raw.observe.bind(t.raw);
      let effects = 0;
      t.raw.act = async (action) => {
        effects += 1;
        return act(action);
      };
      t.raw.observe = async (request) => {
        if (effects > 0)
          throw Object.assign(new Error('Page is closed'), { code: 'PAGE_NOT_FOUND' });
        return observe(request);
      };
      const response = await t.server.inject({
        method: 'POST',
        url: `${t.pagePath}/act`,
        headers: t.headers('batch-closed'),
        payload: {
          steps: [{ action: 'scroll', direction: 'down' }],
          observe: 'after',
          executionRequirement: 'durable',
        },
      });
      expect(effects).toBe(1);
      expect(response.statusCode).toBeGreaterThanOrEqual(400);
      expect(await t.classification('batch-closed')).toBe('settled_unknown');
    } finally {
      await t.close();
    }
  }, 60_000);
});
