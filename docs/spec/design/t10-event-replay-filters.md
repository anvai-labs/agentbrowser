# T10 P2-8: bounded retained-event filtering

Status: implementation candidate. This independently useful observability slice
can progress while fetch/resource activation is paused. It changes retained-data
reads and client presentation; egress admission, scope/ledger recording and
credential transfer remain outside its authority. Artifact retention and
`authcheck` remain separate P2-8 gates.

## Contract and compatibility

The shared strict selector adds `stream`, `urlRegex`, `method`, `statusClass` and
`failedOnly` to `type`/`since`/`limit`. Unknown fields, incompatible streams/types,
duplicate HTTP fields, noncanonical numbers and nonliteral booleans refuse.
Request predicates imply the request ledger; explicit request/scope diagnostic
types also select that ledger. `failedOnly: false` still selects the new bounded
path. Documented legacy array/object overloads and type-only behavior remain.

Filtered replies include `filter: {version: 1, stream}`. New clients require this
acknowledgment before exposing results: older servers silently ignored unknown
query keys and otherwise looked as though they had filtered. Missing, unsupported
or wrong-stream acknowledgment refuses without a retry or unfiltered fallback.
It contains no private predicate echo and conveys no new access authority.

## Visible facts and ownership

Authenticate and admit the existing read before pattern compilation. Capture the
exact session incarnation and its registered publication generation. Controlled
reads use admitted output authority; an authenticated operator read during human
control is not rejected by a blanket agent-state rule. Revalidate ownership and
control after callbacks and before returning, retaining the HTTP publication
guard. Detached event data is re-redacted before predicates, including values
registered after insertion. Trusted envelope fields and references remain exact;
identifier collisions and publication faults retain fixed fail-closed behavior.

URL predicates see the same HTTP origin/path that is shown, without credentials,
query or fragment. Predicates combine with AND. HTTP classes require an actual
terminal numeric status; passthrough intent and missing status stay unknown.
`failedOnly` accepts recorded failures and completed 4xx/5xx responses. `denied`
requires typed policy evidence, not a target's ordinary 403. Request predicates
omit duplicate scope diagnostics by default; an explicit diagnostic type can
select those records separately.

Native POST/PUT/PATCH terminal outcomes currently reach the engagement ledger
without complete public replay coverage. This slice does not manufacture those
facts or claim complete status observability; that needs a separately qualified
producer change.

## Bounded work and paging

Regex syntax is compiled by pinned `re2js` 2.9.1 in Core, with a 256-byte UTF-8
pattern and 1,024-instruction compiled-program ceiling. It uses the package's
nonbacktracking matcher rather than native JavaScript regex safety heuristics.
Compilation failures return fixed diagnostics without echoing the pattern.
The dependency is pure JavaScript, MIT licensed and compatible with the existing
Node floor; see its [versioned package](https://github.com/le0pard/re2js/blob/2.9.1/package.json)
and [upstream implementation](https://github.com/le0pard/re2js/tree/2.9.1/src).

`JsonLedger.scanPage` snapshots one retained high-water window before callbacks.
Skipped rows advance the cursor; stopping before a row leaves it eligible for the
next page. Never merge sequences from the two ledgers. Default match limit is
200, maximum 1,000. The complete sanitized envelope, acknowledgment and cursor
metadata fit within 256 KiB. Serialize each admitted row once and track bytes
incrementally, including cursor-width changes on skipped rows. An indivisible
oversized match refuses with existing `OUTPUT_TRUNCATED` and
`floor.events.output`, without advancing past the row. Storage and ledger hashes
are unchanged.

## Qualification and delivery boundary

Colocated tests cover strict shared validation, legacy call shapes, old-server
acknowledgment refusal, HTTP query ambiguity, mixed assets/API failures, typed
denials, unknown native status, cursor progress/gaps, exact-fit/overflow and
high-water behavior, post-registration redaction, ownership/revocation and caller
mutation. SDK/CLI/MCP use the same contract; the top-level `events` CLI alias and
`session events` share a handler. Full hooks, separate adversarial review and
protected CI remain required before release. Live checks remain operator work.

Explicit private artifact `--out` copies are the existing durable evidence path.
Cache TTL extension would still be evictable and process-local; it must not be
called a durable pin. Authcheck depends on qualified scoped fetch and must not
substitute a raw transport or DOM login heuristic.
