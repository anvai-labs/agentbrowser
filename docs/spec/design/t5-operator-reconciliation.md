# T5: operator quarantine and reconciliation procedure for journal stores

Status: DELIVERED 2026-10-03 (the pre-C4b requirement "document an
operator quarantine/reconciliation procedure" — [J2b
qualification](t5-journal-sqlite-qualification.md), DB-ahead refusal
bullet; [owner evidence "Not yet qualified"](../evidence/t5-journal-sqlite-owner.md)).
Audience: the operator of a deployment running the concrete SQLite
journal store (today: internal, no public durability).

## When this applies

The journal store refuses to open — the manager surfaces a generic
startup failure ("journal storage child exited before ready" today; the
cause is deliberately hidden to avoid leaking storage detail). Refusals
divide into two families:

- **Environment/layout refusals**: wrong directory or file modes (the
  store requires exactly 0o700 directories / 0o600 single-link files
  owned by the service user), symlink or hardlink aliases, nested
  store/anchor directories, a foreign process already holding a store
  live, or sidecar files present at a fresh initialization.
- **Pair refusals**: the two copies of the commit witness — the
  `journal_store` row inside `journal.sqlite` and the external
  `commit.json` anchor in the separate anchor directory — are missing,
  malformed, non-canonical, from different stores, or from different
  commit sequence numbers. A DB-ahead state (the database's commitSeq
  is AHEAD of the anchor's) means a mutation was committed to the
  database whose acknowledgment never completed; an anchor-ahead state
  means an outdated database was paired with a current anchor.

## Invariants — never do these

1. Never create, edit, or "repair" a `commit.json` anchor by hand. The
   anchor is written only by the store, atomically, from the database's
   own witness. A hand-made anchor fabricates an acknowledgment.
2. Never pair files that were not written together. The pair is
   identified by an identical `storeUUID` in both witnesses plus equal
   `commitSeq` and `commitNonce`. Two files from different stores or
   different sequence numbers are an interrupted layout, and matching
   them up is exactly the rollback the refusal exists to prevent.
3. Never reuse a store directory whose namespace IDs have expired. No
   cleanup may make an expired namespace ID reusable; recovery into a
   used directory is a fresh-initialization decision, not a file
   shuffling exercise.
4. Never treat a DB-ahead database as acknowledged. Its extra commits
   were never reported to their callers (an acknowledgment requires the
   anchor sync). Their fate is decided by the callers re-executing
   their operations — process restart never grants business replay.
5. Inspect copies, never originals. All inspection happens on a
   quarantined copy; the original directory is evidence.

## Procedure

**Step 1 — Quarantine.** Copy the ENTIRE store directory and the
ENTIRE anchor directory to a quarantine location (both are small:
bounded DB/WAL plus one ≤1024-byte anchor). Record the original paths,
modes, and file lists first (`ls -la`, `stat`). Touch nothing in the
originals.

**Step 2 — Classify on the copies.** Read both witnesses read-only:

```bash
node -e '
const { DatabaseSync } = require("node:sqlite");
const fs = require("fs");
const anchor = JSON.parse(fs.readFileSync("QUARANTINE/anchor/commit.json", "utf8"));
const db = new DatabaseSync("QUARANTINE/store/journal.sqlite", { readOnly: true });
const stored = JSON.parse(db.prepare("SELECT witness FROM journal_store WHERE id=1").get().witness);
console.log("anchor:", JSON.stringify(anchor));
console.log("db:     ", JSON.stringify(stored));
'
```

Classify by comparing the two objects:

- **Identical** → the pair is consistent; the refusal was an
  environment/layout cause (Step 3a).
- **DB ahead** (`db.commitSeq > anchor.commitSeq`, same `storeUUID` and
  `restoreGeneration`) → unacknowledged mutations may exist (Step 3b).
  A leftover `commit.pending` in the anchor directory is corroborating
  evidence of an interrupted anchor replace — keep it quarantined.
- **Anchor ahead** (`anchor.commitSeq > db.commitSeq`) → an outdated
  database was restored against a current anchor (Step 3c).
- **`storeUUID` or `restoreGeneration` differ** → files from different
  stores were paired (Step 3c).
- **Unreadable/malformed** → corruption or truncation (Step 3c).

**Step 3a — Environment/layout cause.** Restore the exact environment
the store requires: directories 0o700, files 0o600, single-link regular
files owned by the service user, no nested store/anchor directories, no
`-wal`/`-shm`/`-journal` sidecars where the layout forbids them, and no
foreign live owner. Then retry the open. If the pair was identical, no
data decision is needed.

**Step 3b — DB-ahead cause.** The database contains commits whose
callers never received acknowledgments. Reconciliation is conservative
by design: re-initialize a FRESH store (or restore the last known-good
complete pair from backup, if one exists) and have the callers
re-execute their operations. Their intent keys make re-execution a new,
ordinary operation on the recovered store. Preserve the quarantined
DB-ahead database for inspection: it is evidence of what ran, and any
decision to extract its records is a caller-side forensic decision, not
a store operation. Never promote the DB-ahead database by writing it an
anchor.

**Step 3c — Stale-restore, mismatched-pair, or corruption cause.**
Restore the last known-good COMPLETE pair (data database + ownership
databases + anchor witness — a partial pair is its own interrupted
layout) into a fresh directory, or fresh-initialize if no backup
exists. Verify per Step 2 that the restored pair's witnesses are
identical before starting the service.

**Step 4 — Verify.** Start the service against the recovered store and
confirm: the open succeeds; the namespaces are in their expected state
(a recovered/fresh store starts empty; a restored store carries its
backup's records); and the calling workflows re-derive their state as
needed. The journal is evidence — reconcile by restore, never by edit.

## What this procedure deliberately does not do

It does not export journal records into business semantics (J3/J4
territory), does not enable durable runtime selection (the F3/C4b
gate), and does not promise recovery of unacknowledged work — only its
honest preservation for caller-side decisions.
