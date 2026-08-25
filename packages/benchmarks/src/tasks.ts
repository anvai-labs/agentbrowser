/**
 * Deterministic agent task benchmark (TD-025, MVP gate: >= 45/50)
 *
 * Fifty scripted agent interactions across ten categories from the MVP spec
 * (section 18.2): extraction, multi-step navigation, fill-without-submit,
 * stale-element recovery, pagination, approval boundaries, diffs, secret
 * handling, typed error paths, and lifecycle. Every task drives the real
 * service through its public API with element refs - never selectors - and
 * is scored on exact outcome, action count and observation bytes.
 */

import { AgentBrowserService, ServiceError } from '@agentbrowser/api';
import { SecretManager } from '@agentbrowser/core';
import { FakeEngine } from '@agentbrowser/testkit';
import type { FakeEngine as FakeEngineType } from '@agentbrowser/testkit';

export interface TaskOutcome {
  name: string;
  category: string;
  pass: boolean;
  actions: number;
  observationBytes: number;
  error?: string;
}

export interface TaskContext {
  service: AgentBrowserService;
  engine: FakeEngineType;
  sessionId: string;
  pageId: string;
  /** Fail the task with a reason. */
  fail: (reason: string) => Error;
  /** Expect a service call to reject with the given code. */
  expectRejection: (code: string, run: () => Promise<unknown>) => Promise<void>;
  /** Count an agent action. */
  count: () => void;
  /** Accumulate observation payload size. */
  observeBytes: (payload: unknown) => number;
}

export interface TaskDefinition {
  name: string;
  category: string;
  /** Set up the page fixture before the task runs. */
  setup?: (engine: FakeEngineType, pageId: string) => void;
  run: (context: TaskContext) => Promise<void>;
}

/** Deterministic fixture: a page of labelled interactive elements. */
function labelFixture(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    role: i % 2 === 0 ? 'button' : 'textbox',
    name: `Field ${i + 1}`,
    value: i % 2 === 0 ? '' : `value-${i + 1}`,
  }));
}

/** The engine page backing a service page id (single-session helpers). */
function enginePageOf(engine: FakeEngineType, pageId: string) {
  const ids = engine.getSessionIds();
  const sessionId = ids[ids.length - 1];
  if (sessionId === undefined) {
    throw new Error('no engine session');
  }
  const page = engine.getFakePage(sessionId, pageId);
  if (!page) {
    throw new Error(`no engine page for ${pageId}`);
  }
  return page;
}

/** Capture a ServiceError code, or fail the task with what actually happened. */
async function captureCode(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    return 'NO_ERROR';
  } catch (error) {
    if (error instanceof ServiceError) {
      return error.code;
    }
    return error instanceof Error ? error.message : String(error);
  }
}

// ---------------------------------------------------------------------------
// Task definitions: ten categories, five tasks each.
// ---------------------------------------------------------------------------

