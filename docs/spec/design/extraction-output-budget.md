# Extraction response budgets

Status: implementation candidate after 1.10.1; no release or service restart implied.
Base: develop `124afc3`, including SPA-capture contract alignment (#279–#280).
Scope: shared extraction service plus CLI/SDK/REST and optional MCP adapters.

## Problem and contract

The CLI's ordinary extraction formatter silently cut JSON data at 4,000 characters.
The REST service did not impose that cut. Removing it must not create an unbounded
response contract, and output formatting must not own server resource policy.

`extract --max-bytes N` maps to request `maxBytes` on the existing extraction endpoint.
It is a positive safe integer measured in UTF-8 bytes of the complete compact JSON
result, including evidence, warnings and metadata, after existing redaction. It is
not a character count, record count, input-document limit or a pretty-print limit.
The existing `records.limit` separately caps returned record count.

The startup-only server `extractMaxBytes` ceiling defaults to 1,048,576 bytes (1 MiB).
The binary reads `AGENTBROWSER_EXTRACT_MAX_BYTES` before creating its engine/service.
Omission uses the default; invalid configuration fails startup. Per-request omission
uses that server ceiling. Invalid limits or requests above the ceiling return
`INVALID_REQUEST` before any page read. Callers cannot raise the operator ceiling.

An over-budget result returns HTTP 400 `OUTPUT_TRUNCATED`, `retryable: false`, with
`maxBytes`, `serverMaxBytes`, and `actualBytes` metadata and no partial result. This
reuses the existing output-error taxonomy; it does not slice strings, records,
JSON-LD or evidence. Callers can deliberately increase their request budget within
the ceiling or narrow the extraction. Automatic retry with the same limit is futile.

## Ownership and reuse

- Protocol owns the byte-limit schema, strict numeric parser, decimal CLI/environment
  parser and default. OpenAPI and MCP project the same field schema.
- Service owns one immutable configured ceiling and one final output check for all
  eight existing extraction formats. Existing document reads, source revision/hash,
  extraction functions, redaction and session authority remain their current owners.
- CLI and SDK forward the field. CLI human output prints complete data; `--json`
  prints the complete envelope. Pretty-print whitespace is outside the wire budget.
- No second extraction engine, policy registry, pagination state or dependency is added.

The output cap is not a bound on browser document acquisition, parsing or intermediate
allocation: those happen before final serialization. Streaming/input budgets would
require a separate engine/extraction design. Older services can ignore the new field;
use a matching upgraded CLI/service when relying on server enforcement. Check health
and binary versions before assuming a Homebrew upgrade restarted the active service.

## Qualification and follow-up

Failing-first cases reproduced CLI option absence and ignored HTTP limits.
Regression gates cover full output beyond 4 KiB, exact UTF-8/evidence byte accounting,
all eight formats, invalid and over-ceiling pre-read rejection, startup failure,
default/configured ceilings, SDK/MCP forwarding, and generated schema/catalog freshness.
After rebasing on `124afc3`, 509 focused protocol/API/CLI/SDK/MCP tests pass, including
the incoming capture contracts. Full workspace build/type-check and documentation
link validation pass. Generated OpenAPI and MCP catalog are current.
Normal hooks, independent review and CI are required before merge. This bounded
usability repair does not complete T5 publication or T6 production/live qualification.
