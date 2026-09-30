# T5 J2b: concrete store implementation and qualification packet

Status: J2b.1 ownership/anchor primitive implemented; J2b.2 steps 1 and 2 complete —
step 1: the frozen v1 record schema and the record/CAS/namespace state machine
(`packages/control/src/journal-sqlite-records.ts`) pass the unchanged
storage-neutral conformance over real SQLite storage, with child-hosted restart
durability, storage-sentinel and schema-freeze gates; step 2: the bounded manager,
production storage child (`journal-sqlite-child.ts`) and raw adapter factory
(`journal-sqlite-adapter.ts`) run the full lifecycle over real IPC — one child for
all handles, manager-level second-handle refusal, child self-exit after the last
handle closes, and SIGKILL reacquisition with dead-predecessor fences cleared inside
the acquisition transaction. J2b.3 process-loss matrix rows QUALIFIED (gates in
`scripts/journal-sqlite-adapter-qualification.mjs`, the dedicated journal-gates
CI canary job):
before_commit (kill before COMMIT — nothing persists, clean reopen),
after_commit (kill between DB COMMIT and anchor rename — the DB/anchor mismatch
REFUSES reopen, no auto-repair), after_anchor (kill after the full commit unit
with the caller unresolved — the acknowledged-ready intent reopens as historical
fact), and the caller-timeout rule (timeout neither kills the child nor grants
new ownership). The instrumented crash child scopes its barrier arm to the
faulted method's own dispatch — the adversarial review caught an unscoped arm
hanging generation 1 pre-ready, a test-support bug since fixed. The adversarial
and bounded gates added alongside (second manager acquisition race, concurrent
first initialization, wrong-fingerprint-key refusal, corrupt/truncated database
reopen refusal, dispose under outstanding I/O, bounded DB/WAL/anchor sizes,
child self-exit with a dead adapter reporting uncertain) run in the same
node --test lane under `--test-force-exit`: a failed gate that skips dispose
leaks the storage child's open IPC handle and wedges the runner to the job
timeout — that leak-on-failure was the original canary hang. The gates await
the factory's exposed child-exit promise after graceful close, because the
close reply precedes the child's own TRUNCATE checkpoint and racing it
SIGKILLs the shutdown mid-checkpoint on slower runners. The CI Linux
journal-gates job arbitrated the matrix (16/16 gates, two consecutive green
runs) and is now a blocking CI job. The extracted-package child-resolution
gate (`scripts/journal-sqlite-packaging-gate.mjs`) runs in the same job on
every PR: it packages the untagged server candidate for the runner's target,
extracts it, and runs a real manager/child lifecycle from an unrelated
directory with no `childModulePath` override, asserting the forked child
stays inside the extraction and dies with dispose; release-time per-target
qualification stays with the release gate. Still open before any public
capability:
the remaining adversarial rows — including, at minimum, alias/read-only
paths, stale DB-only/anchor-only copies, malformed/missing and partially
replaced anchors, disk-full and BUSY/IO faults, exhausted-resource bounds,
malformed/duplicate IPC replies, clock movement and the sentinel scan. No public
capability is enabled and nothing is exported from the
control barrel. Read [J2a architecture](t5-journal-sqlite-audit.md) and existing
[journal port](t5-journal-contract.md). Reuse their owners; do not invent a durable executor.

## Current bounded implementation

[J2b.1 evidence](../evidence/t5-journal-sqlite-owner.md) records the internal child-only
owner/anchored-transaction primitive and real process-loss tests. It does not yet provide
a manager or implement RawOperationJournalAdapter. Initialization fixes sequence zero,
reserves the final anchor name exclusively before data initialization, and refuses any
interrupted layout. Mutation callbacks use a revocable SQL facade with no raw connection or statement
handles; authorization denies transaction/PRAGMA/attachment/witness-table changes and
results reuse the bounded journalData snapshot. Retained methods expire before commit.
Two derived rollback locks (store then anchor, busy timeout zero) prevent cloned data
stores from sharing a live anchor. Close checkpoints successfully before closing data
and releasing store then anchor ownership. Each commit syncs the store directory before
anchor replacement, including a newly recreated WAL.

Next J2b.2: compose the bounded child/IPC manager and existing raw port over this owner,
reuse record validation and state semantics, then run unchanged adapter conformance.
Physical resource, clock/key/retention, packaging and remaining crash gates still apply.
Do not export or wire the primitive through the public service as an intermediate step.

