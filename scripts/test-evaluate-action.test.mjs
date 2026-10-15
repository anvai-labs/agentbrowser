/**
 * T3: the installable `test evaluate` CI entrypoint (.github/actions/test-evaluate).
 *
 * Runs everywhere with a stub CLI. With AGENTBROWSER_EVALUATE_REAL_CLI pointing at a compiled
 * CLI (the CI Bun job), the same entrypoint is also qualified against the real binary.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  assetFor,
  bundleFiles,
  EvaluateError,
  expectedDigest,
  installCli,
  main,
} from '../.github/actions/test-evaluate/evaluate.mjs';

const fixtures = fileURLToPath(new URL('./fixtures/test-evaluate/', import.meta.url));
const passed = join(fixtures, 'passed.json');
const failed = join(fixtures, 'failed.json');
const posix = process.platform !== 'win32';
const work = mkdtempSync(join(tmpdir(), 'test-evaluate-action-'));
after(() => rmSync(work, { recursive: true, force: true }));

/** A stub CLI with the real contract: exit 0 + passed, exit 1 + failed, exit 1 + nothing. */
function stubCli() {
  const path = join(work, 'stub-cli.mjs');
  writeFileSync(
    path,
    `#!/usr/bin/env node
import { readFileSync } from 'node:fs';
const [, , json, test, evaluate, arg] = process.argv;
if (json !== '--json' || test !== 'test' || evaluate !== 'evaluate' || !arg?.startsWith('@')) process.exit(2);
let bundle;
try { bundle = JSON.parse(readFileSync(arg.slice(1), 'utf8')); } catch { process.exit(1); }
const status = bundle?.report?.assertions?.[0]?.report?.outcome?.verification?.status;
if (status !== 'passed' && status !== 'failed') process.exit(1);
console.log(JSON.stringify({ schemaVersion: 1, provenance: 'caller_observed', verdict: status, descriptor: bundle.descriptor, report: bundle.report }));
process.exit(status === 'passed' ? 0 : 1);
`
  );
  chmodSync(path, 0o755);
  return path;
}

describe('release asset selection and checksums', () => {
  it('maps every released platform and refuses others', () => {
    assert.equal(assetFor('linux', 'x64'), 'agentbrowser-cli-linux-x64');
    assert.equal(assetFor('darwin', 'arm64'), 'agentbrowser-cli-darwin-arm64');
    assert.equal(assetFor('win32', 'x64'), 'agentbrowser-cli-windows-x64.exe');
    assert.throws(() => assetFor('freebsd', 'x64'), EvaluateError);
  });

  it('reads exactly one digest line for the asset', () => {
    const digest = 'a'.repeat(64);
    assert.equal(
      expectedDigest(`${digest}  agentbrowser-cli-linux-x64\n`, 'agentbrowser-cli-linux-x64'),
      digest
    );
    assert.equal(
      expectedDigest(`${digest} *agentbrowser-cli-linux-x64`, 'agentbrowser-cli-linux-x64'),
      digest
    );
    assert.throws(
      () => expectedDigest(`${digest}  other`, 'agentbrowser-cli-linux-x64'),
      EvaluateError
    );
    assert.throws(
      () =>
        expectedDigest(
          `${digest}  agentbrowser-cli-linux-x64\n${'b'.repeat(64)}  agentbrowser-cli-linux-x64`,
          'agentbrowser-cli-linux-x64'
        ),
      EvaluateError
    );
  });
});

