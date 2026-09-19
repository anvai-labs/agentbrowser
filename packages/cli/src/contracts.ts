/**
 * Type-level contract checks (ADR-015), closing the long-open recommendation
 * for the CLI's structural SDK mirror.
 *
 * These live in a COMPILED source file deliberately: test files are excluded
 * from tsconfig and vitest does not type-check, so assertions there would
 * never run in CI. `pnpm -r type-check` enforces these — if the real SDK
 * client and the CLI's structural slice drift apart (a renamed method, a
 * changed signature, a widened return), this file stops compiling.
 *
 * Direction is one-way: the REAL client must satisfy the CLI's mirror. The
 * mirror deliberately marks newer families optional so tests can supply
 * partial stand-ins; asserting the reverse would demand the mirror carry
 * every SDK member and defeat that purpose.
 */

import type { AgentBrowserClient } from '@agentbrowser/sdk-typescript';
import type { CliClient } from './cli.js';

export const sdkClientSatisfiesCliClient =
  null as unknown as AgentBrowserClient satisfies CliClient;
