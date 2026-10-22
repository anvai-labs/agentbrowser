import { createHash } from 'node:crypto';
import { FakeEngine } from '@agentbrowser/testkit';
import type { ServerOptions } from '../server.js';
import { buildServer } from '../server.js';

/**
 * The keyed FakeEngine server the operator-credential suites share: one API key named
 * by `tenant`, authorized as the literal 'operator' bearer. Everything suite-specific
 * (applicationAdapters, an engine override, policy, …) stays in the caller's options —
 * typed as ServerOptions minus apiKeys, so a typo'd option is a compile error, not a
 * silently-misconfigured server.
 */
export function keyedServer(
  tenant: string,
  options: Omit<Partial<ServerOptions>, 'apiKeys'> = {}
): ReturnType<typeof buildServer> {
  return buildServer({
    engine: new FakeEngine(),
    apiKeys: new Map([[createHash('sha256').update('operator').digest('hex'), tenant]]),
    ...options,
  });
}