describe('installCli', () => {
  async function release(bytes, sumsFor) {
    const server = createServer((request, response) => {
      if (request.url === '/v9.9.9/sha256sums.txt') response.end(sumsFor(bytes));
      else if (request.url === '/v9.9.9/agentbrowser-cli-linux-x64') response.end(bytes);
      else {
        response.statusCode = 404;
        response.end();
      }
    });
    await new Promise((done) => server.listen(0, '127.0.0.1', done));
    return { server, baseUrl: `http://127.0.0.1:${server.address().port}` };
  }

  it('installs a verified binary', async () => {
    const bytes = Buffer.from('#!/bin/sh\necho ok\n');
    const digest = createHash('sha256').update(bytes).digest('hex');
    const { server, baseUrl } = await release(
      bytes,
      () => `${digest}  agentbrowser-cli-linux-x64\n`
    );
    try {
      const path = await installCli('v9.9.9', {
        baseUrl,
        platform: 'linux',
        arch: 'x64',
        directory: join(work, 'ok'),
      });
      assert.deepEqual(readFileSync(path), bytes);
      if (posix) assert.equal(statSync(path).mode & 0o111, 0o111);
    } finally {
      server.close();
    }
  });

  it('refuses a binary whose checksum does not match, and never writes it', async () => {
    const { server, baseUrl } = await release(
      Buffer.from('tampered'),
      () => `${'0'.repeat(64)}  agentbrowser-cli-linux-x64\n`
    );
    const directory = join(work, 'bad');
    try {
      await assert.rejects(
        installCli('v9.9.9', { baseUrl, platform: 'linux', arch: 'x64', directory }),
        /Checksum mismatch/
      );
      assert.throws(() =>
        statSync(join(directory, 'agentbrowser-cli-v9.9.9', 'agentbrowser-cli-linux-x64'))
      );
    } finally {
      server.close();
    }
  });

  it('refuses a version that is not a release tag', async () => {
    await assert.rejects(installCli('latest'), EvaluateError);
    await assert.rejects(installCli('1.18.0'), EvaluateError);
  });
});

describe('bundle discovery', () => {
  it('expands directories to their JSON files and keeps explicit files', () => {
    assert.deepEqual(bundleFiles(fixtures), [failed, passed]);
    assert.deepEqual(bundleFiles(`${passed}\n`), [passed]);
  });

  it('refuses missing paths and an empty selection', () => {
    assert.throws(() => bundleFiles(join(work, 'nope')), /does not exist/);
    assert.throws(() => bundleFiles(''), /No evaluation bundles/);
  });
});

function runMain(cli, bundles, extra = {}) {
  const junitPath = join(work, `junit-${Math.random().toString(36).slice(2)}.xml`);
  const lines = [];
  return main(
    { AGENTBROWSER_EVALUATE_CLI: cli, INPUT_BUNDLES: bundles, INPUT_JUNIT: junitPath, ...extra },
    (line) => lines.push(line)
  ).then((code) => ({ code, junit: readFileSync(junitPath, 'utf8'), lines }));
}

function contract(label, cli) {
  describe(`main (${label})`, () => {
    it('exits 0 only when every bundle passed', async () => {
      const { code, junit } = await runMain(cli(), passed);
      assert.equal(code, 0);
      assert.match(junit, /tests="1" failures="0" errors="0"/);
      assert.match(junit, /name="counter@1\.0\.0"\/>/);
    });

    it('reports a failed verdict as a JUnit failure and exits 1', async () => {
      const { code, junit, lines } = await runMain(cli(), fixtures);
      assert.equal(code, 1);
      assert.match(junit, /tests="2" failures="1" errors="0"/);
      assert.match(junit, /<failure message="verdict: failed"\/>/);
      assert.ok(lines.some((line) => line.startsWith('failed')));
    });

    it('reports an invalid bundle as a JUnit error and exits 1', async () => {
      const invalid = join(work, 'invalid.json');
      writeFileSync(invalid, '{"schemaVersion": 1}');
      const { code, junit } = await runMain(cli(), `${passed}\n${invalid}`);
      assert.equal(code, 1);
      assert.match(junit, /errors="1"/);
    });

    it('keeps caller data out of JUnit and writes full reports privately', async () => {
      const reports = join(work, `reports-${label.replace(/\W/g, '')}`);
      const { junit } = await runMain(cli(), fixtures, { INPUT_REPORTS_DIR: reports });
      assert.doesNotMatch(junit, /PRIVATE-EXPECTED-INPUT|event-1/);
      const report = join(reports, 'passed.report.json');
      assert.equal(JSON.parse(readFileSync(report, 'utf8')).verdict, 'passed');
      if (posix) assert.equal(statSync(report).mode & 0o077, 0);
    });
  });
}

contract('stub CLI', stubCli);
const realCli = process.env.AGENTBROWSER_EVALUATE_REAL_CLI;
if (realCli) contract('real CLI', () => realCli);
