# C2a draft-oracle qualification

Base: develop `d5cef8c` (#242). See the [named contract](../design/t6-draft-oracle.md).
This candidate adds test support and acceptance tests only; production API/SDK/CLI
contracts and installed binaries are unchanged.

## Evidence and owner reuse

The test-only owner first had 19 failing behavioral tests. Its final 28 tests cover
conditional completeness, detached snapshots, received byte hashes, same-size file
replacement, buffer mutation, strict 32 KiB/canonical-base64 bounds, forged fields,
version conflicts, removal fencing and foreign/aborted adapter scopes.

Three transport tests cover bounded raw upload reception, media metadata refusal,
submission-route refusal, a delayed upload after removal and an interrupted request.
The transport captures draft incarnation/version before awaiting bytes. An interrupted
request is observed at the server before disconnecting; partial bytes never commit.
A differently named uploaded file retains its real name instead of synthetic metadata.

Two real Chromium tests drive the compiled CLI over the existing service. A working
hybrid/relocation draft and an intentionally broken remote draft use separate owners
from their equivalent application-interface runs. Both paths share one draft owner
implementation. Assertions read that owner independently of returned service results.
UI field values, checkbox state and fixture DOM status (selection/file metadata and
pending/failed commits) are reconciled with committed state. The file digest comes
from bytes received by the server, not a browser claim.

The broken handler still produces successful browser fill receipts and idle request
counters, but the independent owner detects the missing name and parity fails. API
coverage remains successful. An external edit also makes the UI version stale: the
next visible edit surfaces failed commit state and cannot overwrite the owner.
Application writes use existing operation identities; replay does not increment the
version, stale writes reject and unknown submit operations cannot mutate a draft.

ApplicationAuthority, defineApplicationOperation, canonicalJson, buildServer and
runAgentCli retain their existing ownership. The counter parity fixture already
qualifies general lost-response semantics; this named fixture adds draft/attachment
semantics without creating a generic draft framework, executor, ledger or evidence
registry. No new dependency or CI job is added.

## Limits and delivery

This is a cooperative synthetic application with a bounded native-control contract.
Manual-required/custom/unknown controls and real ATS semantics are unqualified.
No public pre-submit witness or consent binding is delivered: C2b must qualify those
against service-collected evidence; C3 must qualify submission and independent
acceptance. T4 production evidence/binding UX and T5 durable recovery remain open.
Neither a browser digest nor a complete draft is submission consent or acceptance.

Mandatory hooks, independent exact-head review and all PR/post-merge checks gate
integration. Record verified commit/run identities in the PR and next checkpoint.
Published 1.9.1 remains unchanged; no live application was submitted.
