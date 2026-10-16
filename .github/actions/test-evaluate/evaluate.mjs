#!/usr/bin/env node
/**
 * T3: the installable CI entrypoint for `agentbrowser test evaluate`.
 *
 * Installs one pinned, checksum-verified release CLI, evaluates every caller-observed evaluation
 * bundle it is given (offline: nothing is executed or fetched), writes a JUnit report and exits
 * non-zero unless every bundle passed. Builtins only; runs under Node 18 or later.
 *
 * Inputs (environment, as the composite action passes them):
 *   INPUT_VERSION      release tag, e.g. v1.19.0 (required unless AGENTBROWSER_EVALUATE_CLI)
 *   INPUT_BUNDLES      newline-separated files or directories (directories: every *.json)
 *   INPUT_JUNIT        JUnit output path (default agentbrowser-evaluate.xml)
 *   INPUT_REPORTS_DIR  optional directory for the full JSON reports (private, mode 0600; they
 *                      can contain sensitive caller data, so they are never printed)
 * Overrides (qualification only): AGENTBROWSER_EVALUATE_CLI uses a local CLI instead of
 * downloading one; AGENTBROWSER_RELEASE_BASE_URL replaces the GitHub releases download URL.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const RELEASES = 'https://github.com/anvai-labs/agentbrowser/releases/download';
const TAG = /^v\d+\.\d+\.\d+$/;
const ASSETS = {
  'linux-x64': 'agentbrowser-cli-linux-x64',
  'linux-arm64': 'agentbrowser-cli-linux-arm64',
  'darwin-x64': 'agentbrowser-cli-darwin-x64',
  'darwin-arm64': 'agentbrowser-cli-darwin-arm64',
  'win32-x64': 'agentbrowser-cli-windows-x64.exe',
};

export class EvaluateError extends Error {}

/** The release asset for this runner, or a refusal naming the platform. */
export function assetFor(platform = process.platform, arch = process.arch) {
  const asset = ASSETS[`${platform}-${arch}`];
  if (!asset) throw new EvaluateError(`No agentbrowser CLI release for ${platform}-${arch}`);
  return asset;
}

/** The expected digest for `asset` from a release's sha256sums.txt, or a refusal. */
export function expectedDigest(sums, asset) {
  const matches = sums
    .split(/\r?\n/)
    .map((line) => line.trim().match(/^([0-9a-f]{64})\s+\*?(.+)$/))
    .filter((match) => match && match[2] === asset);
  if (matches.length !== 1)
    throw new EvaluateError(`sha256sums.txt does not list ${asset} exactly once`);
  return matches[0][1];
}

async function download(url) {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) throw new EvaluateError(`Download failed (${response.status}): ${url}`);
  return Buffer.from(await response.arrayBuffer());
}

/** Downloads and verifies the pinned CLI; returns its path. Never runs an unverified binary. */
export async function installCli(version, options = {}) {
  if (!TAG.test(version ?? ''))
    throw new EvaluateError('version must be a release tag such as v1.19.0');
  const base = (options.baseUrl ?? RELEASES).replace(/\/+$/, '');
  const asset = assetFor(options.platform, options.arch);
  const sums = (await download(`${base}/${version}/sha256sums.txt`)).toString('utf8');
  const expected = expectedDigest(sums, asset);
  const bytes = await download(`${base}/${version}/${asset}`);
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== expected)
    throw new EvaluateError(`Checksum mismatch for ${asset}: refusing to run it`);
  // A private directory: under RUNNER_TEMP (job-private) when given, otherwise a fresh mkdtemp,
  // never a predictable shared path another user could pre-create.
  const directory = options.directory
    ? join(options.directory, `agentbrowser-cli-${version}`)
    : mkdtempSync(join(tmpdir(), `agentbrowser-cli-${version}-`));
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, asset);
  writeFileSync(path, bytes, { mode: 0o755 });
  chmodSync(path, 0o755);
  return path;
}

/** Every bundle file named by the input: files as given, directories as their *.json files. */
export function bundleFiles(input) {
  const files = [];
  for (const entry of (input ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)) {
    const path = resolve(entry);
    let stat;
    try {
      stat = statSync(path);
    } catch {
      throw new EvaluateError(`Bundle path does not exist: ${entry}`);
    }
    if (stat.isDirectory())
      for (const name of readdirSync(path).sort())
        if (name.endsWith('.json')) files.push(join(path, name));
    if (stat.isFile()) files.push(path);
  }
  const unique = [...new Set(files)];
  if (unique.length === 0) throw new EvaluateError('No evaluation bundles found');
  return unique;
}

