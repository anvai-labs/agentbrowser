# T0 foundation implementation evidence

Optional historical evidence; not part of the default task-context dependency closure.
Read the [active packet](../tasks/t0-contract-catalog.md) for current scope and next steps.

## First increment: shared guidance and CLI discovery

Implementation branch: `feat/foundation-discovery`, based on develop
`01ad4977e177a62ce981920ab5c6d13180b5afe2`. This is a local candidate, not a release.
The original design baseline remains the 1.8.17 checkout; develop still carries its
own 1.8.16 version stamp. This increment does not bump product versions.

- Protocol owns shared interaction/reconciliation guidance, re-exported through SDK.
  CLI and MCP consume the same strings; execution and policy ownership remain unchanged.
- CLI `describe [path...]` projects existing Commander definitions as shallow JSON,
  offline. It includes argument/flag metadata and never reflects parsed credentials.
  No new command registry, runtime dependency, session owner or executor was introduced.
- Existing built-artifact acceptance now verifies a real CLI discovery invocation.
  Eight new focused regression cases cover discovery and MCP guidance, including
  enumeration of every advertised command and implicit help.
- The [CLI agent guide](../../cli-agent-usage.md) describes Bash/jq usage, current
  result/exit-code semantics, operation reconciliation and remaining CLI gaps.

At the end of the first increment, T0 still needed canonical JSON request-schema
discovery, bounded file/stdin payloads, bulk CLI exposure, generated MCP documentation
and structured output contracts. See the reconciled second increment below.
Do not mark all of T0 complete from this metadata/discovery increment.

Local validation for this increment:

- Red/green: seven discovery cases and one MCP-guidance case failed before their
  fixes and passed afterward. The advertised-command traversal also caught implicit help.
- Protocol 126, SDK 47, CLI 58 and MCP 58 tests passed: 289 affected-suite tests total.
  SDK loopback fixtures initially hit sandbox EPERM; they passed with local socket access.
- Workspace build/type-check, changed-source Biome checks and documentation links passed.
- `pnpm release:artifacts` passed the actual Node CLI discovery and MCP catalog checks.
  The compiled Bun CLI also passed offline nested discovery, credential non-reflection,
  implicit help and unknown-command negative controls with an unreachable service URL.
- Both executables emitted 4,492 bytes for the shallow root catalog and 3,397 bytes for
  `describe act press`. These measure output bytes, not model tokens or runtime RSS.

This candidate has not been committed, pushed, merged or released. No GitHub CI run
was triggered for these local checks. Follow the task protocol for later delivery.


## Second increment: reconcile released CLI and bound its shared input

