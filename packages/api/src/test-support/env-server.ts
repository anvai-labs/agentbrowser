import { createHash } from 'node:crypto';
import { FakeEngine } from '@agentbrowser/testkit';
import { vi } from 'vitest';
import { buildServer } from '../server.js';

/**
 * The journal-over-HTTP suites' shared server bootstrap: swap the process environment to
 * `env` (restored via `cleanup`), silence the expected config warnings, then build a
 * FakeEngine server keyed by `apiKey` (omit it for the keyless mode) and register its
 * close. Returns the warn spy for suites that assert on the warnings.
 */
export async function buildEnvServer(
  cleanup: Array<() => unknown>,
  env: Record<string, string | undefined>,
  options: {
    apiKey?: string;
    applicationAdapters?: import('@agentbrowser/control').ApplicationAdapter[];
  } = {}
) {
  const names = Object.keys(env);
  const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  cleanup.push(() => {
    for (const name of names) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  });
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  cleanup.push(() => warn.mockRestore());
  const server = await buildServer({
    engine: new FakeEngine(),
    ...(options.apiKey === undefined
      ? {}
      : {
          apiKeys: new Map([[createHash('sha256').update(options.apiKey).digest('hex'), 'owner']]),
        }),
    ...(options.applicationAdapters ? { applicationAdapters: options.applicationAdapters } : {}),
  });
  cleanup.push(() => server.close());
  return { server, warn };
}
