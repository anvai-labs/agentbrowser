import type { CliClient } from '../cli.js';
import { buildCapturedCli } from './captured-cli.js';

/**
 * The offline-command suites' shared harness (finding/scope-import): run the CLI
 * in-process against a stub client with captured stdio, returning the exit code and
 * the joined out/err text. Online suites stub real client surfaces instead and keep
 * their own harnesses.
 */
export async function runCli(argv: string[]) {
  const { cli, out, err } = buildCapturedCli(() => ({}) as unknown as CliClient);
  const code = await cli.run(argv);
  return { code, out: out.join('\n'), err: err.join('\n') };
}
