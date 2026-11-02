# Release 1.31.0 qualification

Status: independently reviewed minor candidate. Required hooks, protected CI,
promotion and package delivery remain gates. This record does not claim publication.

This checkpoint adds bounded retained-event filters and A4 cookie metadata on the
released 1.30.3 foundation. It advances independently useful reads and private file
handling while scoped fetch/resource activation remains paused. It does not mark
the complete bounty handoff or P2-8 retention/authcheck work done.

| Area | Qualification |
| --- | --- |
| Baseline | Reconciled develop `b2ac5d374cd632093fb0f35ed3b1d717b8c44d38`, released 1.30.3 tree |
| Shared selector | Detached strict fields, request/other stream consistency, duplicate/noncanonical HTTP refusal and acknowledgment validation |
| Matching | Bounded RE2 syntax, actual terminal status and typed policy-denial facts; AND predicates after captured-owner re-redaction |
| Paging | One retained snapshot, skipped-row cursor progress, stop-before overflow, row/count and complete UTF-8 envelope limits |
| Compatibility | Legacy overloads retained; new clients require matching filter acknowledgment with no retry or unfiltered fallback |
| A4 metadata | Fixed value-free provider hints, exact-owner cleanup, strict versioned envelopes, derived cookie classes and existing private/no-follow/partition refusal behavior |
| Independent review | Exact 58-file candidate manifest `dc5bffe0c1ac76873afb3c407eaee5a1ec9070184ab6dfea6b38fab509fbd039` reviewed clean; 226 independent pure tests passed across protocol/Core/SDK/CLI/API/MCP. Canonical 1.30.3 seed, recorder, publication and observation fences verified unchanged |
| Combined local checks | All 19 workspace builds and strict lint passed; generated catalog/version checks passed; 1,265 relative links, strict MkDocs, 10 brand tests and 12 context tests (including all CRLF selections) passed without raising context budgets |
| Integration follow-up | Full hooks caught a stale generated OpenAPI artifact and an old bare-string error assertion. Regenerated the catalog and kept HTTP 400 while asserting the standard `INVALID_REQUEST` code and fixed paging guidance; all 106 focused API regressions passed. The full hook is rerun after these corrections |
| Remaining gates | Required commit/push hooks, protected source/promotion CI, tag ancestry and immutable registry/tap delivery |

See the [event contract](../design/t10-event-replay-filters.md),
[A4 decision](../../adr/033-cookie-seed-provenance-and-reseed.md) and
[operations guide](../../operations.md).

Native POST/PUT/PATCH terminal outcomes do not yet have complete public replay
coverage; the engagement ledger remains their evidence path. Cookie provenance
is advisory and supplies no authority or login-portability proof. Live reseed,
automated CDP extraction, resource-host activation, submit and authcheck remain
separate gates. No live program traffic or user service/profile change qualifies
this candidate.
