# ADR-029: Operator-approved live engagement budget increases

Status: Accepted for T10 handoff P1-4 implementation (2026-10-30); independent
review required before merge. Related: [ADR-028](028-operator-asset-scope-amendments.md),
[ADR-006](006-network-egress-policy-ssrf.md).

An authenticated human operator in the owning tenant may increase an existing
finite request budget, including one exhausted by normal page loading. The request
contains a reviewed expected revision and an absolute new limit (positive safe
integer, at most ten million). Ordinary API keys and delegated agents cannot grant
this authority. There is no unlimited-budget conversion and no counter reset.
Concurrent grants serialize with other scope amendments. Pages, cookies, session ID
and the engagement ledger remain intact; previously denied operations are never
replayed automatically.

The service durably records prior/new limits, spent count, revision and configuration
hashes before the new limit is active. The policy checks revision, stop/expiry and
finite increasing limit before and after persistence; the service rechecks the same
context after every await. Authorization and completion are separate critical ledger
records. Persistence failure stops the scope closed. No grant may revive a stopped,
expired, closing, replaced or unledgered session. Spending and pacing that occurred
while persistence was pending are retained. Every host, method, marker, redirect,
outer policy and server ceiling continues to apply. Increasing this explicit ceiling
is an operator grant, not a claim that the grant itself narrows the previous budget.

Traffic fingerprints are bounded observations, never allowlist generation or grants.
They include denied methods by destination class. Tenant-local, in-memory bounded
page-load samples measure attributed request outcomes during successful navigations;
concurrent pages do not contribute to each other's samples. Creation warns when a
finite budget is below five times the historical median for a matching program
host. Samples are advisory, process-local, evictable and may underestimate deferred
SPA traffic. They carry counts only and do not cross tenant boundaries.

Platform presets require explicit selection. They size by subrequests and never
infer permission from a platform name. A published program cap supplied by the
operator can only lower a selected preset's pace; policy still owns the actual cap.
Validation covers stale/concurrent/unauthorized grants, ledger failures, preserved
counts/pages and all denial classes, alongside matrix and tenant-isolation tests.
