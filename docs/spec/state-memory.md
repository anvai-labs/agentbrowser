# State, memory and footprint design

Status: target allocation and retention rules. Numerical values below are initial
qualification budgets, not claims about current runtime enforcement or measured savings.

## Four different footprints

Measure separately: model context tokens, bridge/service heap and RSS, installed
dependency size, and external browser/scanner processes. A small tool catalog can
reduce prompt tokens without reducing browser memory. Lazy imports can reduce
startup work without reducing installed packages. Shared browser processes can
reduce RSS while weakening isolation; require an explicit tenant/profile model.

## State ownership and release

| State | Representation and scope | Invalidation / disposal |
| --- | --- | --- |
| Trusted spec modules | Immutable Markdown + manifest ID/hash; selected mode/view | Explicit revision change; do not recursively load links |
| Runtime mode registry | Immutable descriptors and registered IDs | Configuration generation; active runs pin revision |
| Compiled validators | Bounded map keyed by schema/version | Evict only unused entries; avoid one copy per client |
| Authority and operation records | Existing session control and grant maps | Revocation, TTL and documented receipt lifetime |
| Live node/block identity | Engine-private document-scoped WeakMaps | Navigation, replacement, attachment close |
| Observation working set | One bounded base snapshot plus selected diff | Revision mismatch, scope change, expiry |
| Private form values | Scoped vault references; transient resolved values | Operation completion/revocation; no logging or general cache |
| Durable operation metadata | Optional journal port; bounded record/tombstone | Retention horizon enforced together with accepted operation IDs |
| Artifacts | Shared byte store with opaque scoped references | TTL, quota, tenant deletion, explicit retention |
| Harness continuation | Stable typed scope cursor plus separately tracked pending operation IDs | Capability/binding/service generation mismatch |
| User preferences/profile | Explicit opt-in external scoped store | User deletion/expiry; never repository or global prompt memory |

Avoid storing the same full result in a journal, event stream, transcript and artifact
store. Retain one authorized evidence object and reference it. Separate a small
operation-status index from detailed reports. Ephemeral mode explicitly loses records
on restart; it cannot advertise the guarantees of the optional durable store.

## Context loading contract

The proposed [manifest](manifest.json) defines module IDs, hard dependencies, mode
roots, engineering views and budgets. A loader must:

1. Accept a known mode and optional known view/task ID. Default view is `agent`;
   missing/unknown mode is an error, never an automatic all-spec fallback.
   Selecting a task implies the `task` view and validates its allowed modes; reject
   a conflicting explicit view. Task dependencies order implementation; they do not
   recursively load other task packets. Load only the task module's `requires` closure.
2. Resolve core + mode + requested view/task dependency closure with deterministic
   DFS/topological order. Deduplicate by module ID, detect cycles and missing IDs.
3. Allow only manifest-listed local Markdown paths under the spec root. Reject
   absolute paths, traversal and symlinks escaping that root. Do not fetch URLs.
4. Check per-file and total serialized UTF-8 byte budgets before emitting context;
   include framing/metadata overhead. Fail without partial output, especially without
   dropping core or required security instructions to fit a budget.
5. Emit module IDs, content hashes, exact byte count and selected content. Token
   estimates must be labeled estimates; harness-specific tokenizer measurements are
   a separate metric. Hash changes invalidate caches, not grant permissions.
6. Treat missing optional content as absent. Never auto-expand linked historical ADRs,
   source trees, private profiles, evidence artifacts or unrelated mode recipes.

Graph resolution is O(V+E); reading/hash calculation is O(selected bytes). Cache only
trusted immutable content by hash with bounded capacity. Validation of the complete
manifest is an explicit engineering check, not normal per-task prompt loading.

## Runtime working context

Proposed agent context consists of: core invariants, one mode recipe, effective
capability summary, a small run cursor, the current bounded observation, and requested
evidence excerpts. Harness history is not the operation journal. A stable run cursor
includes session/binding generations and schema/capability revision; pending IDs,
last-known status and evidence locators remain adjacent mutable state rather than part
of the cache namespace. Neither contains raw secrets or a reusable bearer token.

Cache keys include tenant/principal scope, mode, binding, service generation and
schema/capability revisions. Observation keys additionally include attachment,
page/document and revision. Invalidate on account switch, grant revocation and mode
change. Cross-session memory retrieval cannot use similarity alone to establish scope.
No vector database is required for deterministic mappings or operation lookup.

The cursor detects an account change only when trusted operator takeover and fresh
delegation create a new binding. If an application account changes inside a live grant,
page/document revision and fresh outcome evidence must invalidate application-specific
memory; the stable binding cursor alone cannot detect it.

Mode switches are explicit, with scope revalidation and removal of stale mode memory.
Do not attempt to erase already-seen data from an existing LLM transcript by merely
hiding a tool. If information separation is required, create a fresh scoped harness
context; revoke old access at the service boundary.

## Budgets and admission

| Proposed context budget | Initial ceiling | Enforcement |
| --- | --- | --- |
| Agent view, including core and mode | 12 KiB | Complete serialized bundle; reject excess |
| Contract view | 48 KiB | Selected shared contracts and grounding |
| Algorithm view | 64 KiB | Selected execution/state/grounding modules |
| Stack view | 64 KiB | Selected architecture/interface/security/state modules |
| Review view | 96 KiB | Explicit engineering review modules |
| Task packet file | 12 KiB maximum | One task, with common protocol referenced |
| Task view including declared inputs | 64 KiB | Core/mode retained; deduplicate shared modules |

These are documentation budgets. Runtime limits come from existing protocol bounds
and the [shared infrastructure design](../shared-session-infrastructure.md), advertised
as effective deployment capabilities. Do not copy those numbers into mode-specific
constants. Reuse one helper per budget domain at its responsible boundary: canonical
input traversal for nested bytes/depth/nodes, observation budgeting for output,
artifact storage for retained bytes, authority for admission, and shared deadline
accounting for elapsed time. Do not combine unrelated domains into a universal helper.

Use monotonic time for live deadlines. Persist explicit expiry policy and wall-clock
metadata only where restart requires it; clock skew/restart must never extend a grant.
Fresh service generations require fresh authorization regardless of retained expiry.
Ordinary JavaScript string disposal does not guarantee physical memory zeroization;
minimize copies/lifetime and use stronger process/storage isolation when required.

For durable mode, use a small storage port and initially one optional local SQLite
adapter with exclusive ownership. Persist intent/dispatch/terminal transitions in
ordered transactions. Keep keyed fingerprints and receipt locators, not full personal
payloads. Disk-full, schema migration, crash recovery, retention and encryption-key
lifecycle need tests before release. Do not add active-active ownership to this slice.

## Footprint qualification

Compare baseline and candidate in fresh processes with the same workflow, engine,
versions and machine. Record cold/warm startup, installed bytes, imported modules,
process tree, RSS/heap, open handles, transmitted schema/output bytes, model tokens
and verified completion. Test application-only startup with browser packages absent.
Repeated mode switches and session churn must reach a bounded retained plateau.
Set improvement targets from this baseline; preserve correctness before claiming savings.
