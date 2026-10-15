import assert from 'node:assert/strict';
import { it } from 'node:test';
import { summarizeRun } from './runner-minutes.mjs';

const job = (runner, start, end, conclusion = 'success') => ({
  runner_name: runner,
  started_at: start,
  completed_at: end,
  conclusion,
});

it('splits hosted and self-hosted jobs and rounds each job up for billed minutes', () => {
  const run = {
    id: 1,
    event: 'push',
    run_started_at: '2026-10-15T00:00:00Z',
    updated_at: '2026-10-15T00:10:00Z',
  };
  const summary = summarizeRun(run, [
    job('GitHub Actions 12', '2026-10-15T00:00:00Z', '2026-10-15T00:01:30Z'),
    job('GitHub Actions 7', '2026-10-15T00:00:00Z', '2026-10-15T00:00:10Z'),
    job('aiserver1-runner', '2026-10-15T00:00:00Z', '2026-10-15T00:03:00Z'),
    job('GitHub Actions 3', '2026-10-15T00:00:00Z', '2026-10-15T00:09:00Z', 'skipped'),
    {
      runner_name: 'GitHub Actions 4',
      started_at: null,
      completed_at: null,
      conclusion: 'skipped',
    },
  ]);
  assert.equal(summary.wallMinutes, 10);
  assert.equal(summary.hosted.jobs, 2);
  assert.ok(Math.abs(summary.hosted.minutes - (1.5 + 10 / 60)) < 1e-9);
  assert.equal(summary.hosted.billed, 3); // 1.5 -> 2, 0.17 -> 1
  assert.deepEqual(summary.selfHosted, { minutes: 3, billed: 3, jobs: 1 });
});
