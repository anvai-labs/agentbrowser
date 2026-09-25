# AgentBrowser 1.11.0 release checkpoint

Status: preparation, not yet published. Authorized 2026-09-24 after PR #288.
Candidate base: develop `0b1f1da76ed67a8b90d8af7c1a3058b62fab49df`.
Previous release: 1.10.1, protected main `124afc35484225374bfb8739a07b87b2698d03f4`.

## Scope and compatibility

This is a minor release because it adds public extraction request/server budgets,
MCP page provisioning and captured session diagnostics across REST/SDK/CLI/MCP.
It also includes guarded browser/application/review HTTP publication and browser
allocation/close ownership fixes. The private operation journal contract does not
enable a durable store, restart recovery or automatic replay.

CLI/MCP remain Bun binaries; the service ships compiled JavaScript and production
dependencies, with Node 24 in Homebrew. MCP remains optional. The SDK session type
now matches HTTP: engine.capabilities was never returned on these session endpoints.
Remote CDP creates a new context and does not adopt an authenticated profile.
No raw paths, CDP URLs or credentials are projected as launch facts. Session reads
retain per-request authorization; MCP aggregation is not atomic guarded publication.

See the [changelog](../../../CHANGELOG.md#1110---2026-09-24) and
[research smoke evidence](consumer-research-smoke.md).

## Release review and acceptance

Pre-release review identified a stale hard-coded tool count and release uploads that
could overwrite assets pinned by Homebrew. Notes now refer to the complete catalog;
publication fails on duplicate names instead of replacing bytes. Same-tag publication
is not an idempotent overwrite mechanism. Do not force tags or rerun publication to
replace artifacts; a changed release needs a new version.

The existing extracted-package acceptance now qualifies diagnostics, page provisioning,
complete extraction beyond 4 KB and request/startup ceilings with matching compiled
clients. No new workflow job or dependency is added.

Before commit, the 1.11.0 headed research smoke passed for 13/52 MiB fixtures. The
Darwin ARM extracted service plus actual Bun CLI/MCP passed all eleven acceptance
groups on Node 24.21.0 with graceful cleanup. This pre-commit package explicitly has
`dirty: true` and `releaseEvidence: false`; CI and published clean artifacts must still
qualify. Version/artifact checks, release contracts and documentation/context checks
passed. Independent review approved the full develop delta without product-code
blockers; release-only review covered immutability and corrected current plan statuses.
Exact candidate review, normal hooks, PR/main checks, tag ancestry, all release jobs,
published checksums/npm integrity and Homebrew PR/installed acceptance remain gates.
No success is implied by this preparation record. Delivery identities and outcomes
will be appended after they are independently verified.

## Preserved state and remaining plan

The user's dirty root documentation and live browser service are preserved. Acceptance
uses owned isolated services and sessions. Installing binaries does not hot-upgrade a
running service; restart only at an explicit session checkpoint.

R5 lease/close-cause projection follows this release using the existing coordinator and
event owners. T4/T6 production evidence, T5 durable recovery, T7 audit/security and T8
installed external-harness qualification remain open; no milestone percentage changes.
