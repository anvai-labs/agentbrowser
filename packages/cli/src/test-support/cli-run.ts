import { buildCli, type CliClient } from '../cli.js';

/**
 * The offline-command suites' shared harness (finding/scope-import): run the CLI
 * in-process against a stub client with captured stdio, returning the exit code and
 * the joined out/err text. Online suites stub real client surfaces instead and keep
 * their own harnesses.
 */
export async function runCli(argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const cli = buildCli({
    createClient: () => ({}) as unknown as CliClient,
    out: (line: string) => out.push(line),
    err: (line: string) => err.push(line),
  });
  const code = await cli.run(argv);
  return { code, out: out.join('\n'), err: err.join('\n') };
}
