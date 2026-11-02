# ADR-033: Cookie seed provenance and explicit auth renewal

Status: A4 metadata/diagnostic increment accepted for the approved handoff;
independent review required before merge. Live reseed remains proposed and
disabled until the quiescence, generation and accounting gates below qualify.
Design 2026-11-01.
Related: [ADR-025](025-operator-cookie-handoff.md),
[ADR-027](027-evidence-pass-state-transfer.md),
[ADR-030](030-scoped-page-fetch.md).

## Bounded first increment: metadata and diagnostics

Cookie values remain private evidence, not diagnostics. A versioned cookie-seed
file may contain the existing normalized cookie array plus strict provenance:
source kind, default/incognito/contained/unknown source context, extraction timestamp,
selected domain filters and derived cookie classes. Legacy cookie arrays,
Netscape and DevTools TSV inputs retain their existing strict normalization and
whole-cookie partition refusal/omission. Unknown metadata fields refuse. Source
metadata is an operator claim, never a portability guarantee or authority grant.
The whole private file remains bounded to 1 MiB / 1000 cookies, no-follow on read,
and exclusive mode-0600 creation on export.

Known fingerprint-bound cookie names (`cf_clearance`, `datadome`) produce a
value-free create/status warning that a different browser context may reject
them. Provider-session hints describe independent rotation without promising a
fixed lifetime. Warnings inspect only the required fixed names/domains; they do
not expose cookie values, arbitrary cookie names or storage keys. Cookie classes
are derived from actual imported rows rather than trusted from metadata.
Seeding retains all existing policy, scope and protected-credential floors.

The future `session seed-from-cdp` utility is explicitly an operator-side export
from an already-open, unenforced browser, not the protected login-browser handoff
in ADR-025. It selects a default or explicitly identified incognito context,
attaches only matching page targets, and reads tab-context `Network.getCookies`
for selected URLs before domain filtering. It never reads a profile database,
starts a browser, calls browser-wide Storage cookies as a substitute, or copies
passwords/localStorage/IndexedDB. CDP source access is loopback-only, bounded and
non-redirecting. Values go directly to the private seed file; results contain
counts/path and advisory metadata only. Multiple possible contexts require an
explicit selection. The port is not a protected credential boundary: processes
able to reach it can read its state, as ADR-025 already explains.

## Live reseed activation gates

Renewing cookies in an active session is an identity/authority change. Calling
`addCookies` alone is insufficient: outstanding responses can overwrite the new
jar, and unused prepared actions/approval tokens can retain the old identity's
authority while URL and document stay unchanged. This increment does not silently
relax ADR-025's fresh-context handoff requirements.

Any future reseed route is a separate authenticated human-operator operation,
same-tenant and bound to the exact live context, domains, seed digest and policy.
Ordinary API/agent principals cannot commit it. Before cookie writes it must
exclude new browser input, preserve the old scope's expiry, methods, exclusions,
budget spending, pacing history and ledger/storage limits, and establish network
quiescence or refuse. All asynchronous boundaries revalidate the captured owner.
The ledger durably records authorization before state changes and completion
before success. Historical secret registrations remain for redacting earlier
responses/evidence; new values register before writes/publication. Auth generation
changes invalidate prepared actions, approval grants and action leases even on an
unchanged document. Unknown/partial outcomes are reconciled, never auto-replayed.

An engine must supply a qualified cookie replacement operation with bounded
quiescence/cancellation behavior. If a failure leaves auth state uncertain, the
session cannot resume writes under its old authority. A clone fallback is allowed
only if documented and ledger-linked, preserves accumulated budget/rate/storage
accounting, and never turns renewal into a fresh grant. A new session id is not
permission to reset spent budget or revive an expired/stopped/unrecordable scope.
DOM/editor state cannot be claimed preserved merely by reopening old page URLs.

Rotation detection is advisory: a seeded session's refresh/login bounce followed
by an unauthorized identity response can suggest renewal. It does not infer
identity from DOM appearance, make an automatic login request, modify scope, read
the operator browser automatically or authorize reseeding.

## Validation

The first increment covers fingerprint warnings in create/status without values,
strict metadata/legacy file round trips, malformed/oversized/unknown fields,
partition refusal, private/no-follow files, source-context metadata and provider
warning-domain tests. CDP extraction is not implemented in this increment.
A future extraction implementation must qualify default vs incognito
tab session cookies with receiver-independent canaries and bounded error output.

Live reseed qualification additionally needs same-id auth recovery (or an explicitly
documented accounting-preserving clone), unchanged pages/ledger where claimed,
cross-tenant/API-principal refusal, stale/concurrent context changes, in-flight
request/response races, critical-write failures, old-token/lease invalidation,
retained old/new secret redaction and no replay after transport loss. Live
Vinted/Google verification remains pending operator verification.