## Delivery sequence for the implementing agent

1. Freeze the internal schema, owner-child IPC bounds and DB/anchor commit witness.
   Add failing tests around those boundaries before implementing the optional factory.
2. Implement the existing raw adapter behind that factory and one child process, with
   no eager export, service setting or dependency added unless the audit is reopened.
3. Run `operationJournalAdapterConformance` unchanged using real SQLite storage. Its
   observation side reads through a separate connection/raw SQL; fault hooks belong to
   tests, never the production port. Keep the existing memory fixture as the fast oracle.
4. Add process-loss, anchor, quota and privacy qualification below. Use explicit IPC
   phase barriers, not races against sleeps. Inspect real durable state after process exit.
5. Package/extract the existing server candidate, run from an unrelated directory and
   qualify each claimed runtime/OS. Retain ephemeral acceptance with SQLite unavailable.
6. Only after these gates and adversarial review may C4b implement its one shared
   execution-requirement/discovery contract. J3 historical authorization and J4 recovery
   remain separate; process restart never grants business replay or revives sessions.

No task above requires a second scheduler, protocol, event bus or per-transport journal.
The selected factory/store manager owns one child for all namespace handles, not one
child per `open(namespace)`. Keep a bounded namespace-handle map and IPC correlation map;
reuse existing operation identity/record ownership. The child closes only after the last
handle closes and all actual calls settle. A second handle for a live namespace refuses.

## First implementation schema and ACK requirements

Persist immutable descriptors, HMAC checks, fences, reserved record capacity, complete
keys and canonical records. Preserve all existing revision/CAS semantics, including a
revision-2 undispatched failed terminal. Reuse parse/size validation and canonicalJson;
SQL constraints and indexed fields supplement, rather than redefine, that contract.

Store and external anchor mirror `{formatVersion:1, storeUUID, restoreGeneration,
commitSeq, commitNonce}`. Generate an unpredictable fresh nonce at every metadata/data
mutation; sequence is monotonic and bounded by safe integer range. Refuse exhaustion.
This detects stale pairing; it is not authenticated encryption or hostile tamper proof.
Do not persist keys in the anchor or create another fingerprint algorithm.

Serialize DB transaction and anchor replacement as one raw-call unit. No next mutation
can start while the anchor lags. Bounded retry of the exact same anchor write is allowed
inside that unit while ownership remains valid; no new DB transaction or external effect
is retried. Once the raw call reports uncertainty, seal store mutations. A late syscall
can finish, but cannot upgrade a discarded ACK or reopen the store automatically.

The anchor lives in a separately protected operator-owned location outside DB backup
scope. Its temporary file and final name share a filesystem for atomic rename. Both
parent directories must support the required fsync/rename operations. Initialization
uses exclusive creation; verify UUID/generation on every reopen, never recreate a missing
side of an existing pair. Path checks capture/recheck device, inode and link count, with
nlink=1 for files and private canonical directories; these are local hygiene, not a
security boundary against the same privileged user.

Update clock high-water in mutations and namespace-open/fence transactions only, as
part of the same commit witness. Lookup computes effective time without persisting it.
Use `max(startWall + monotonicElapsed, wallNow, persistedHighWater)` for horizon checks;
refuse detected rollback and a reopen wall clock below persisted high-water. Never
weaken retainUntil for terminal completion. Stale file restore requires the anchor check,
not the clock. Trusted OS time and honest local sync remain stated assumptions.

## Required process-loss matrix

| Forced loss point | Independently required observation | Allowed continuation |
| --- | --- | --- |
| Before first DB/anchor pair fully initialized | Partial pair is refused; no returned handle or admitted identity | Explicit operator investigation; no auto-delete or repair |
| Before intent DB COMMIT | Predecessor or no intent; existing anchor pair still matches | Only future explicit authorization, never inferred retry permission |
| Any DB COMMIT before durable anchor replacement | DB/anchor mismatch or valid previous pair as actually observed | Mismatch refuses reopen; no advancing the anchor to hide ambiguity |
| Anchor fsync/rename/parent-dir fsync completed before intent IPC ACK | Reopen exact acknowledged-ready intent, even if caller timed out | Historical fact only; callback not automatically invoked |
| Intent ACK before business callback | Revision 1 intent retained | Fresh explicit revalidation required by later continuation design |
| Marker anchor complete before effect | Revision 2 dispatched marker, no terminal | Outcome unknown; never replay effect |
| External effect before terminal DB/anchor commit | Marker or mismatch; independent effect counter equals one | Withhold successful terminal output; reconcile separately |
| Terminal anchor complete before response | Exact terminal record retained | Authorized status only; executor never reruns |
| Owner child dies or IPC is severed with unsettled request | Calls become uncertain; confirmed exit releases OS lock | New live dispatch disabled until explicit reopen/reconciliation |

