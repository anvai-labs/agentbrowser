/**
 * TDD Tests for the deterministic task benchmark (TD-025)
 *
 * Beyond the end-to-end gate runs, the failure boundaries inside each task
 * implementation are driven directly: tasks are invoked through the public
 * TaskContext API with stub services or tweaked fake engines, so every
 * ctx.fail guard fires and asserts its exact reason.
 */

import { type AgentBrowserService, ServiceError } from '@agentbrowser/api';
import type { ServiceSessionView } from '@agentbrowser/api';
import type {
  EnginePage,
  EngineSession,
  EngineSessionOptions,
  RawPageState,
} from '@agentbrowser/engine';
import { FakeEngine } from '@agentbrowser/testkit';
import type { FakeEngine as FakeEngineType } from '@agentbrowser/testkit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TASKS, TASK_GATE, runTasks, taskReport } from './tasks';
import type { TaskContext, TaskDefinition } from './tasks';

// ---------------------------------------------------------------------------
// Sabotage switches (passthrough module mocks - inert while false)
// ---------------------------------------------------------------------------

const sabotage = vi.hoisted(() => ({
  /** When set, closed sessions still show up in getSession (lifecycle ghost). */
  sessionSurvivesClose: false,
  /** When set, secret values are NOT redacted from service output. */
  redactionDisabled: false,
}));

vi.mock('@agentbrowser/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agentbrowser/api')>();
  class SabotageableService extends actual.AgentBrowserService {
    override getSession(sessionId: string): ServiceSessionView | undefined {
      if (sabotage.sessionSurvivesClose) {
        return (
          super.getSession(sessionId) ?? {
            sessionId,
            status: 'closed',
            engine: { name: 'fake-engine', version: '1.0.0' },
            createdAt: new Date(0).toISOString(),
            ttlMs: 0,
            idleTimeoutMs: 0,
            pages: 1,
          }
        );
      }
      return super.getSession(sessionId);
    }
  }
  return { ...actual, AgentBrowserService: SabotageableService };
});

vi.mock('@agentbrowser/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agentbrowser/core')>();
  class UnredactingSecretManager extends actual.SecretManager {
    override redact<T>(input: T): T {
      return sabotage.redactionDisabled ? input : super.redact(input);
    }
  }
  return { ...actual, SecretManager: UnredactingSecretManager };
});

