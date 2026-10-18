// T10 M4: the installable `run` CI entrypoint. Thin on purpose: the CLI owns the run contract
// (create, open --url, plan, JUnit, close); this action verifies the pinned release CLI, keeps
// the API key off argv, and maps the exit code through.
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { installCli } from '../test-evaluate/evaluate.mjs';

export const PLAN_RUN_TIMEOUT_MS = 900_000;

export class PlanRunError extends Error {}

const required = (env, name) => {
  const value = env[name];
  if (typeof value !== 'string' || value.trim() === '')
    throw new PlanRunError(`${name} is required.`);
  return value;
};

/** The CLI argv for one run, derived only from the inputs. Pure, so tests can pin it. */
export function planRunArgs(env) {
  const plan = required(env, 'INPUT_PLAN');
  const startUrl = required(env, 'INPUT_START_URL');
  const tenant = required(env, 'INPUT_TENANT');
  const args = ['run', resolve(plan), '--url', startUrl, '--tenant', tenant];
  if (env.INPUT_SCOPE_FILE) args.push('--scope-file', resolve(env.INPUT_SCOPE_FILE));
  const junit = env.INPUT_JUNIT || 'agentbrowser-plan.xml';
  args.push('--junit', resolve(junit));
  if (env.INPUT_KEEP_SESSION === 'true') args.push('--keep-session');
  return { args, junitPath: resolve(junit) };
}

/** How the CLI authenticates: never on argv. A given key is written to a private 0600 file. */
export async function keyArgs(env, workspace = join(tmpdir(), 'agentbrowser-plan-run')) {
  if (env.INPUT_API_KEY_FILE) return ['--api-key-file', resolve(env.INPUT_API_KEY_FILE)];
  if (env.INPUT_API_KEY) {
    const file = join(mkdtempSync(workspace), 'key');
    writeFileSync(file, env.INPUT_API_KEY, { mode: 0o600 });
    return ['--api-key-file', file, { cleanup: file }];
  }
  // No explicit key: the CLI falls back to AGENTBROWSER_API_KEY in its own environment.
  return [];
}

function child(cli, base, key, args, timeoutMs) {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(
      cli,
      ['--base-url', base, ...key, ...args],
      { timeout: timeoutMs, killSignal: 'SIGKILL', encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error == null) return resolvePromise({ code: 0, stdout, stderr });
        // A nonzero exit arrives as an error object without signal; a timeout arrives with one.
        if (error.killed !== true)
          return resolvePromise({
            code: typeof error.code === 'number' ? error.code : 1,
            stdout,
            stderr,
          });
        if (error.killed)
          return rejectPromise(new PlanRunError(`the run timed out after ${timeoutMs} ms`));
        resolvePromise({ code: error.code ?? 1, stdout, stderr });
      }
    );
  });
}

export async function main(env = process.env, log = console.log) {
  const base = required(env, 'INPUT_BASE_URL');
  // A pre-installed CLI (tests, qualification) replaces the pinned download.
  const version = env.AGENTBROWSER_EVALUATE_CLI || required(env, 'INPUT_CLI_VERSION');
  const timeoutMs = Number.parseInt(env.INPUT_TIMEOUT_MS || '', 10) || PLAN_RUN_TIMEOUT_MS;
  const { args, junitPath } = planRunArgs(env);
  const workspace = mkdtempSync(join(tmpdir(), 'agentbrowser-plan-run-'));
  try {
    const [cli, key] = await Promise.all([
      env.AGENTBROWSER_EVALUATE_CLI || installCli(version),
      keyArgs(env, workspace),
    ]);
    const keyOnly = key.filter((part) => typeof part === 'string');
    const { code, stdout } = await child(cli, base, keyOnly, args, timeoutMs);
    log(stdout.trimEnd());
    return code;
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      console.error(error instanceof PlanRunError ? error.message : error);
      process.exit(1);
    }
  );
}