The feasibility script exercises DB-only transactions, not this full two-commit matrix.
Its `phase:commit` IPC message is an out-of-band test barrier, not a raw adapter ACK.
Adapter tests must keep the actual call unresolved while crossing and killing at barriers.
Test parent death too: an orphan storage child must not keep accepting work. A disconnect
seals admission; data I/O either completes under held ownership or ends with confirmed
child exit. Caller timeout alone must not trigger process death or new ownership.

## Adversarial and bounded-resource matrix

- Same-process/different-process double open, distinct namespace handles, concurrent first
  initialization, clean close and SIGKILL reacquisition. Verify stale fences cannot mutate.
- Wrong/missing key, same key ID with different bytes, wrong descriptor/generation, stale
  DB-only and anchor-only copies, malformed/missing anchor and partial anchor replacement.
  Matching rollback of both sides is explicitly outside the detectable threat model.
- Corrupt/truncated/newer-schema DB, symlink/hardlink aliases, read-only filesystem and
  denied directory access. No migration, deletion, fallback-to-memory or leaked paths.
- Deterministic max-page/disk-full, SQLite BUSY and I/O faults before/after commit. Distinguish
  conflict/no-write only with sufficient transaction evidence; otherwise return uncertain.
- Fixed admission/retention boundaries, backward/forward clock movement, exhausted
  namespaces/records/bytes/IPC and maximum terminal records. No accepted identity eviction.
- WAL checkpoint starvation, live readers, repeated updates, anchor-temp growth and repeated
  failure. Independently measure DB/WAL/SHM/anchor/cache bounds. journal_size_limit alone is
  not a hard active-WAL ceiling. Refuse admission before a bounded transaction could exceed
  headroom, and qualify physical accounting before calling the proposed numbers defaults.
- Timeout while child is synchronously blocked, cancellation, shutdown with outstanding
  I/O, malformed/late/duplicate IPC reply and death after a commit. The API heartbeat and
  unrelated ephemeral operations remain responsive; busy/ticket drain follows real settlement.
- Sentinel scan across DB/WAL/anchor/logs proves raw input, private error text, approval
  tokens, credentials and result bodies never persist. Keys stay outside IPC/journal rows.

For a DB-ahead refusal, document an operator quarantine/reconciliation procedure before
C4b. Do not suggest silently using a new operation ID or namespace to bypass uncertainty.
Any retirement must preserve old identity/evidence/key horizons; the absence of a public
repair tool is a real operational gate, not evidence of recovery completeness.

## Runtime, packaging and runner budget

The first candidate lane is Node 24.21.0 on supported local Darwin/Linux filesystems.
Pin SQLite version/compile-option evidence for every qualified runtime build. Node
22.23.2/Bun1.4 feasibility observations do not widen this lane. Node 22.0 requires separate
minimum-runtime ephemeral smoke; unavailable SQLite must fail optional durable admission
without preventing ordinary CLI/service use. No flags that enable global unsafe behavior.

Reuse `scripts/package-server.mjs`, extracted-package acceptance and the four existing
server release targets (Darwin arm64/x64 and Linux arm64/x64). Verify the storage child
is included and resolves paths after extraction without the source checkout. Test directory
fsync/rename and lock semantics on each claimed target filesystem. CLI/MCP Bun builds
must remain free of journal storage code and dependencies; do not add a Bun server lane
because a local API probe passed. Windows is not currently a server artifact target.

Use the existing Linux Test job for the tiny no-install feasibility probe now. Future
adapter conformance/crash tests join that job; do not add an unqualified browser or runtime
matrix. Native release target probes run only for candidate/release qualification or when
runtime/storage changes justify them. Complete local tests and exact-head review before
one PR cycle. A docs-only status update is folded into the next substantive checkpoint.

Stop public enablement if any crash classification, ownership fence, anchor/fsync,
retention, runtime or package gate is unproven. Passing synthetic probes or memory tests
is insufficient. Never promise exactly-once external effects or power-loss guarantees.
