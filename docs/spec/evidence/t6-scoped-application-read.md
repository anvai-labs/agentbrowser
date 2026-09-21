# C2b scoped application-read foundation

Base: develop `7f2e533` (#243). See the
[design](../design/t6-scoped-application-read.md). This increment supplies authorized
bounded read data inside an existing admission. It does not yet qualify a complete
payload witness or bind one to operator consent.

## Qualification

Three named-draft integration tests first failed because prepareReadInScope was
absent. They use the actual C2a draft owner/adapter through ApplicationSessions,
without a browser: one operator admission reads complete versioned data and the
server-owned byte digest, detaches returned data, observes a later owner version,
and records no dispatch. Write operations refuse, escaped readers cannot revive,
and identical answers retain distinct draft/source identities.

The control-layer failing-first run recorded 23 failures (12 generic refusal cases
already passed). Final focused coverage has 43 reader tests plus 93 existing
application-authority and 31 receipt-evidence tests, all passing. Tests exercise strict read selection, fresh detached inputs and outputs,
callback provenance and result-envelope validation, revocation/cancellation, reentrant
inspection, scope lifetime and outstanding-read drain. Existing receipt reader and
receipt-evidence tests gate the shared owner extraction. Private callback errors cannot
become authority errors merely because a callback throws a ControlError. Review
added failing regressions for forged arguments to public authority assertions and
pre-aborted reads invoking authorization. Zero-argument wrappers preserve captured
scope; cancellation now refuses before callbacks.

ApplicationAuthority retains the adapter registry and prepared-reader ownership;
SessionAuthority retains admission, cancellation and read tracking; canonicalJson
retains finite JSON bounds. No route, CLI/MCP command, dependency, store or execution
path is added. Prepared receipt semantics remain separate from application read data.

## Remaining work and delivery

Explicit source/contract qualification, draft-to-page correlation, UI commit agreement,
private review projection and fresh witness comparison remain C2b work. A successful
read from the wrong draft is not consent. C3 owns qualified submission and independent
acceptance, and T5 owns restart durability. Trusted read callbacks must be read-only;
the declaration cannot sandbox arbitrary deployment code.

Normal hooks, independent exact-head review and all PR/post-merge checks gate
integration. Record exact commit/run evidence in the PR and next checkpoint.
Published 1.9.1 remains unchanged. No live applications or service restarts.
