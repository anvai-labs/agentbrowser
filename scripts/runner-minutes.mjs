#!/usr/bin/env node
/**
 * T9: measure CI runner use from the GitHub API, so before/after claims about workflow changes
 * are measured, not estimated.
 *
 *   node scripts/runner-minutes.mjs [--repo anvai-labs/agentbrowser] [--runs 10] [--json]
 *
 * For each workflow it samples the most recent successful runs and reports, per run: the job
 * count, total job minutes (sum of job durations) and billed-style minutes (each job rounded up
 * to a whole minute, the way GitHub meters hosted runners), split by runner type
 * (GitHub-hosted vs self-hosted, from each job's runner name), plus wall-clock duration.
 * Medians are reported because single runs vary with queueing. Read-only; needs `gh` auth.
 */
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
};
const repo = flag('--repo', 'anvai-labs/agentbrowser');
const runs = Number(flag('--runs', '10'));

/** One page of a GitHub API listing (the listings here never need more than one). */
function gh(path) {
  const result = spawnSync('gh', ['api', path], { encoding: 'utf8', maxBuffer: 64 << 20 });
  if (result.status !== 0) throw new Error(`gh api ${path} failed: ${result.stderr.slice(0, 300)}`);
  return JSON.parse(result.stdout);
}

const median = (values) => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const minutes = (start, end) => Math.max(0, (Date.parse(end) - Date.parse(start)) / 60_000);
/** GitHub-hosted runners are named "GitHub Actions <n>"; anything else is self-hosted. */
const hosted = (job) => /^GitHub Actions \d+$/.test(job.runner_name ?? '');

export function summarizeRun(run, jobs) {
  const finished = jobs.filter(
    (job) => job.started_at && job.completed_at && job.conclusion !== 'skipped'
  );
  const split = {
    hosted: { minutes: 0, billed: 0, jobs: 0 },
    selfHosted: { minutes: 0, billed: 0, jobs: 0 },
  };
  for (const job of finished) {
    const used = minutes(job.started_at, job.completed_at);
    const bucket = hosted(job) ? split.hosted : split.selfHosted;
    bucket.minutes += used;
    bucket.billed += Math.ceil(used);
    bucket.jobs += 1;
  }
  return {
    id: run.id,
    event: run.event,
    wallMinutes: minutes(run.run_started_at ?? run.created_at, run.updated_at),
    ...split,
  };
}

async function main() {
  if (!Number.isInteger(runs) || runs < 1 || runs > 50) {
    console.error('--runs must be an integer from 1 to 50');
    process.exit(2);
  }
  const workflows = gh(`repos/${repo}/actions/workflows?per_page=100`).workflows;
  const report = {
    repo,
    measuredAt: new Date().toISOString(),
    sampledRunsPerWorkflow: runs,
    workflows: [],
  };
  for (const workflow of workflows.filter((w) => w.state === 'active')) {
    const recent = gh(
      `repos/${repo}/actions/workflows/${workflow.id}/runs?status=success&per_page=${runs}`
    ).workflow_runs.slice(0, runs);
    const sampled = recent.map((run) =>
      summarizeRun(run, gh(`repos/${repo}/actions/runs/${run.id}/jobs?per_page=100`).jobs)
    );
    report.workflows.push({
      name: workflow.name,
      path: workflow.path,
      runs: sampled.length,
      median: {
        wallMinutes: median(sampled.map((r) => r.wallMinutes)),
        hostedJobMinutes: median(sampled.map((r) => r.hosted.minutes)),
        hostedBilledMinutes: median(sampled.map((r) => r.hosted.billed)),
        selfHostedJobMinutes: median(sampled.map((r) => r.selfHosted.minutes)),
        jobs: median(sampled.map((r) => r.hosted.jobs + r.selfHosted.jobs)),
      },
      events: [...new Set(sampled.map((r) => r.event))].sort(),
    });
  }

  if (args.includes('--json')) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    const f = (n) => n.toFixed(1);
    console.log(
      `${repo}, last ${runs} successful runs per workflow (medians), ${report.measuredAt}`
    );
    console.log(
      'workflow | runs | jobs | wall min | hosted job min | hosted billed min | self-hosted job min'
    );
    for (const w of report.workflows)
      console.log(
        `${w.path} | ${w.runs} | ${w.median.jobs} | ${f(w.median.wallMinutes)} | ${f(w.median.hostedJobMinutes)} | ${w.median.hostedBilledMinutes} | ${f(w.median.selfHostedJobMinutes)}`
      );
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