Rebased onto develop `2144455` (#177); #178 released the CLI parity batch on main as
1.8.18 (`c728f97`). Develop still stamps 1.8.16; no version bump was added here. The
pre-rebase local candidate is retained in stash `bb41ee8c07c0cbcc67e7b8dcec4f6e4cb1ab9399`.
Resolved README and CLI conflicts by preserving upstream commands and local guidance;
all original modular-spec files were restored. No force push or remote mutation occurred.

- Reused the **existing** autofill command, SDK method and canonical validator. Removed
  its handwritten report/request types in favor of the protocol types via SDK exports.
- Replaced synchronous unbounded JSON reading with one CLI helper shared by autofill,
  its policy override and plan. Existing inline/`@file`/`-` syntax remains valid. Inputs
  are limited to 1 MiB each, streamed reads to 30 seconds, and stdin to one consumer.
  File open/metadata operations are not a hard filesystem deadline; local files are advised.
- Invalid UTF-8 and non-regular files fail locally; parse and I/O errors do not echo
  private payloads. No new dependency, executor, retry loop or authority owner was added.
- `describe autofill --schema` emits existing canonical request/report schemas on demand;
  other commands return null instead of invented contracts. Semantic validators still
  enforce invariants beyond the JSON schema. This is not full command-schema coverage.
- Autofill/plan `ok: false` now returns exit 1 while preserving JSON reports. Successful
  handling does not prove verification or application commit. This shell behavior change
  and private file/stdin usage are described in the CLI guide.

Remaining T0 work: generated MCP catalog documentation, qualified structured MCP
results/output contracts and broader canonical command-schema coverage. Publication
metadata is conditional on selecting publication. T1 and later tasks remain unstarted.

Validation for the second increment:

- Added 17 focused CLI/reader regressions. Before implementation, selected schema and
  private-error assertions failed; exercising the old synchronous stdin reader also
  blocked the test workers, which were stopped. The final CLI suite passed 94 tests.
- `pnpm --filter @agentbrowser/protocol test`: 126 passed; SDK: 50 passed; MCP: 58
  passed. Total affected suites: 328 passing. SDK HTTP fixtures required local socket
  permission after sandbox EPERM; the permitted rerun passed.
- `pnpm -r build`, `pnpm -r type-check`, targeted Biome, `git diff --check`, and
  `node scripts/check-doc-links.mjs` passed (374 links / 109 Markdown files).
- `pnpm release:artifacts` passed, including actual CLI nested schema checks and the
  MCP stdio catalog. `pnpm --filter @agentbrowser/cli compile` passed.
- Actual Node and compiled Bun CLI probes against a local HTTP fixture passed for
  file/stdin payloads, operation-ID/auth headers, one request per invocation, failed
  receipt preservation/nonzero exit, oversized/invalid-UTF-8/private-JSON rejection
  before dispatch, and offline schema discovery with unreachable service URL. Expanded
  autofill discovery was 13,381 bytes on both executables. This qualifies CLI transport,
  not new browser/widget behavior; no executor changed.
- Compared all 34 previously untracked files against the backup: none missing; only
  this task record and the CLI guide intentionally differ. Reviewed the merged CLI
  delta against develop to retain upstream parity additions.

This remains a local, uncommitted candidate. No push, PR, CI run, merge or release was
performed for these changes. The backup stash is retained. Independent adversarial
review of this increment has not been performed. Continue remaining T0 work before
claiming full task completion.

## Third increment: generated MCP catalogs and negotiated autofill output

The existing tool factory remains the only catalog owner. `scripts/mcp-catalog-docs.mjs`
queries built `tools/list` responses for unbound and delegated bindings without service
access, generates `docs/mcp-tool-catalog.md`, and checks drift. A digest covers full
schemas/descriptions even when summary rows do not change. Package documentation now
links to that generated catalog instead of maintaining another tool table.

Protocol owns the existing autofill report shape, now identified by
`urn:agentbrowser:autofill-report:v1`, and its reusable output validator. MCP consumes
that schema and validator directly. Invalid upstream reports return sanitized text
errors stating that the mutation may have executed; they are never blindly retried.
No new runtime package, dependency, browser executor or authority owner was added.

Compatibility decisions:

- Support MCP 2024-11-05 and 2025-06-18. Explicit legacy clients retain text results and
  catalogs without modern fields. Unknown requested versions receive the latest
  supported version, 2025-06-18; clients must accept it or disconnect. Missing
  initialization retains historical text behavior, not a recommended client lifecycle.
- Negotiation is per connection and cannot be repeated to switch formats while calls
  run. Modern autofill results include both validated structuredContent and equivalent
  serialized JSON text. Other tools retain text; no output contracts were invented.
- Autofill is explicitly marked mutating and non-idempotent. Hints do not grant access.
  Delegated session binding and required operation IDs still apply to modern calls.
- Failed autofill/plan reports now set isError=true under both protocols while keeping
  receipt/result JSON. This deliberate error-signaling change from 1.8.18 is documented.
  A successful unverified receipt is not promoted to verified; errors without valid
  reports stay text-only. Unbound error guidance points to SDK/REST operation status.

The implementation follows the MCP [tools specification](https://modelcontextprotocol.io/specification/2025-06-18/server/tools)
and [version negotiation](https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle).
This is stdio qualification, not a claim to implement a newer HTTP transport or to
qualify installed Victor/Codex/Claude structured-result consumption. Those remain T8.

Validation:

- Seven new MCP assertions and two smoke negative-control cases failed before their
  fixes and passed afterward. Protocol report-shape/privacy coverage was added too.
- Protocol: 130 passing; MCP: 68; CLI: 94; existing API autofill/closed-loop/service and
  actual Chromium stdio suites: 14. Node catalog/release-smoke regression suites: 20.
  Workspace build/type-check, changed-source Biome and Markdown links passed.
- The existing release-artifact gate now checks generated catalog drift, its two
  regression controls, and actual Node stdio contracts through an owned HTTP fixture.
  The same shared checkMcpContracts helper passed against compiled Bun; no second
  executable harness was introduced. It checks both binding modes and both protocol
  versions, nested schemas, mutation hints, credential/operation propagation, exactly
  one write dispatch, unverified/failed receipts, and invalid-report privacy.
- The real Chromium fixture validates actual server receipts through the legacy
  transport. Modern/legacy serialization equivalence is additionally tested with the
  bounded executable harness and HTTP fixture. These are distinct evidence boundaries.
- Local sockets initially required sandbox permission; permitted runs passed. No
  GitHub runner or additional CI job was used. Existing release gates consume the new
  checks automatically; this is not evidence of a remote green CI run.

Catalog bytes measured as compact JSON tools/list result objects (Node and Bun agree):

| Protocol | Unbound | Delegated |
| --- | ---: | ---: |
| 2024-11-05 | 19,374 | 16,765 |
| 2025-06-18 | 21,298 | 18,689 |

The modern fields add 1,924 bytes per catalog. This measures serialized bytes, not model
tokens or RSS. No per-mode runtime loader is implemented yet; T1 remains unstarted.

T0 remains active for broader canonical request/output coverage and delivery/review.
Publication metadata remains conditional on selecting publication. This increment is
local and uncommitted; it has not been independently reviewed, pushed, merged or released.

Context-budget review moved historical evidence out of the active T0 packet after it
exceeded the 12,288-byte module cap. The active packet is now 4,459 bytes; this optional
record is not in the manifest dependency closure. All 30 modules and 82 valid selections
fit their budgets with a conservative framing allowance, and mode isolation holds.
Documentation links passed: 380 links across 111 Markdown files.

Live GitHub verification during this increment confirmed main at 1.8.18, commit
`c728f9722ab5a07c1a658c7c17d3f232915700a6`. That released state does not include these
uncommitted foundation additions.
