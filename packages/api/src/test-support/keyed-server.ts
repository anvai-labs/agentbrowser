import { createHash } from 'node:crypto';
import { FakeEngine } from '@agentbrowser/testkit';
import { buildServer } from '../server.js';

/**
 * The keyed FakeEngine server the operator-credential suites share: one API key named
 * by `tenant`, authorized as the literal 'operator' bearer. Everything suite-specific
 * (applicationAdapters, policy, …) stays in the caller's options object.
 */
export function keyedServer(
  tenant: string,
  options: Record<string, unknown> = {}
): ReturnType<typeof buildServer> {
  return buildServer({
    engine: new FakeEngine(),
    apiKeys: new Map([[createHash('sha256').update('operator').digest('hex'), tenant]]),
    ...options,
  });
}
