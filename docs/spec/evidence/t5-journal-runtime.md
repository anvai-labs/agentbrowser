# T5 J-d: the durable journal wired into the service (evidence)

**Date:** 2026-10-15. **Scope:** C4b runtime wiring.
**Related:**
- [T5 packet](../tasks/t5-durable-recovery.md)
- [SQLite qualification](../design/t5-journal-sqlite-qualification.md)
- [operator reconciliation](../design/t5-operator-reconciliation.md)

## What is wired

- **Configuration owner.** `packages/api/src/journal-config.ts` reads
  `AGENTBROWSER_JOURNAL_DIR`, `_ANCHOR_DIR`, `_KEY_FILE`, `_RESTORE_GENERATION` and `_INITIALIZE`.
  - A partial set aborts startup, naming what is missing.
  - The key comes from a `0600` file holding one `keyId:hex` line (32–64 bytes); a group- or
    world-readable file is refused on POSIX.
  - Errors never echo key material.
- **Startup.** `buildServer` opens the qualified SQLite adapter and one fresh namespace for the
  process before the service exists.
  - Any refusal aborts startup, with no ephemeral fallback, and leaves no storage child running.
  - The journal is closed after `service.shutdown()`, and also if construction fails.
- **Control layer.**
  - `ApplicationAuthority` gains `durableWrites`. Only writes requesting `durable` are journaled.
  - `durable` is refused before any effect when the write cannot be journaled: the option is off,
    no journal is attached, the journal is not open, or the operation is a read.
  - The journal descriptor carries `durable: true`. The intent's live fingerprint is then labeled
    `application-operation:v2-durable`, and the label is part of the retained keyed digest.
  - This closes the J-b obligation.
- **Service.**
  - Durable is advertised in discovery, and accepted by execute, by the public review and by the
    internal submission review, only while the journal is open and its namespace still accepts
    intents. Otherwise `CONTROL_REQUIRED`.
  - The internal path closes the J-b residual of an unapprovable pending durable review.
  - `durableJournalAvailable` is deprecated and has no effect.

## Capacity defaults (`SERVICE_JOURNAL_BOUNDS`)

| Bound | Value | Source |
| --- | ---: | --- |
| `maxRecordBytes` | 16,384 | as qualified |
| `maxInFlight` | 8 | |
| `timeoutMs` | 5,000 | as qualified (IPC plus a durable fsync per call) |
| `maxRecords` | 10,000 per process start | at most about 160 MB reserved |
| `maxNamespaces` | 1,024 | **store-wide constant**, fixed when the store is created |
| Accept window | 7 days | per process start |
| Retention | 30 days more | |

A full namespace or store refuses durable work, or startup; it never evicts.

## Tests (all against the real SQLite store where named)

- `packages/control/src/application-durable-journal.test.ts` (13):
  - the durable label changes the retained fingerprint for the same live digest;
  - a malformed `durable` is refused before I/O;
  - a durable write is journaled intent → dispatch → terminal around exactly one effect;
  - ephemeral writes do no journal I/O;
  - durable is refused without effect in four unavailable states and on a read.
- `packages/api/src/journal-config.test.ts` (19, the last two with a **real store**):
  - configuration parsing and refusals;
  - a fresh namespace per start;
  - refusal of an uninitialized store without `_INITIALIZE`.
- `packages/api/src/application-durable-journal.test.ts` (6, **real store**). The oracle is a
  read-only count of the store's `journal_record` rows:
  - durable is advertised, journaled once, and replayed without a second effect or record;
  - ephemeral leaves zero rows;
  - durable and ephemeral writes under one operation ID conflict;
  - after the journal closes, durable is no longer advertised and is refused with no effect;
  - `buildServer` refuses a partial configuration, and closes the journal with the server so the
    next start acquires the store.
- Full suites: control 807, api 1,517 passed (2 skipped).

## Not in this slice

- Reading records back across a restart: historical lookup is J3, and recovery semantics and
  public durability are J4. Both are proposed and await the J-design document.
- Rotating the namespace in process when the accept window ends (today: restart).
- Process-loss rows with the store wired through the service (J-e).
