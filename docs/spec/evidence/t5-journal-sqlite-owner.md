# T5 J2b.1: SQLite owner and anchored transaction foundation

Base: develop `83b747b` (PR #301). Status: implemented locally; review/delivery pending.
Scope: internal storage primitive, not a raw journal adapter or public durability.
Design and remaining gates: [J2b qualification](../design/t5-journal-sqlite-qualification.md).

## Reuse and boundary

`packages/control/src/journal-sqlite-store.ts` owns only the local database lifetime
and commit witness. It is absent from `control/src/index.ts` and has no service setting,
transport field, runtime dependency or business executor. It requires an IPC child;
the next packet supplies the bounded store manager/raw adapter. Production code must
never call it in the API process. The ordinary control entry point imports without SQLite.

The synchronous `mutate` callback is trusted storage implementation code, not a plugin
or user callback. It receives a frozen, revocable exec/run/get facade with no raw DB or
statement handles. SQLite authorization denies transaction-control, PRAGMA, attach/detach
and witness-table access. The facade expires before commit; retained/microtask calls
refuse. Results reuse the existing bounded journalData snapshot helper. This primitive
owns the transaction; the future adapter reuses journal parsers/CAS/identity rules.
It does not implement another authority, operation registry or timeout owner.

The operator provisions two disjoint canonical private directories. `initialize: true`
is explicit first creation only; it cannot recreate an interrupted store. Exclusive
creation reserves both the owner file and final anchor name. The empty reserved anchor
is an intentionally invalid partial pair until initialization completes; this prevents
concurrent distinct stores from overwriting a shared anchor. No file is auto-deleted on
failure. Separate directory placement does not prove separate backup scope.

The child holds `BEGIN EXCLUSIVE` in two derived rollback databases (store/owner.sqlite,
then anchor/owner.sqlite; busy timeout zero) before opening data. The second lock prevents
cloned stores with different data paths from concurrently sharing a live anchor.
The WAL/FULL data transaction writes a strict singleton witness. Initialization uses
sequence zero; each mutation increments once and replaces the random nonce. The store
syncs the data directory after each commit, including initialization and writes the external anchor by private
exclusive temp creation, file fsync, atomic rename and directory fsync before returning.
Reopen requires the exact version/UUID/generation/sequence/nonce pair and no leftover temp.
Mutation-stage failure seals further writes and emits a static error without SQL/path text.
Close requires a successful TRUNCATE checkpoint, closes data, then releases the store
lock and finally the anchor lock. A busy/failed checkpoint retains both locks. IPC loss exits the child;
caller timeout/drain behavior belongs to the later manager and existing journal facade.

## Failing-first and local observations

Pinned Node 24.21.0, Darwin arm64. Before implementation, the real child suite had
11 failed positive/crash tests; the five layout refusals also refused a missing module
and are not claimed as independent negative-control evidence. The implemented suite
currently passes 43 tests, including:

- Exclusive competing-process, cloned-store/shared-anchor and same-child ownership; clean close and SIGKILL release.
- Concurrent first initialization against a shared anchor and private file modes.
- SIGKILL before DB commit, after DB commit before anchor, and after full anchor completion
  before the fixture's IPC ACK. Only the middle state refuses as mismatched.
- Interrupted initialization, stale DB/anchor restores, each witness mismatch dimension,
  missing/malformed/oversized anchor and abandoned anchor temp refusal.
- Symlink/hardlink aliases, directory permissions and overlapping-directory refusal.
- Revoked retained/async callbacks, detached results, forbidden SQL, callback rollback
  and sealed admission after failures; anchor rename and directory fsync
  faults cannot emit ACK or allow another mutation. Errors omit the private sentinel.
- Busy checkpoint with a real reader retains both lifetime locks; store-directory sync
  failure withholds acknowledgment after WAL recreation.
- Compiled module loading from an unrelated cwd and exact committed fact observation
  through a separate SQLite connection while the owner remains live.

Run after building workspace dependencies:

```sh
pnpm --filter @agentbrowser/control exec vitest run src/journal-sqlite-store.test.ts --maxWorkers=1 --minWorkers=1
node --no-experimental-sqlite packages/control/scripts/accept-deployment.mjs "$PWD/packages/control/dist/index.js"
```

The existing application acceptance exits zero with SQLite disabled. Review regression
tests initially reproduced five failures in callback retention, cloned-store/shared-anchor
ownership and noncanonical JSON; fixes pass the expanded suite.
The [pinned SQLite API](https://raw.githubusercontent.com/nodejs/node/v24.21.0/doc/api/sqlite.md)
specifies setAuthorizer; this internal lane checks its presence before opening files.
The local build has no StatementSync.close method; DatabaseSync.close finalizes statements
according to [Node source](https://raw.githubusercontent.com/nodejs/node/v24.21.0/src/node_sqlite.cc).
No statement handles escape the SQL helper; full physical/cache bounds remain unqualified. The test fixture
alone instruments the real SQLite COMMIT and filesystem methods to establish explicit
IPC barriers/faults; production storage has no phase hooks or test flags. Kill tests wait
for actual child exit before reopening. Existing workspace tests run this suite in the
existing CI Test job; no additional job or runtime/browser matrix is introduced.

## Not yet qualified

This is not the 17-case raw adapter conformance suite. Namespace descriptors/fences,
record/CAS/retention/HMAC enforcement, clock high-water, bounded IPC manager, physical
DB/WAL ceilings, hostile/corrupt schema coverage, disk-full behavior, packaged server
extraction and other target filesystems remain J2b gates. No source/public runtime selector
or recovery is enabled. Process loss is not power-loss qualification, and restoring both
DB and anchor together is undetectable. The operator quarantine/reconciliation procedure
remains required before C4b. T5 stays approximately 10%; finite completion stays 3/9.
