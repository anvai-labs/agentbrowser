// T5 J2b.3 packaging gate: the packaged server candidate must carry the journal
// storage child and resolve it from the extracted tree alone — no source
// checkout, no childModulePath override, run from an unrelated working
// directory. The candidate is packaged by scripts/package-server.mjs (pnpm
// deploy --prod of @agentbrowser/api); this gate extracts that tar and runs a
// real manager/child lifecycle through the deployed control package, asserting
// the forked child's command line stays inside the extraction root.
//
// Run: node --test --test-force-exit scripts/journal-sqlite-packaging-gate.mjs \
//        <path to agentbrowser-server-<target>.tar.gz>
// (design doc: "Verify the storage child is included and resolves paths after
// extraction without the source checkout.")
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

// The candidate path arrives via JOURNAL_PACKAGE_TARBALL under the node --test
// runner (the runner treats positional arguments as test-file paths) or argv
// when the file is run directly.
const tarball = process.env.JOURNAL_PACKAGE_TARBALL ?? process.argv[2];
if (!tarball || !existsSync(tarball)) {
  console.error(
    'usage: JOURNAL_PACKAGE_TARBALL=<server-candidate.tar.gz> node --test --test-force-exit scripts/journal-sqlite-packaging-gate.mjs'
  );
  process.exit(1);
}

const CONTROL_DIST = join('node_modules', '@agentbrowser', 'control', 'dist');
const JOURNAL_MODULES = [
  'journal-sqlite-adapter.js',
  'journal-sqlite-child.js',
  'journal-sqlite-child-protocol.js',
  'journal-sqlite-records.js',
  'journal-sqlite-store.js',
  'operation-journal.js',
];

const scratch = mkdtempSync(join(realpathSync(tmpdir()), 'journal-pkg-gate-'));
const extracted = join(scratch, 'extract');
const unrelatedCwd = join(scratch, 'unrelated');
mkdirSync(join(unrelatedCwd, 'store'), { recursive: true, mode: 0o700 });
mkdirSync(join(unrelatedCwd, 'anchor'), { recursive: true, mode: 0o700 });
test.afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

test('the packaged candidate carries the storage child and resolves it after extraction', () => {
  // Test-only crash-barrier support must never ship in the candidate.
  const listed = execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  assert.ok(!listed.includes('crash-child'), 'test-only crash child leaked into the candidate');
  assert.ok(listed.includes('control/dist/journal-sqlite-child.js'), 'storage child missing from the candidate');

  mkdirSync(extracted, { recursive: true });
  execFileSync('tar', ['-xzf', tarball, '-C', extracted], { stdio: 'pipe' });
  for (const module of JOURNAL_MODULES) {
    assert.ok(
      existsSync(join(extracted, 'server', CONTROL_DIST, module)),
      `deployed control dist is missing ${module}`
    );
  }

  // Everything after this point runs from an unrelated directory: the
  // candidate must resolve its own child, not the source checkout.
  process.chdir(unrelatedCwd);
  const controlRoot = join(extracted, 'server', CONTROL_DIST.replace(/\/dist$/, ''));
  return (async () => {
    const { openOperationJournal } = await import(
      `${controlRoot}/dist/operation-journal.js`
    );
    const { openJournalSqliteOperationJournalAdapter } = await import(
      `${controlRoot}/dist/journal-sqlite-adapter.js`
    );

    const paths = {
      directory: realpathSync(join(unrelatedCwd, 'store')),
      anchorDirectory: realpathSync(join(unrelatedCwd, 'anchor')),
    };
    const adapter = await openJournalSqliteOperationJournalAdapter({
      ...paths,
      restoreGeneration: 'generation-1',
      initialize: true,
      // No childModulePath: the default resolves the child as the adapter's
      // sibling inside the extracted tree. This is the gate.
    });
    try {
      assert.ok(adapter.childPid, 'adapter exposed no storage child pid');
      const command = execFileSync('ps', ['-p', String(adapter.childPid), '-o', 'command='], {
        encoding: 'utf8',
      }).trim();
      // pnpm deploy keeps workspace packages under node_modules/.pnpm (the
      // virtual path is a symlink); the child may report either location, but
      // it must stay inside the extraction's server tree and inside the
      // deployed control package.
      const serverRoot = join(extracted, 'server');
      const deployedChild = join(
        'node_modules',
        '@agentbrowser',
        'control',
        'dist',
        'journal-sqlite-child.js'
      );
      assert.ok(command.includes(serverRoot), `storage child resolved outside the extraction: ${command}`);
      assert.ok(command.includes(deployedChild), `child is not the deployed control package: ${command}`);

      const namespaceConfiguration = {
        schemaVersion: 1,
        namespaceId: 'packaged-a',
        fingerprintVersion: 1,
        fingerprintKeyId: 'key-1',
        restoreGeneration: 'generation-1',
        acceptUntil: Number.MAX_SAFE_INTEGER - 10_000,
        retainUntil: Number.MAX_SAFE_INTEGER,
        maxFinalizationMs: 1_000,
        bounds: {
          maxRecordBytes: 16_384,
          maxRecords: 4,
          maxNamespaces: 2,
          maxInFlight: 2,
          // Real IPC plus a durable fsync commit per call.
          timeoutMs: 10_000,
        },
      };
      const opened = await openOperationJournal(
        adapter,
        namespaceConfiguration,
        Buffer.alloc(32, 7)
      );
      assert.equal(opened.kind, 'opened');
      const reserved = await opened.journal.reserveIntent({
        key: {
          serviceGeneration: 's'.repeat(22),
          tenantId: 'tenant-a',
          sessionIncarnation: 'i'.repeat(22),
          epoch: 1,
          operationId: 'op-packaged-1',
        },
        actor: 'operator-a',
        liveFingerprint: { algorithm: 'rest-json-v1', digest: 'private-packaged' },
      });
      assert.equal(reserved.kind, 'acknowledged');
      assert.deepEqual(await opened.journal.close(), { kind: 'closed' });
    } finally {
      await adapter.dispose();
    }
    const after = (() => {
      try {
        return execFileSync('ps', ['-p', String(adapter.childPid), '-o', 'command='], {
          encoding: 'utf8',
        }).trim();
      } catch {
        return '';
      }
    })();
    assert.equal(after, '', 'storage child outlived dispose of the extracted adapter');
  })();
});
