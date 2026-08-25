/**
 * TDD Tests for the deterministic task benchmark (TD-025)
 */

import { describe, expect, it } from 'vitest';
import { TASKS, TASK_GATE, runTasks, taskReport } from './tasks';

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
