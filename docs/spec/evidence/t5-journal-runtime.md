# T5 J-d: the durable journal wired into the service (evidence)

**Date:** 2026-10-15. **Scope:** C4b runtime wiring.
**Related:**
- [T5 packet](../tasks/t5-durable-recovery.md)
- [SQLite qualification](../design/t5-journal-sqlite-qualification.md)
- [operator reconciliation](../design/t5-operator-reconciliation.md)

## What is wired

- **Configuration owner.** `packages/api/src/journal-config.ts` reads
  `AGENTBROWSER_JOURNAL_DIR`, `_ANCHOR_DIR`, `_KEY_FILE`, `_RESTORE_GENERATION` and
  `_ACCEPT_UNTIL`, plus the optional `_NAMESPACE`, `_MAX_RECORDS` and `_INITIALIZE`.
  - A partial set aborts startup, naming what is missing.
  - The key comes from a `0600` file holding one `keyId:hex` line (32–64 bytes); a group- or
    world-readable file is refused on POSIX.
  - Errors never echo key material.
- **Startup.** `buildServer` opens the qualified SQLite adapter and the configured namespace
  before the service exists.
  - Any refusal aborts startup, with no ephemeral fallback, and leaves no storage child running.
  - The journal is closed after `service.shutdown()`, and also if construction fails.
  - With a journal attached, `shutdown()` first drains in-flight **journaled** runs:
    `SessionAuthority.drain`, bounded at 30 s, refuses new journaled runs. A graceful stop
    therefore leaves no in-doubt record. Non-journaled runs are neither tracked nor refused, so
    deployments without a journal shut down exactly as before.
  - A passed accept horizon starts the server without the journal, with a warning, instead of
    refusing startup.
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
  - **Durable operator-reviewed writes are approvable end to end.** The review selector accepts
    an optional `executionRequirement: 'durable'` and refuses any other value, and approval
    resolution rebuilds the review with it. The test generates, approves and executes once on a
    real store.
  - Gating the internal path on availability closes the J-b residual of an unapprovable pending
    durable review when no journal is open.
  - `durableJournalAvailable` is deprecated and has no effect.

## Namespace and capacity

- **The namespace is stable across restarts,** as the delivered retention design requires
  (tombstones grow with configured namespaces, not traffic). Its descriptor is derived only from
  configuration:
  - `AGENTBROWSER_JOURNAL_NAMESPACE` (default `agentbrowser`) and the key id;
  - the restore generation;
  - `AGENTBROWSER_JOURNAL_ACCEPT_UNTIL`, with retention 30 days beyond it;
  - the bounds.
- **Every start reopens the same namespace.** Records survive, which J3 needs.
- **A changed immutable value under the same name is refused by the store** (`configuration`),
  so startup aborts with a message that says to rotate by configuring a new name. A passed horizon
  aborts startup before the store starts.

| Bound | Value | Source |
| --- | ---: | --- |
| `maxRecordBytes` | 16,384 | as qualified |
| `maxInFlight` | 8 | |
| `timeoutMs` | 5,000 | as qualified |
| `maxRecords` | 10,000 by default | `AGENTBROWSER_JOURNAL_MAX_RECORDS`, up to 1,000,000 |
| `maxNamespaces` | 64 | **store-wide constant**; counts operator rotations, not starts |

A full namespace or store refuses durable work, or startup; it never evicts.

## Tests (all against the real SQLite store where named)

- `packages/control/src/application-durable-journal.test.ts` (17, three of them on `drain`: it
  refuses with its own reason, never waits for non-journaled runs, and is bounded):
  - the journal intent the facade receives is labeled `application-operation:v2-durable` for a
    durable selection and `v1` without it (captured at the facade, so the label is pinned);
  - a malformed `durable` is refused before I/O;
  - a durable write is journaled intent → dispatch → terminal around exactly one effect;
  - ephemeral writes do no journal I/O;
  - durable is refused without effect in four unavailable states and on a read.
- `packages/api/src/journal-config.test.ts` (28, three with a **real store**):
  - configuration parsing and refusals;
  - the same namespace reopened across starts, and a changed horizon refused;
  - a passed horizon refused;
  - refusal of an uninitialized store without `_INITIALIZE`.
- `packages/api/src/application-durable-journal.test.ts` (10, **real store**). The oracle is a
  read-only count of the store's `journal_record` rows:
  - durable is advertised, journaled once, and replayed without a second effect or record;
  - records survive a restart, which reopens the same namespace;
  - ephemeral leaves zero rows;
  - durable and ephemeral writes under one operation ID conflict;
  - after the journal closes, durable is no longer advertised and is refused with no effect;
  - the same happens once the accept horizon passes;
  - a graceful shutdown during a slow durable write ends with a terminal record (revision 3), and
    draining refuses new work;
  - `buildServer` starts without the journal, warning, past the horizon;
  - `buildServer` refuses a partial configuration, and closes the journal with the server so the
    next start acquires the store.
- `packages/api/src/application-submit-consent.test.ts`:
  - durable generate → approve → execute once on a real store, with one journal row; the
    selector change is pinned (the test fails without it);
  - the internal submission review refuses durable without an open journal.
- Full suites: control 808; api 1,531 passed (2 skipped); cli 321. On a heavily loaded host
  (load average ~25 from unrelated work) one real-Chromium test at a time can miss its polling
  bound. Each passes in isolation. `application-draft-parity`'s 1 s default poll is now bounded
  at 15 s.

**Recorded residuals:**
- "Refused before any effect" and "effect may have happened" share `CONTROL_REQUIRED` and differ
  only in the message. Distinguishing them is a protocol change, deferred to J4.
- The control-layer `journalOpen` check and the service execute gate are defence in depth: the
  intent reservation already refuses first, so no mutation of either changes an outcome.

## Not in this slice

- Reading records back across a restart: historical lookup is J3, and recovery semantics and
  public durability are J4. Both are proposed and await the J-design document.
- Automatic namespace rotation (today: the operator configures a new name and horizon).
- Process-loss rows with the store wired through the service (J-e).

## J-e: process loss through the service (2026-10-15)

`packages/api/src/journal-process-loss.test.ts` runs the compiled service in a child process,
with the real SQLite journal and an application whose effect appends to an fsynced counter file.
The child is **SIGKILLed** at each boundary of one durable write. The oracles are the store's
`journal_record` rows (read-only) and the counter.

| Killed | Stored record | Effects | Classification |
| --- | --- | ---: | --- |
| before the intent | none | 0 | `scoped_absent` |
| after the dispatch marker, before the effect | rev 2, dispatched, no terminal | 0 | in doubt |
| after the effect, before the terminal | rev 2, dispatched, no terminal | **1** | in doubt |
| after the terminal, before the response | rev 3, `completed` | 1 | completed |
| not killed | rev 3, `completed` | 1 | completed |

- **After every kill,** a new process (no initialize) reopens the **same** namespace. The dead
  owner's fence is cleared by the store's exclusive lock, so this works.
- **Reopening replays nothing:** rows and the effect count are unchanged. The effect never runs
  twice.
- **"Before the intent" and "after the marker" both leave no effect.** They are distinguished by
  the store: absent versus in doubt.
- **Keys:** replacing the key material under the same key id (key loss), or keeping the material
  under a new key id for the same namespace (rotation in place), refuses startup as a
  `configuration` mismatch. No key material appears in the error, and the namespace and its rows
  are untouched. Rotation is done by configuring a new namespace.
- **Stability:** three consecutive runs pass, 7/7 each.

Still not covered here (J4): a cursor from before a restart failing as session-not-found, and the
operator classification surface (J3).

