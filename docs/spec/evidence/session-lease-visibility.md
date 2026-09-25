# R5a lease visibility qualification

Scope: unreleased source based on develop `72d1a6e` after 1.11.0. See the
[design](../design/session-lease-visibility.md). This does not change installed
1.11.0 binaries or the preserved live 1.10.0 service.

## Failing-first work and adversarial repairs

Initial coordinator tests failed because inspection was absent; strict wire tests
rejected missing validation. Tests then pinned TTL-at-deadline vs idle-after-deadline,
non-renewing reads, one list sample, detached snapshots and background expiry.
Independent review required additional failing-first regressions:

- Closing and close-failed views must omit active leases. A pending close gets no
  concurrent second close; a settled failed close retains its expiry retry.
- Invalid clock samples after allocation leaked one coordinator session. Captured
  allocation rollback now releases it and partial service state without success metrics.
- An old close could remove a replacement with the same ID. Settlement now checks
  context identity before deleting the map entry.
- Looking up ownership by ID after asynchronous allocation could publish or discard
  a replacement. The reviewer's same-ID substitution test failed on that version;
  `createOwned` now carries the exact context with the response and the test passes.
  The existing coordinator create response remains unchanged through its wrapper.

Final focused qualification covers 71 coordinator tests, 108 API diagnostics,
authority, service-edge and OpenAPI tests, one independent allocation substitution
test, 122 CLI tests, 12 protocol tests and 14 MCP inspection/schema tests. Workspace
build/typecheck and existing artifact/catalog gates pass. Lint has existing warnings.
No runtime dependency, route, capability, lifecycle registry or recovery store is added.

## Real-browser qualification and limits

The existing headed research smoke uses an isolated authenticated service and actual
REST/SDK/CLI/MCP clients. It checks sampled lease facts, unchanged activity during
inspection, bound/unbound inspection and revoked-grant refusal without lease leakage.
It also preserves 13/52 MiB complete extraction, evidence hashes, JSON handling,
cookie sharing/isolation, page cleanup, redirects and controlled operation behavior.
The revoked grant returns the existing HTTP 401 (not a new authorization contract).
Owned service, browser sessions, fixture and files are cleaned up.

These are local synthetic fixtures, not live SEC availability, installed external
harness qualification or production causal evidence. Deadlines are service-session
facts; grants, crashes and policy may end access sooner. R5b close-cause projection,
bounded terminal retention and incarnation-safe event handling remain separate work.
T5 runtime journal/recovery remains gated. Finite milestones stay 3 of 9 complete.