/** Upper bound for one offline evaluation; a hung CLI is an error, not a hung job. */
export const EVALUATE_TIMEOUT_MS = 120_000;

/** Evaluates one bundle through the CLI: passed, failed, or error (invalid input/no report). */
export function evaluateBundle(cli, file, timeoutMs = EVALUATE_TIMEOUT_MS) {
  const run = spawnSync(cli, ['--json', 'test', 'evaluate', `@${file}`], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    timeout: timeoutMs,
  });
  let report;
  try {
    report = JSON.parse(run.stdout);
  } catch {
    report = undefined;
  }
  const verdict = report?.verdict;
  if ((run.status === 0 && verdict === 'passed') || (run.status === 1 && verdict === 'failed'))
    return {
      file,
      outcome: verdict,
      id: `${report.descriptor?.id ?? 'unknown'}@${report.descriptor?.version ?? '?'}`,
      report,
    };
  return { file, outcome: 'error', id: basename(file), report: undefined };
}

const xml = (text) =>
  String(text)
    // XML 1.0 forbids C0 controls even when escaped.
    // biome-ignore lint/suspicious/noControlCharactersInRegex: matching them is the point.
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '\uFFFD')
    .replace(
      /[<>&'"]/g,
      (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]
    );

/**
 * JUnit with identities and verdicts only: report contents (which may carry caller data) never
 * enter it.
 */
export function junit(results) {
  const failures = results.filter((r) => r.outcome === 'failed').length;
  const errors = results.filter((r) => r.outcome === 'error').length;
  const cases = results.map((r) => {
    const open = `    <testcase classname="${xml(basename(r.file))}" name="${xml(r.id)}"`;
    if (r.outcome === 'passed') return `${open}/>`;
    if (r.outcome === 'failed')
      return `${open}>\n      <failure message="verdict: failed"/>\n    </testcase>`;
    return `${open}>\n      <error message="invalid evaluation bundle or no report"/>\n    </testcase>`;
  });
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuites tests="${results.length}" failures="${failures}" errors="${errors}">`,
    `  <testsuite name="agentbrowser test evaluate" tests="${results.length}" failures="${failures}" errors="${errors}">`,
    ...cases,
    '  </testsuite>',
    '</testsuites>',
    '',
  ].join('\n');
}

export async function main(env = process.env, log = console.log) {
  const cli =
    env.AGENTBROWSER_EVALUATE_CLI ||
    (await installCli(env.INPUT_VERSION, {
      ...(env.AGENTBROWSER_RELEASE_BASE_URL ? { baseUrl: env.AGENTBROWSER_RELEASE_BASE_URL } : {}),
      ...(env.RUNNER_TEMP ? { directory: env.RUNNER_TEMP } : {}),
    }));
  const results = bundleFiles(env.INPUT_BUNDLES).map((file) => evaluateBundle(cli, file));
  const junitPath = resolve(env.INPUT_JUNIT || 'agentbrowser-evaluate.xml');
  mkdirSync(dirname(junitPath), { recursive: true });
  writeFileSync(junitPath, junit(results));
  if (env.INPUT_REPORTS_DIR) {
    mkdirSync(env.INPUT_REPORTS_DIR, { recursive: true, mode: 0o700 });
    // Index-prefixed so bundles sharing a basename never overwrite each other's report; chmod
    // after writing because a mode only applies to a newly created file.
    for (const [index, r] of results.entries())
      if (r.report) {
        const path = join(
          env.INPUT_REPORTS_DIR,
          `${String(index + 1).padStart(3, '0')}-${basename(r.file, '.json')}.report.json`
        );
        writeFileSync(path, `${JSON.stringify(r.report, null, 2)}\n`, { mode: 0o600 });
        chmodSync(path, 0o600);
      }
  }
  for (const r of results) log(`${r.outcome.padEnd(6)} ${r.id} (${basename(r.file)})`);
  const passed = results.filter((r) => r.outcome === 'passed').length;
  log(`${passed}/${results.length} passed; JUnit: ${junitPath}`);
  return passed === results.length ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      console.error(error instanceof EvaluateError ? error.message : 'test evaluate failed');
      process.exit(2);
    }
  );
}