export const TASKS: TaskDefinition[] = [
  // ---- extraction ----------------------------------------------------------
  ...[1, 2, 3, 4, 5].map(
    (i): TaskDefinition => ({
      name: `extract-value-${i}`,
      category: 'extraction',
      setup: (engine, pageId) => {
        enginePageOf(engine, pageId).setElements(labelFixture(12));
      },
      run: async (ctx) => {
        const observation = await ctx.service.observe(ctx.sessionId, ctx.pageId, {});
        ctx.observeBytes(observation);
        ctx.count();
        const target = observation.elements.find(
          (el) => el.role === 'textbox' && el.name === `Field ${2 * i}`
        );
        if (!target || target.value !== `value-${2 * i}`) {
          throw ctx.fail(`expected Field ${2 * i} with its value`);
        }
      },
    })
  ),

  // ---- multi-step navigation ----------------------------------------------
  ...[1, 2, 3, 4, 5].map(
    (i): TaskDefinition => ({
      name: `multi-step-${i}`,
      category: 'navigation',
      run: async (ctx) => {
        for (let step = 1; step <= i + 1; step++) {
          const url = `https://flow${step}.example.com`;
          const result = await ctx.service.navigate(ctx.sessionId, ctx.pageId, { url });
          ctx.count();
          if (result.url !== url) {
            throw ctx.fail(`navigation landed on ${result.url}`);
          }
          const observation = await ctx.service.observe(ctx.sessionId, ctx.pageId, {});
          ctx.observeBytes(observation);
          if (observation.url !== url) {
            throw ctx.fail(`observation shows ${observation.url}`);
          }
        }
      },
    })
  ),

  // ---- fill without submit -------------------------------------------------
  ...[1, 2, 3, 4, 5].map(
    (i): TaskDefinition => ({
      name: `fill-no-submit-${i}`,
      category: 'forms',
      setup: (engine, pageId) => {
        enginePageOf(engine, pageId).setElements(labelFixture(6));
      },
      run: async (ctx) => {
        const before = await ctx.service.observe(ctx.sessionId, ctx.pageId, {});
        ctx.observeBytes(before);
        const field = before.elements.find((el) => el.role === 'textbox');
        if (!field) {
          throw ctx.fail('no textbox to fill');
        }

        const result = await ctx.service.act(ctx.sessionId, ctx.pageId, {
          action: 'fill',
          target: { ref: field.ref },
          value: `entry-${i}`,
        });
        ctx.count();
        if (result.status !== 'success') {
          throw ctx.fail('fill did not succeed');
        }

        const after = await ctx.service.observe(ctx.sessionId, ctx.pageId, {});
        ctx.observeBytes(after);
        // Refs are revision-scoped: locate the same field semantically.
        const filled = after.elements.find(
          (el) => el.role === field.role && el.name === field.name
        );
        if (filled?.value !== `entry-${i}`) {
          throw ctx.fail(`value not persisted: ${String(filled?.value)}`);
        }
      },
    })
  ),

  // ---- stale element recovery ---------------------------------------------
  ...[1, 2, 3, 4, 5].map(
    (i): TaskDefinition => ({
      name: `stale-recovery-${i}`,
      category: 'staleness',
      run: async (ctx) => {
        const first = await ctx.service.observe(ctx.sessionId, ctx.pageId, {});
        ctx.observeBytes(first);
        const ref = first.elements[0]?.ref;
        if (!ref) {
          throw ctx.fail('nothing observed');
        }

        // An out-of-band mutation invalidates the ref.
        await ctx.service.act(ctx.sessionId, ctx.pageId, { action: 'press', key: 'Enter' });
        ctx.count();

        const code = await captureCode(() =>
          ctx.service.act(ctx.sessionId, ctx.pageId, { action: 'click', target: { ref } })
        );
        ctx.count();
        if (code !== 'STALE_TARGET') {
          throw ctx.fail(`expected STALE_TARGET, got ${code}`);
        }

        // Correct recovery: re-observe, act on the fresh ref.
        const fresh = await ctx.service.observe(ctx.sessionId, ctx.pageId, {});
        ctx.observeBytes(fresh);
        const retry = await ctx.service.act(ctx.sessionId, ctx.pageId, {
          action: 'click',
          target: { ref: fresh.elements[0]?.ref ?? ref },
        });
        ctx.count();
        if (retry.status !== 'success') {
          throw ctx.fail('retry on the fresh ref did not succeed');
        }
      },
    })
  ),

  // ---- pagination ----------------------------------------------------------
  ...[1, 2, 3, 4, 5].map(
    (i): TaskDefinition => ({
      name: `pagination-${i}`,
      category: 'pagination',
      setup: (engine, pageId) => {
        enginePageOf(engine, pageId).setElements(labelFixture(4 + i * 2));
      },
      run: async (ctx) => {
        const pageSize = 2;
        const seen: string[] = [];
        let cursor: number | undefined;

        for (;;) {
          const page = await ctx.service.observe(ctx.sessionId, ctx.pageId, {
            maxElements: pageSize,
            ...(cursor !== undefined ? { continueFrom: cursor } : {}),
          });
          ctx.observeBytes(page);
          ctx.count();
          for (const element of page.elements) {
            if (seen.includes(element.ref)) {
              throw ctx.fail(`element ${element.ref} appeared twice`);
            }
            seen.push(element.ref);
          }
          if (!page.continuation) {
            break;
          }
          cursor = page.continuation.nextOrdinal;
        }

        if (seen.length !== 4 + i * 2) {
          throw ctx.fail(`paginated ${seen.length} elements, expected ${4 + i * 2}`);
        }
      },
    })
  ),

  // ---- approval boundaries --------------------------------------------------
  ...[1, 2, 3, 4, 5].map(
    (i): TaskDefinition => ({
      name: `approval-boundary-${i}`,
      category: 'approval',
      setup: (engine, pageId) => {
        enginePageOf(engine, pageId).setElements([
          { role: 'button', name: `Pay ${i}`, risk: 'transaction' },
        ]);
      },
      run: async (ctx) => {
        const observation = await ctx.service.observe(ctx.sessionId, ctx.pageId, {});
        ctx.observeBytes(observation);
        const ref = observation.elements[0]?.ref;
        if (!ref) {
          throw ctx.fail('nothing observed');
        }

        const denialCode = await captureCode(() =>
          ctx.service.act(ctx.sessionId, ctx.pageId, { action: 'click', target: { ref } })
        );
        ctx.count();
        if (denialCode !== 'APPROVAL_REQUIRED') {
          throw ctx.fail(`expected APPROVAL_REQUIRED, got ${denialCode}`);
        }

        // Redeem the token: find it via a fresh denial's details.
        let tokenId: string | undefined;
        try {
          await ctx.service.act(ctx.sessionId, ctx.pageId, { action: 'click', target: { ref } });
        } catch (error) {
          tokenId = (error as ServiceError).details?.tokenId as string | undefined;
        }
        if (tokenId === undefined) {
          throw ctx.fail('no approval token issued');
        }

        const approved = await ctx.service.act(ctx.sessionId, ctx.pageId, {
          action: 'click',
          target: { ref },
          approvalToken: tokenId,
        });
        ctx.count();
        if (approved.status !== 'success') {
          throw ctx.fail('approved action did not succeed');
        }
      },
    })
  ),

  // ---- observation diffs -----------------------------------------------------
  ...[1, 2, 3, 4, 5].map(
    (i): TaskDefinition => ({
      name: `diff-${i}`,
      category: 'diffs',
      setup: (engine, pageId) => {
        enginePageOf(engine, pageId).setElements(labelFixture(5));
      },
      run: async (ctx) => {
        const before = await ctx.service.observe(ctx.sessionId, ctx.pageId, {});
        ctx.observeBytes(before);
        const field = before.elements.find((el) => el.role === 'textbox');
        if (!field) {
          throw ctx.fail('no textbox');
        }

        await ctx.service.act(ctx.sessionId, ctx.pageId, {
          action: 'fill',
          target: { ref: field.ref },
          value: `changed-${i}`,
        });
        ctx.count();

        const diff = await ctx.service.observe(ctx.sessionId, ctx.pageId, {
          sinceRevision: before.revision,
        });
        ctx.observeBytes(diff);
        ctx.count();
        const modified = diff.changes?.find((change) => change.change === 'modified');
        if (!modified) {
          throw ctx.fail('no modified change in the diff');
        }
        if ((modified.properties.value as { new: unknown } | undefined)?.new !== `changed-${i}`) {
          throw ctx.fail('diff did not carry the new value');
        }
      },
    })
  ),

  // ---- secret handling -------------------------------------------------------
  ...[1, 2, 3, 4, 5].map(
    (i): TaskDefinition => ({
      name: `secret-redaction-${i}`,
      category: 'secrets',
      setup: (engine, pageId) => {
        enginePageOf(engine, pageId).setElements(labelFixture(5));
      },
      run: async (ctx) => {
        const reference = `vault://bench/secret-${i}`;
        const value = `bench-secret-value-${i}`;
        const service = new AgentBrowserService({
          engine: ctx.engine,
          secretManager: new SecretManager({ [reference]: value }),
        });
        const sessionId = (await service.createSession({ tenantId: 'bench' })).sessionId;
        const pageId = (await service.createPage(sessionId)).pageId;
        await service.navigate(sessionId, pageId, { url: 'https://login.example.com' });
        enginePageOf(ctx.engine, pageId).setElements(labelFixture(5));

        const observation = await service.observe(sessionId, pageId, {});
        ctx.observeBytes(observation);
        const field = observation.elements.find((el) => el.role === 'textbox');
        if (!field) {
          throw ctx.fail('no textbox');
        }

        await service.act(sessionId, pageId, {
          action: 'fill',
          target: { ref: field.ref },
          value: reference,
        });
        ctx.count();

        const after = await service.observe(sessionId, pageId, {});
        ctx.observeBytes(after);
        const serialized = JSON.stringify(after);
        if (serialized.includes(value)) {
          throw ctx.fail('secret value leaked into the observation');
        }
        // Refs are revision-scoped: locate the same field semantically.
        const filled = after.elements.find(
          (el) => el.role === field.role && el.name === field.name
        );
        if (filled?.value !== '***') {
          throw ctx.fail(`expected ***, got ${String(filled?.value)}`);
        }
        await service.closeSession(sessionId);
      },
    })
  ),

  // ---- typed error paths ------------------------------------------------------
  ...[
    {
      name: 'error-selector-ref',
      expect: async (ctx: TaskContext) =>
        ctx.expectRejection('INVALID_REQUEST', () =>
          ctx.service.act(ctx.sessionId, ctx.pageId, {
            action: 'click',
            target: { ref: 'button.submit' },
          })
        ),
    },
    {
      name: 'error-unknown-page',
      expect: async (ctx: TaskContext) =>
        ctx.expectRejection('NOT_FOUND', () =>
          ctx.service.observe(ctx.sessionId, 'pg_missing', {})
        ),
    },
    {
      name: 'error-unknown-session',
      expect: async (ctx: TaskContext) =>
        ctx.expectRejection('SESSION_NOT_FOUND', () => ctx.service.closeSession('ses_missing')),
    },
    {
      name: 'error-malformed-url',
      expect: async (ctx: TaskContext) =>
        ctx.expectRejection('INVALID_REQUEST', () =>
          ctx.service.navigate(ctx.sessionId, ctx.pageId, { url: 'not-a-url' })
        ),
    },
    {
      name: 'error-file-scheme',
      expect: async (ctx: TaskContext) =>
        ctx.expectRejection('POLICY_DENIED', () =>
          ctx.service.navigate(ctx.sessionId, ctx.pageId, { url: 'file:///etc/passwd' })
        ),
    },
  ].map(
    (spec): TaskDefinition => ({
      name: spec.name,
      category: 'errors',
      run: async (ctx) => {
        await spec.expect(ctx);
        ctx.count();
      },
    })
  ),

  // ---- lifecycle ----------------------------------------------------------------
  ...[1, 2, 3, 4, 5].map(
    (i): TaskDefinition => ({
      name: `lifecycle-${i}`,
      category: 'lifecycle',
      run: async (ctx) => {
        const service = new AgentBrowserService({ engine: ctx.engine });
        const sessionId = (await service.createSession({ tenantId: 'bench' })).sessionId;
        ctx.count();
        const pageId = (await service.createPage(sessionId)).pageId;
        ctx.count();
        await service.navigate(sessionId, pageId, { url: `https://cycle${i}.example.com` });
        ctx.count();
        const observation = await service.observe(sessionId, pageId, {});
        ctx.observeBytes(observation);
        await service.closePage(sessionId, pageId);
        ctx.count();
        await service.closeSession(sessionId);
        ctx.count();
        if (service.getSession(sessionId) !== undefined) {
          throw ctx.fail('session survived close');
        }
        await service.shutdown();
      },
    })
  ),
];

