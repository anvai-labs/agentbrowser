# C2b native form witness qualification

Base: develop `422fb62` (#245). See the
[design](../design/t6-native-form-witness.md). Candidate adds one optional engine
read method and one service-scoped prepared reader. A test-support collector pairs
the existing application-owned draft oracle with bounded native form evidence.
It adds no runtime dependency, public route, CLI/MCP command or alternate authority.

## Failing-first evidence

The collector suite began with 26 failures for the absent helper. A later failing
regression exposed a stable control-to-fieldset swap; trusted initial control/node/
block associations now reject it. The 27 unit cases cover bounded detached snapshots,
identity, exact inventory, state consistency, file evidence, cancellation and revocation.
The service reader's 21 cases qualify admission ownership, method pinning, lifecycle
checks, cancellation, malformed output and read draining.

Five real Chromium tests drive the existing service autofill/check/upload seams into
the cooperative synthetic fixture. They collect a healthy witness and reject broken
UI commits, fieldset swaps, hidden changes, same-name/same-size replacement File bytes,
owner changes, same-URL reload, pending upload and failed commits. All 53 focused API
tests pass; independent submission-attempt counters remain zero.

Engine parsing has 37 tests, including failing-first method-coercion regressions.
Chromium capture has 43 tests, including a failing-first disabled-optgroup regression:
an option's own disabled property does not express its disabled group's state. This
narrow seam therefore rejects option groups. Capture bounds traversal, JSON and file
bytes, hashes actual File data, then compares identity and inventory after hashing.

## Limits and delivery gates

Evidence qualifies only the audited cooperative native fixture without closed shadow
roots. Repeated equal observations do not prove no intermediate ABA changes. Strict
UI/app agreement is not an atomic dispatch fence or hostile-page attestation.
Full-payload review binding and fresh comparison before approval consumption come
next; C3 requires app-owned atomic compare-and-submit and independent acceptance.
T5 owns restart recovery. No live portal or installed harness is newly qualified.

Mandatory full hooks, exact-head independent review, PR CI and post-merge CI remain
delivery gates. Record immutable head/tree/run evidence in the PR and handoff after
verification. T4/T6 remain active, finite completion stays 3/9 and published 1.9.1
is unchanged.