describe('task suite definition', () => {
  it('should define exactly 50 tasks', () => {
    expect(TASKS).toHaveLength(50);
  });

  it('should cover all ten spec categories with five tasks each', () => {
    const byCategory = new Map<string, number>();
    for (const task of TASKS) {
      byCategory.set(task.category, (byCategory.get(task.category) ?? 0) + 1);
    }
    expect([...byCategory.entries()].sort()).toEqual([
      ['approval', 5],
      ['diffs', 5],
      ['errors', 5],
      ['extraction', 5],
      ['forms', 5],
      ['lifecycle', 5],
      ['navigation', 5],
      ['pagination', 5],
      ['secrets', 5],
      ['staleness', 5],
    ]);
  });

  it('should have unique task names', () => {
    const names = TASKS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('task execution', () => {
  it('should pass the MVP gate (>= 45/50) against the deterministic engine', async () => {
    const outcomes = await runTasks();
    const passed = outcomes.filter((o) => o.pass).length;

    expect(passed).toBeGreaterThanOrEqual(TASK_GATE);
    expect(passed).toBe(outcomes.length); // determinism: all 50 must pass
  });

  it('should report failures with reasons', async () => {
    const outcomes = await runTasks({
      tasks: [
        {
          name: 'sabotaged',
          category: 'test',
          run: async (ctx) => {
            throw ctx.fail('sabotaged on purpose');
          },
        },
      ],
    });

    expect(outcomes[0]?.pass).toBe(false);
    expect(outcomes[0]?.error).toBe('sabotaged on purpose');
    expect(taskReport(outcomes)).toContain('FAIL sabotaged - sabotaged on purpose');
  });

  it('should track actions and observation bytes', async () => {
    const outcomes = await runTasks();
    const withActions = outcomes.filter((o) => o.actions > 0);
    expect(withActions.length).toBeGreaterThan(30);
    expect(outcomes.every((o) => o.observationBytes >= 0)).toBe(true);
  });

  it('should render a per-category report', async () => {
    const report = taskReport(await runTasks());
    expect(report).toContain('5/5 extraction');
    expect(report).toContain('5/5 staleness');
    expect(report).toMatch(/50\/50 tasks succeeded/);
  });
});

// ---------------------------------------------------------------------------
// Direct task-boundary coverage: run real TASKS definitions against stub
// services / tweaked engines and assert each failure reason verbatim.
// ---------------------------------------------------------------------------

type ServiceOverrides = {
  observe?: (
    sessionId: string,
    pageId: string,
    request: Record<string, unknown>
  ) => Promise<unknown>;
  navigate?: (sessionId: string, pageId: string, request: { url: string }) => Promise<unknown>;
  act?: (sessionId: string, pageId: string, request: Record<string, unknown>) => Promise<unknown>;
};

function taskByName(name: string): TaskDefinition {
  const task = TASKS.find((candidate) => candidate.name === name);
  if (task === undefined) {
    throw new Error(`no such task: ${name}`);
  }
  return task;
}

function stubService(overrides: ServiceOverrides = {}): AgentBrowserService {
  return {
    observe:
      overrides.observe ??
      (async () => ({ elements: [], revision: 1, url: 'https://stub.example' })),
    navigate:
      overrides.navigate ??
      (async (_sessionId: string, _pageId: string, request: { url: string }) => ({
        status: 'success',
        url: request.url,
        redirectChain: [],
      })),
    act: overrides.act ?? (async () => ({ status: 'success' })),
  } as unknown as AgentBrowserService;
}

function directContext(service: AgentBrowserService, engine: FakeEngineType = new FakeEngine()) {
  const context: TaskContext = {
    service,
    engine,
    sessionId: 'ses_stub',
    pageId: 'pg_stub',
    fail: (reason: string) => new Error(reason),
    expectRejection: async () => {
      throw new Error('unexpected expectRejection use in a stub context');
    },
    count: () => {},
    observeBytes: () => 0,
  };
  return context;
}

const TEXTBOX = {
  ref: 'e2_2',
  role: 'textbox',
  name: 'Field 2',
  value: '',
  visible: true,
  enabled: true,
};

describe('page-fixture guards', () => {
  it('should fail setup when the engine has no session', () => {
    expect(() => taskByName('extract-value-1').setup?.(new FakeEngine(), 'pg_1')).toThrow(
      'no engine session'
    );
  });

  it('should fail setup when the page id is unknown', async () => {
    const engine = new FakeEngine();
    await engine.createSession({});
    expect(engine.getSessionIds().length).toBe(1);
    expect(() => taskByName('extract-value-1').setup?.(engine, 'pg_missing')).toThrow(
      'no engine page for pg_missing'
    );
  });
});

describe('extraction task boundaries', () => {
  it('should fail when the expected field is missing from the observation', async () => {
    await expect(taskByName('extract-value-1').run(directContext(stubService()))).rejects.toThrow(
      'expected Field 2 with its value'
    );
  });

  it('should fail when the field carries a tampered value', async () => {
    await expect(
      taskByName('extract-value-1').run(
        directContext(
          stubService({
            observe: async () => ({ elements: [{ ...TEXTBOX, value: 'tampered' }], revision: 3 }),
          })
        )
      )
    ).rejects.toThrow('expected Field 2 with its value');
  });
});

describe('navigation task boundaries', () => {
  it('should fail when navigation lands somewhere else', async () => {
    await expect(
      taskByName('multi-step-1').run(
        directContext(
          stubService({
            navigate: async () => ({
              status: 'success',
              url: 'https://elsewhere.example.com',
              redirectChain: [],
            }),
          })
        )
      )
    ).rejects.toThrow('navigation landed on https://elsewhere.example.com');
  });

  it('should fail when the observation lags behind the navigation', async () => {
    await expect(
      taskByName('multi-step-1').run(
        directContext(
          stubService({
            observe: async () => ({ url: 'https://lagging.example.com', elements: [] }),
          })
        )
      )
    ).rejects.toThrow('observation shows https://lagging.example.com');
  });
});

describe('forms task boundaries', () => {
  it('should fail when no textbox is observed', async () => {
    await expect(taskByName('fill-no-submit-1').run(directContext(stubService()))).rejects.toThrow(
      'no textbox to fill'
    );
  });

  it('should fail when the fill does not succeed', async () => {
    await expect(
      taskByName('fill-no-submit-1').run(
        directContext(
          stubService({
            observe: async () => ({ elements: [{ ...TEXTBOX, name: 'Field 1' }] }),
            act: async () => ({ status: 'failure' }),
          })
        )
      )
    ).rejects.toThrow('fill did not succeed');
  });

  it('should fail when the value does not persist', async () => {
    let observations = 0;
    await expect(
      taskByName('fill-no-submit-1').run(
        directContext(
          stubService({
            observe: async () => {
              observations += 1;
              return observations === 1
                ? { elements: [{ ...TEXTBOX, name: 'Field 1' }] }
                : { elements: [{ ...TEXTBOX, name: 'Field 1', value: 'lost' }] };
            },
          })
        )
      )
    ).rejects.toThrow('value not persisted: lost');
  });
});

describe('staleness task boundaries', () => {
  it('should fail when nothing is observed', async () => {
    await expect(taskByName('stale-recovery-1').run(directContext(stubService()))).rejects.toThrow(
      'nothing observed'
    );
  });

  it('should fail on an unexpected rejection code (message captured verbatim)', async () => {
    await expect(
      taskByName('stale-recovery-1').run(
        directContext(
          stubService({
            observe: async () => ({ elements: [{ ...TEXTBOX, name: 'Element 1' }] }),
            act: async (_sessionId, _pageId, request) => {
              if ((request as { action: string }).action === 'press') {
                return { status: 'success' };
              }
              throw new Error('BOOM');
            },
          })
        )
      )
    ).rejects.toThrow('expected STALE_TARGET, got BOOM');
  });

  it('should fail when the retry on the fresh ref does not succeed', async () => {
    let clicks = 0;
    let observations = 0;
    await expect(
      taskByName('stale-recovery-1').run(
        directContext(
          stubService({
            observe: async () => {
              observations += 1;
              return {
                elements: [
                  observations === 1
                    ? { ...TEXTBOX, name: 'Element 1' }
                    : { ...TEXTBOX, ref: 'e2_1', name: 'Element 1' },
                ],
              };
            },
            act: async (_sessionId, _pageId, request) => {
              if ((request as { action: string }).action === 'press') {
                return { status: 'success' };
              }
              clicks += 1;
              if (clicks === 1) {
                throw new ServiceError('STALE_TARGET', 'Element reference is stale');
              }
              return { status: 'failure' };
            },
          })
        )
      )
    ).rejects.toThrow('retry on the fresh ref did not succeed');
  });
});

describe('pagination task boundaries', () => {
  it('should fail when an element appears on two pages', async () => {
    let observations = 0;
    await expect(
      taskByName('pagination-1').run(
        directContext(
          stubService({
            observe: async () => {
              observations += 1;
              return observations === 1
                ? { elements: [{ ref: 'r1' }, { ref: 'r2' }], continuation: { nextOrdinal: 3 } }
                : { elements: [{ ref: 'r1' }] };
            },
          })
        )
      )
    ).rejects.toThrow('element r1 appeared twice');
  });

  it('should fail when pagination yields fewer elements than the fixture holds', async () => {
    await expect(
      taskByName('pagination-1').run(
        directContext(stubService({ observe: async () => ({ elements: [{ ref: 'r1' }] }) }))
      )
    ).rejects.toThrow('paginated 1 elements, expected 6');
  });
});

describe('approval task boundaries', () => {
  it('should fail when nothing is observed', async () => {
    await expect(
      taskByName('approval-boundary-1').run(directContext(stubService()))
    ).rejects.toThrow('nothing observed');
  });

  it('should fail when no denial is raised for the transactional click', async () => {
    await expect(
      taskByName('approval-boundary-1').run(
        directContext(
          stubService({
            observe: async () => ({
              elements: [{ ...TEXTBOX, name: 'Pay 1', risk: 'transaction' }],
            }),
          })
        )
      )
    ).rejects.toThrow('expected APPROVAL_REQUIRED, got NO_ERROR');
  });

  it('should fail when the denial carries no approval token', async () => {
    await expect(
      taskByName('approval-boundary-1').run(
        directContext(
          stubService({
            observe: async () => ({
              elements: [{ ...TEXTBOX, name: 'Pay 1', risk: 'transaction' }],
            }),
            act: async () => {
              throw new ServiceError('APPROVAL_REQUIRED', 'Approval required', false, {});
            },
          })
        )
      )
    ).rejects.toThrow('no approval token issued');
  });

  it('should fail when the approved action still does not succeed', async () => {
    await expect(
      taskByName('approval-boundary-1').run(
        directContext(
          stubService({
            observe: async () => ({
              elements: [{ ...TEXTBOX, name: 'Pay 1', risk: 'transaction' }],
            }),
            act: async (_sessionId, _pageId, request) => {
              if ((request as { approvalToken?: string }).approvalToken === undefined) {
                throw new ServiceError('APPROVAL_REQUIRED', 'Approval required', false, {
                  tokenId: 'tok-1',
                });
              }
              return { status: 'failure' };
            },
          })
        )
      )
    ).rejects.toThrow('approved action did not succeed');
  });
});

describe('diff task boundaries', () => {
  it('should fail when no textbox is observed', async () => {
    await expect(taskByName('diff-1').run(directContext(stubService()))).rejects.toThrow(
      'no textbox'
    );
  });

  it('should fail when the diff reports no modified change', async () => {
    let observations = 0;
    await expect(
      taskByName('diff-1').run(
        directContext(
          stubService({
            observe: async (_sessionId, _pageId, request) => {
              observations += 1;
              if (
                observations === 1 ||
                (request as { sinceRevision?: number }).sinceRevision === undefined
              ) {
                return { elements: [TEXTBOX], revision: 4 };
              }
              return { changes: [] };
            },
          })
        )
      )
    ).rejects.toThrow('no modified change in the diff');
  });

  it('should fail when the modified change lacks the new value', async () => {
    let observations = 0;
    await expect(
      taskByName('diff-1').run(
        directContext(
          stubService({
            observe: async (_sessionId, _pageId, request) => {
              observations += 1;
              if (
                observations === 1 ||
                (request as { sinceRevision?: number }).sinceRevision === undefined
              ) {
                return { elements: [TEXTBOX], revision: 4 };
              }
              return {
                changes: [{ change: 'modified', properties: { value: { new: 'stale' } } }],
              };
            },
          })
        )
      )
    ).rejects.toThrow('diff did not carry the new value');
  });
});

describe('expectRejection contract', () => {
  it('should fail a task whose call resolves although a rejection was expected', async () => {
    const outcomes = await runTasks({
      tasks: [
        {
          name: 'expected-a-rejection',
          category: 'test',
          run: async (ctx) => {
            await ctx.expectRejection('NOT_FOUND', async () => ({ fine: true }));
          },
        },
      ],
    });

    expect(outcomes[0]?.pass).toBe(false);
    expect(outcomes[0]?.error).toBe('expected NOT_FOUND, got NO_ERROR');
  });
});

describe('secret-redaction task boundaries', () => {
  beforeEach(() => {
    sabotage.redactionDisabled = false;
    sabotage.sessionSurvivesClose = false;
  });

  afterEach(() => {
    sabotage.redactionDisabled = false;
    sabotage.sessionSurvivesClose = false;
  });

  it('should fail when the page exposes no textbox', async () => {
    const engine = new ObservationTweakingEngine((state) => ({ ...state, elements: [] }));
    await expect(
      taskByName('secret-redaction-1').run(directContext(stubService(), engine))
    ).rejects.toThrow('no textbox');
  });

  it('should fail when a filled value comes back unredacted', async () => {
    // Only observations after the first are tweaked: the service checks the
    // element fingerprint against the baseline observation before filling.
    let observations = 0;
    const engine = new ObservationTweakingEngine((state) => {
      observations += 1;
      if (observations === 1) {
        return state;
      }
      return {
        ...state,
        elements: state.elements.map((element) =>
          element.role === 'textbox' ? { ...element, value: 'unredacted-echo' } : element
        ),
      };
    });
    await expect(
      taskByName('secret-redaction-2').run(directContext(stubService(), engine))
    ).rejects.toThrow('expected ***, got unredacted-echo');
  });

  it('should fail when the secret value leaks into the serialized observation', async () => {
    sabotage.redactionDisabled = true;
    await expect(
      taskByName('secret-redaction-3').run(directContext(stubService(), new FakeEngine()))
    ).rejects.toThrow('secret value leaked into the observation');
  });
});

describe('lifecycle close audit', () => {
  afterEach(() => {
    sabotage.sessionSurvivesClose = false;
  });

  it('should pass the close audit when sessions really close', async () => {
    const outcomes = await runTasks({ tasks: [taskByName('lifecycle-1')] });
    expect(outcomes[0]?.pass).toBe(true);
  });

  it('should fail when a session survives close', async () => {
    sabotage.sessionSurvivesClose = true;
    const outcomes = await runTasks({ tasks: [taskByName('lifecycle-1')] });
    expect(outcomes[0]?.pass).toBe(false);
    expect(outcomes[0]?.error).toBe('session survived close');
  });
});

/**
 * A FakeEngine whose page observations flow through `tweak` before the
 * service normalizes them - enough to steer the secret-redaction task's
 * field lookups without touching any production code.
 */
class ObservationTweakingEngine extends FakeEngine {
  private readonly tweak: (state: RawPageState) => RawPageState;

  constructor(tweak: (state: RawPageState) => RawPageState) {
    super();
    this.tweak = tweak;
  }

  override async createSession(options: EngineSessionOptions): Promise<EngineSession> {
    const session = await super.createSession(options);
    const tweak = this.tweak;
    return new Proxy(session, {
      get(target, property) {
        if (property === 'newPage') {
          return async (...args: Parameters<EngineSession['newPage']>) => {
            const page = await target.newPage(...args);
            return new Proxy(page, {
              get(pageTarget, pageProperty) {
                if (pageProperty === 'observe') {
                  return async (request: Parameters<EnginePage['observe']>[0]) =>
                    tweak(await pageTarget.observe(request));
                }
                return Reflect.get(pageTarget, pageProperty, pageTarget);
              },
            }) as EnginePage;
          };
        }
        return Reflect.get(target, property, target);
      },
    }) as EngineSession;
  }
}
