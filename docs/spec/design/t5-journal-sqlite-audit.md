# T5 J2a: local SQLite feasibility and storage ownership

Status: audit/prototype only, based on develop `e812fbc` (PR #300).
Decision: advance Node's built-in SQLite to the internal adapter qualification packet;
no dependency, adapter, runtime setting or durability capability is enabled here.
Parent: [journal contract](t5-journal-contract.md). Next implementation gates:
[J2b qualification](t5-journal-sqlite-qualification.md). Observations:
[feasibility evidence](../evidence/t5-journal-sqlite-audit.md).
Load these files explicitly for J2; unrelated modes keep their existing context budget.

## Runtime choice and alternatives

The server packages Node JavaScript for Darwin/Linux arm64/x64. Darwin x64 tarballs
are built on arm64 because they currently need no architecture-specific compilation.
CLI/MCP are separate Bun 1.4.0 client binaries; storage belongs only to server control
composition. Source compatibility still says Node >=22.0.0, while CI pins 24.21.0.

| Candidate | Benefit | Cost or blocking evidence | Decision |
| --- | --- | --- | --- |
| Node built-in SQLite | No npm addon/prebuild or added production bytes; runtime owns SQLite | Synchronous API; absent on early Node 22; each runtime bundles a specific SQLite build | First candidate, isolated child process; initially qualify pinned Node 24.21.0 only |
| better-sqlite3 | Established SQLite wrapper with Node prebuilds | Native addon packaging/ABI, fallback builds, cross-architecture release audit; still synchronous | Fallback only if a measured built-in deficiency justifies it |
| sql.js/WASM | Avoids a Node native addon | Default in-memory database plus export needs an additional durable filesystem/locking protocol | Reject for this port's first implementation |
| Bun SQLite server lane | Bun is already used to compile clients | Server is currently Node; a second runtime/store implementation expands qualification | Defer; local compatibility observation is not server support |

The [pinned Node documentation](https://raw.githubusercontent.com/nodejs/node/v24.21.0/doc/api/sqlite.md)
marks SQLite release-candidate, added in Node 22.5 and unflagged in 22.13. DatabaseSync
calls block their calling thread. Node 22.0 therefore cannot satisfy a universal built-in
SQLite requirement. The optional factory must check the qualified runtime/features
before opening files and dynamically load the store implementation. Ordinary ephemeral
startup must not import it. Do not raise the global Node floor or silently fall back.
A Node/Bun upgrade requires recorded SQLite version/compile-option and crash requalification.

[better-sqlite3's upstream documentation](https://raw.githubusercontent.com/WiseLibs/better-sqlite3/master/README.md)
requires supported Node and distributes LTS prebuilds. That does not establish our target
matrix. [sql.js describes](https://raw.githubusercontent.com/sql-js/sql.js/master/README.md)
its default database as memory-backed with import/export. Neither was installed for this audit.

## Reuse and storage process boundary

Keep the existing raw adapter port, facade validation/HMAC, record parsers, authority
owner, pending settlement and operation projections. No copied control state machine,
workflow executor, browser adapter, transport selector or business retry loop.

The future optional implementation lives under `control` behind an explicit factory;
it is not eagerly re-exported by the default runtime entry point. One dedicated child
process per canonical local store owns both SQLite connections and prepared statements.
J2b.1 refines this to three connections: store lock, separate anchor lock, and data,
preventing cloned stores from sharing a live anchor. See the qualification packet.
A thread is not the selected design: process isolation also separates SQLite locks from
unrelated in-process file closes or additional SQLite library copies. The child is an
internal storage worker, not a network service or agent harness.

Use bounded IPC request IDs and response validation. The raw promise settles on the
actual child response or confirmed child exit, never on the facade caller deadline.
The facade remains the sole caller timeout/quarantine owner. Do not respawn or kill a
storage child to simulate successful cancellation. On unexpected child loss, settle
outstanding calls as uncertain, refuse new work, and require explicit reopening and
reconciliation. IPC disconnect without confirmed exit must not release ownership.
Store I/O cannot block the API event loop; the child may still block indefinitely in the
OS, and bounded caller waiting must not pretend that I/O has drained.

## Lifetime ownership and files

Only a trusted local filesystem is in scope; network filesystems and hostile same-user
file replacement are unsupported. Parent directories are private (0700), files 0600,
with canonical paths, symlink/hardlink rejection and device/inode checks before ownership.
Do not unlink or replace live databases, including during backup or cleanup. SQLite's
[locking cautions](https://sqlite.org/howtocorrupt.html) explain why path aliases,
network locks and raw file closes cannot be treated as harmless.

One canonical store directory derives `owner.sqlite` and `journal.sqlite`; callers cannot
supply an independent lock path. Serialize initialization, including concurrent first
open. Acquire the owner DB's rollback-mode `BEGIN EXCLUSIVE` before opening the data DB.
Keep that transaction open for the child lifetime. The data DB uses its own WAL/FULL
transactions. This is cooperative ownership, not access control against another process
that deliberately ignores the protocol. Never steal by PID age, TTL or stale-file deletion.

[SQLite transactions](https://sqlite.org/lang_transaction.html) and
[rollback locking](https://sqlite.org/lockingv3.html) support the proposed lifetime lock;
separate data commits need not release it. A competing process must fail before data access.
Within the sole store owner, allow multiple namespace handles but only one live handle per
namespace. Each open persists a fresh fence; every transition checks namespace and fence
inside its transaction. Bound handles/IPC by the store ceiling, without a second operation
registry. Test-only ownership release must preserve the real fencing contract.

Close order: stop admission, finish actual accepted calls, checkpoint and close data,
then roll back/close the lock connection last. A timeout does not skip these steps. On
process death the OS releases the lock; the successor still validates all durable metadata.

## Database and transaction proposal

Use STRICT tables and parameterized statements. Suggested physical layout (not a new
wire schema): singleton store metadata; immutable namespace descriptor/key-check/fence/
reserved-capacity rows; operation rows keyed by namespace plus all existing JournalKey
components, carrying revision and bounded canonical JournalRecord bytes. Keep existing
parsers as the semantic authority; indexed duplicate columns must agree with stored JSON.
No raw input, credential, approval token, result/report body or executor is stored.

Under `BEGIN IMMEDIATE`, validate fence, full descriptor, clock, quota and predecessor;
apply one CAS transition; update aggregate reserved capacity and store commit sequence;
COMMIT. Return only facts read from the committed result after the external-anchor step
below. Existing exact repeats use current records, not another executor. Namespace
creation/fence updates are durable transactions too. Unknown schema/corrupt content fails
closed; v1 has no auto-migration, delete-and-recreate or eviction of accepted identities.

Set and read back WAL, synchronous=FULL, foreign_keys=ON and bounded busy timeout.
[WAL](https://sqlite.org/wal.html) and [synchronous settings](https://sqlite.org/pragma.html#pragma_synchronous)
explain the commit/checkpoint tradeoff. FULL is required; process-kill tests do not prove
power-loss behavior or that hardware honors sync. On Darwin evaluate fullfsync and
checkpoint_fullfsync explicitly. No client-selectable unsafe PRAGMAs or SQL extensions.

Errors are phase-sensitive. Pre-I/O validation, capacity, fence, horizon and ownership
refusals retain existing static outcomes. Typed CAS conflicts require actual predecessor
facts. After a mutation begins, I/O/full/busy errors are uncertain unless rollback and
same-owner observation prove no change; COMMIT exception or lost IPC acknowledgment is
always uncertain. [SQLite result codes](https://sqlite.org/rescode.html) do not alone prove
whether a transaction committed. Do not log private SQL/error strings or misclassify a
constraint bug as a business conflict.

## Retention, time, keys and restored snapshots

Persist epoch-millisecond horizons and a high-water clock in the same mutation transaction.
Within a process combine wall time with elapsed monotonic time. Refuse new durable work
on detected backward wall-clock movement; never extend a fixed horizon to accommodate it.
On reopen, wall time below the stored high-water mark refuses. Trusted OS time remains an
assumption: a rollback to a point above the last persisted sample can be undetectable.
Forward jumps may expire early. Never derive restart horizons from performance.now().

Keep immutable namespace tombstones after record retirement. J2b initially performs no
record/key deletion or rotation. Require externally provisioned key material and key ID;
reuse the facade's HMAC key check. Missing/wrong key refuses, and keys must remain available
through retainUntil. No transient key generation on reopening or zeroization claim.

An operator-supplied restoreGeneration alone detects declared generation mismatch; it
cannot detect an old same-generation DB snapshot. Before production enablement, require
an external commit anchor outside the store backup/restore scope. Proposed anchor contains
store UUID, generation, format version, monotonic commit sequence and fresh random commit nonce (no key or payload).
Commit order: DB transaction with new sequence/nonce → write private anchor temporary
file → fsync file → atomic rename → fsync anchor directory → acknowledge. Serialize this
with the same owner. Reopen requires exact DB/anchor identity, sequence and nonce match.
Either side ahead, absent anchor, partial initialization or a stale copy refuses; no
automatic repair or rollback. Such refusal can reduce availability after a crash between
commit and anchor, but must not fabricate missing intent or repeat an effect.

Both anchor and store initialization require exclusive creation and directory durability;
J2b must prove this ordering before returning `opened`. The DB-only COMMIT crash exercised by the feasibility script must
refuse reopen in the anchored adapter if the anchor is behind. A crash after both commits
but before IPC ACK must instead reopen at the committed revision. A backup of both DB and anchor
rolled back together is outside the detectable threat model. Live mutation by a privileged
operator is likewise not prevented. J2 does not ship a backup/restore workflow. The anchor
is a proposed integrity prerequisite, not implemented or proven by the feasibility script.

## Proposed bounded profile and stop conditions

Proposed first test profile, to be measured before public enablement: 8 namespaces,
1,000 records/namespace, 16 KiB maximum reserved bytes/record, 8 in-flight calls/namespace,
64 total IPC slots/store, 1,000 ms caller deadline, 30,000 ms finalization allowance,
24-hour admission and 7-day retention from explicit initialization. No unbounded queue.
Physical test ceilings: data DB 256 MiB, WAL 32 MiB, 8 MiB SQLite page cache, owner/anchor
metadata 1 MiB each. These are design targets, not shipped defaults or quota guarantees.

Reserve maximum terminal capacity at intent using existing record-size semantics.
Refuse earlier if physical capacity cannot preserve logical bounds. max_page_count does
not cap WAL; checkpoint and observe WAL before admission, with a maximum-transaction
headroom budget and no long-lived reader. Prove a physical bound under stalled checkpoints
before choosing these numbers. Disk full remains a possible uncertainty, not an assurance
that reserved bytes exist. No cleanup may make an expired namespace ID reusable.

Advance J2b only with the implementation gates in the linked packet. C4b selection,
service configuration, historical recovery and public durability stay closed until real
adapter, failure, packaging and restore-anchor evidence pass. T5 percentage is unchanged.
