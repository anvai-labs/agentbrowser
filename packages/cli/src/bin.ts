#!/usr/bin/env node
/**
 * CLI entrypoint.
 *
 * Wires the command surface to the real SDK client and the process streams,
 * then exits with the code the CLI returns.
 */

import { AgentBrowserClient } from '@agentbrowser/sdk-typescript';
import { buildCli } from './cli.js';

const cli = buildCli({
  createClient: (options) => new AgentBrowserClient(options),
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
});

const exitCode = await cli.run(process.argv.slice(2));
process.exitCode = exitCode;
