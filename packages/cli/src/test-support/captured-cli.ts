import type { Readable } from 'node:stream';
import { buildCli, type CliDependencies } from '../cli.js';

/**
 * The captured-stdio CLI core every offline harness composes: buildCli over pushed
 * out/err lines with the caller's client factory and optional stdin. The composees
 * differ ONLY in the client contract — a stub (runCli), a must-never-connect spy
 * (offlineCliHarness), or a suite's own fetch/env machinery (operator-key).
 *
 * NOTE: src/test-support is excluded from the package tsconfig (the repo convention),
 * so this file is NOT type-checked — keep its types trivial.
 */
export function buildCapturedCli(createClient: CliDependencies['createClient'], stdin?: Readable) {
  const out: string[] = [];
  const err: string[] = [];
  const cli = buildCli({
    ...(stdin ? { stdin } : {}),
    out: (line: string) => out.push(line),
    err: (line: string) => err.push(line),
    createClient,
  });
  return { cli, out, err };
}
