# T5 J2a: SQLite feasibility evidence

Base: develop `e812fbc` (PR #300). Date: 2026-09-25.
Status: merged as PR #301 at `83b747b`; clean exact-head review and pre/post-merge
CI 8/8 green. No concrete adapter implemented by this audit.
Design: [runtime and ownership audit](../design/t5-journal-sqlite-audit.md).
Next: [real adapter qualification](../design/t5-journal-sqlite-qualification.md).

## Reproducible mechanism probe

Run `node scripts/probe-journal-sqlite.mjs` with the selected runtime. It imports only
runtime built-ins, creates its own temporary directory and synthetic SQLite tables,
uses explicit IPC phase barriers, then removes only its owned files after children exit.
No service, credential, user database, browser or package installation is needed.
The same probe runs once in the existing Linux CI Test job, not a new runner matrix.

| Runtime | OS/architecture | SQLite | Result |
| --- | --- | --- | --- |
| Node 24.21.0 | Darwin/arm64 | 3.53.4 | Seven mechanism checks pass |
| Node 22.23.2 | Darwin/arm64 | 3.53.4 | Seven mechanism checks pass; experimental warning |
| Bun 1.4.0 | Darwin/arm64 | 3.51.0 | Seven mechanism checks pass; not a supported server lane |

The checks cover independent observation while the lifetime lock is held,
competing-process refusal, COMMIT-before-application-ACK persistence after SIGKILL,
uncommitted rollback, parent heartbeat during synthetic child blocking, parent IPC
disconnect cleanup, and reacquisition after clean/process-loss closure. The successor
acquires the owner lock before its first data recovery. Owner processes query back both
journal modes and synchronous=FULL. SQLite compile-option digests are in the JSON report.
The heartbeat is process-isolation evidence, not an fsync benchmark or adapter latency proof.

Retained SHA-256 of sorted SQLite compile options:

- Node v24.21.0: `99d80fee03818112b412ae76c1b334602ab6b6de6899610155a90a043ed5bbbc`.
- Node v22.23.2: `99d80fee03818112b412ae76c1b334602ab6b6de6899610155a90a043ed5bbbc`.
- Bun 1.4.0: `f3f2e3b3edb0fde2a1d61f601f2af198f20aa9be1208c29426e548afa483e403`.

Removing BEGIN EXCLUSIVE in a temporary negative-control copy caused the contender to
report ownership instead of BUSY and the assertion failed (exit 1). This demonstrates
falsifiability; the negative copy is not a production mode or a second committed helper.
Probe development also caught closed-connection inspection and post-disconnect `close`
event waiting errors. The final probe waits for confirmed process `exit` (with spawn
errors observed), has no piped output to drain, and exits nonzero if cleanup cannot prove
settlement. Those probe defects are not product regressions or failing-first adapter tests.

With Node 24.21.0 `--no-experimental-sqlite`, the probe failed before creating its directory
with ERR_UNKNOWN_BUILTIN_MODULE. The existing application acceptance script, loading
built control under the same flag, exited 0. This proves current ephemeral composition
does not need SQLite. It does not substitute for running Node 22.0 or a packaged adapter.
Bun's reported Node compatibility version is not a Node runtime qualification.
No addon/WASM alternative was installed.

## Decisions and limits

Proceed with a Node built-in prototype in one dedicated storage child, preserving the
existing raw port, facade, authority and transport owners. Public qualification initially
targets pinned Node 24.21.0, subject to all remaining gates; this packet does not enable it.
The separate rollback-lock/WAL-data mechanism needs no new npm runtime dependency.

The probe has no journal records, CAS/fences, key/retention enforcement, anchor, actual
adapter ACK or external business effect. It therefore does not run the 17-case adapter
conformance suite or prove recovery. Its DB-only kill-after-COMMIT case deliberately lacks
the external anchor: the anchored design must refuse if DB and anchor differ, and needs
a distinct successful reopen test after the anchor is durable but before IPC ACK.

The design specifies a separately stored commit witness to detect stale DB-only copies;
restoring both DB and anchor together remains undetectable. Initialization, two-commit
crash behavior, filesystem/physical bounds and an operator reconciliation procedure remain
implementation gates. Local APFS/POSIX observations do not qualify Linux, Darwin x64,
other filesystems, server packaging, disk-full/corruption, power loss or public durability.
T5 remains approximately 10%; finite roadmap completion remains 3/9 (33%).
