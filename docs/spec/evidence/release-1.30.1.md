# Release 1.30.1 qualification

Status: maintenance candidate; not published. Full checks, independent exact-head
review, protected integration/promotion CI and delivery verification remain gates.

This repairs existing scoped UI redirect behavior before enabling the P0-2 API
probe capability. No new command, scope authority or consent mechanism is exposed.

| Gate | Evidence |
| --- | --- |
| Baseline reproduction | Corrected UTF-8 fixture against 1.30.0: seven failures among 18 cases, including HEAD 301/302/303 changing to GET, DELETE/OPTIONS 301/302 changing method, and DELETE 303→307 restoring its original method/body |
| Receiver qualification | Public service with real Chromium: HEAD, DELETE, OPTIONS and PROPFIND same-origin chains, mixed POST/PUT/DELETE 303→307 chains, independent body length/SHA-256, and 300/304 Location fields that must not redirect |
| Denial qualification | HEAD/DELETE/OPTIONS method, host, rate and budget refusals; no denied receiver hit; exported engagement ledger chain verifies and is sealed; no request body in ledger |
| Composition | Existing worker CSP, header injection, all-hop policy checks, redirect caps and fail-closed target tracking remain required regression checks |
| Pending | Full hooks, independent review, protected PR CI, tag ancestry and package delivery |

The approved [handoff order](../design/t10-bounty-flow-continuity.md) is unchanged:
this is a prerequisite checkpoint within P0-2. The `page fetch` feature remains
disabled in its separate worktree until approval/document binding, bounds,
redaction and no-replay qualification complete. Live program checks remain
pending operator verification. Existing services are not restarted.
