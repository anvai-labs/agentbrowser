# Mode: scoped bulk forms and applications

Status: native bulk autofill, named custom strategies and bounded exact-URL mapping
preparation/guarded execution exist. Broader widget and live workflow qualification remain open.
Core applies.

## Job and data

Submit the structured field payload upfront; the service resolves, acts and verifies
serially and returns one report. Use offline `form prepare` to join one versioned mapping with private values, then
pipe its private output to existing `autofill`. Its exact-URL scope preflights all fields
and pins stage identities; initially conditional fields require a separate stage.
Load only that mapping and its scoped value/vault references. A resume is one possible private profile, never general agent memory.

## Existing selection rules

Use the existing bulk autofill surface for qualified native text fields/textareas and
single selects; CLI/REST/SDK and optional MCP share the same service loop. Named
`react-select` and `chip-multiselect` strategies need their qualified evidence; select
the intended strategy explicitly rather than relying on inference from combobox markup.
The native strategies refuse custom widgets, passwords, file inputs and
native multi-selects. Do not infer arbitrary combobox support or retry on another
backend to claim coverage. See [T6](../tasks/t6-widget-strategies.md) for current limits.

Repeated labels require unique stable block identity; no cross-block ordinal fallback.
Read retries do not repeat field writes. Inspect each receipt and final verification;
HTTP 200 and batch `ok` alone cannot establish every field was verified. Raw whole-page
HTML is sensitive and does not reliably preserve native input properties.

## Required outcome and acceptance

Distinguish filled/verified fields from a submitted/accepted application. Submission
is a separate scoped effect; input handlers may already commit changes. Preserve partial
effects and unknown status. A lost response requires operation lookup, not batch replay.
Current receipts/status are not durable report recovery across service restart.

Qualify repeated fieldsets, reorder/replacement, private-value redaction collisions,
cross-field invalidation, takeover and widget commitment. The live under-four-minute
target with zero per-field agent calls remains separate from deterministic CI and
requires the authorized sites, profiles and actual widget support.

Primary packet: T6 for strategies, T5 for durability; retain the native baseline contract.
