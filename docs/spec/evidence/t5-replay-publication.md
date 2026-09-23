# T5 A4a2: captured-owner replay publication

Status: internal session/application replay implemented; HTTP adoption pending.
Base: develop `61ad5c1` ([A4a1 #272](https://github.com/anvai-labs/agentbrowser/pull/272)).
Design: [status-publication sequence](../design/t5-status-publication.md).

## Behavior and shared owners

`SessionAuthority.run` accepts an optional seventh `OperationPublication` argument,
separate from the existing finalized-result publisher. `ApplicationAuthority.execute`
accepts the same optional replay publisher as its fifth argument. Both publisher
option sets are snapshotted and validated before admission or application callbacks,
including when the request is fresh and will never use replay output. Existing callers
without the new option keep their original replay behavior.

`SessionControl.begin` remains the sole fingerprint/actor/epoch conflict owner. At its
legitimate replay branch, publication uses the original admitted Entry, frozen principal
and core-provided flat record. The private status-owner fence and scope-exited publisher
are shared with explicit lookup; no fresh lookup by textual IDs can substitute a new
session. The existing bounded publication lifetime, validator and cancellation helper
remain the only deadline/listener implementation. No ticket is acquired, finalized or
finished on behalf of a replay. Status output never masquerades as a terminal result.

Application replay captures the request's existing binding, adapter and scope before
the handoff. Result and replay publishers share a small guarded-output wrapper over
`applicationAccess`, retaining their distinct owner-capture lifetimes. Fresh application
permission is checked before handoff, at guarded output and after settlement. There is
no repeated preparation, consent consumption, effect or receipt callback. A replay
publisher cannot borrow a surrounding execution/read scope.

Failure closes output only. Original execution, pending effects, retained operation
facts and replacement tickets remain independently owned. Publishers must check their
guard at actual output; raw host capabilities are not confined. Observed permission
denial is sticky, but a boolean policy cannot detect an unobserved revoke/regrant.
Snapshots describe capture time, so an in_flight snapshot may arrive after completion.

## Local qualification

24 regression cases were added to the existing publication suites. Against the previous
implementation, 23 failed and the core conflict invariant remained green. All then passed.
An initial nested-scope fixture omitted its fingerprint; correcting that fixture and
rerunning against the baseline confirmed the intended missing-publisher failure.

- 512 control tests pass across 17 files; control type-check and build pass.
- 70 affected API application/coexistence tests pass with no public route adoption.
- Duplicates during execution, abandoned-effect drain and finalized-result publication
  publish only a frozen record, keep the original busy and never call its finish method.
- Conflict ordering, current-agent/takeover, configuring owner, scheduling-gap replacement,
  delayed replacement/review change, mutable options/principal and asynchronous scope
  isolation are covered. Caller execution scope is restored after nested publication.
- Timeout, cancellation, pre-aborted output, callback failure and retained guards refuse
  without changing completed/outcome_unknown facts or releasing active tickets.
- Application tests cover fresh permission denial, binding replacement, authorization
  callbacks replacing/taking over the session, delayed sticky revocation, protected
  replay without repeated consent and invalid settings before a fresh protected write.

Normal hooks, independent exact-head review and PR/post-merge CI remain delivery gates;
this record does not predeclare their completion. No public endpoint, SDK/CLI/MCP
manifest, release or running service changes. T5 remains ~10% foundation progress;
3/9 finite milestones are complete, and journal/recovery guarantees remain unimplemented.

## Next gate

A3 migrates actual HTTP handlers to inert drafts plus guarded publication, including
self-admitted application review and control resume-review. Inventory registered routes
and declared metadata, preserving operator status inspection during delegation. A4b
qualifies replay/error/HEAD/header parity, disconnects and late sends. The HTTP
finalization-ordering probe is still expected to fail until that integration; internal
publication tests alone cannot establish transport safety or restart durability.