/** Run every task against a fresh, deterministic environment. */
export async function runTasks(options: { tasks?: TaskDefinition[] } = {}): Promise<TaskOutcome[]> {
  const tasks = options.tasks ?? TASKS;
  const outcomes: TaskOutcome[] = [];

  for (const task of tasks) {
    const engine = new FakeEngine();
    const service = new AgentBrowserService({ engine });
    let actions = 0;
    let observationBytes = 0;

    try {
      const sessionId = (await service.createSession({ tenantId: 'bench' })).sessionId;
      const pageId = (await service.createPage(sessionId)).pageId;
      await service.navigate(sessionId, pageId, { url: 'https://bench.example.com' });
      task.setup?.(engine, pageId);

      const context: TaskContext = {
        service,
        engine,
        sessionId,
        pageId,
        fail: (reason: string) => new Error(reason),
        expectRejection: async (code, run) => {
          const actual = await captureCode(run);
          if (actual !== code) {
            throw new Error(`expected ${code}, got ${actual}`);
          }
        },
        count: () => {
          actions += 1;
        },
        observeBytes: (payload: unknown) => {
          const bytes = JSON.stringify(payload).length;
          observationBytes += bytes;
          return bytes;
        },
      };

      await task.run(context);
      outcomes.push({
        name: task.name,
        category: task.category,
        pass: true,
        actions,
        observationBytes,
      });
    } catch (error) {
      outcomes.push({
        name: task.name,
        category: task.category,
        pass: false,
        actions,
        observationBytes,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      await service.shutdown().catch(() => {});
    }
  }

  return outcomes;
}

/** MVP gate: >= 45 of 50 tasks must succeed. */
export const TASK_GATE = 45;

/** Render the task benchmark report. */
export function taskReport(outcomes: TaskOutcome[]): string {
  const passed = outcomes.filter((o) => o.pass).length;
  const lines: string[] = [];

  const categories = [...new Set(outcomes.map((o) => o.category))];
  for (const category of categories) {
    const inCategory = outcomes.filter((o) => o.category === category);
    const ok = inCategory.filter((o) => o.pass).length;
    lines.push(`${ok}/${inCategory.length} ${category}`);
  }

  lines.push('');
  for (const failure of outcomes.filter((o) => !o.pass)) {
    lines.push(`FAIL ${failure.name} - ${failure.error}`);
  }

  const totalActions = outcomes.reduce((sum, o) => sum + o.actions, 0);
  const totalBytes = outcomes.reduce((sum, o) => sum + o.observationBytes, 0);
  lines.push('');
  lines.push(`${passed}/${outcomes.length} tasks succeeded (gate: >= ${TASK_GATE})`);
  lines.push(`${totalActions} actions, ${totalBytes} observation bytes total`);
  return lines.join('\n');
}
