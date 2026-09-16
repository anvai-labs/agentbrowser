# Mode: scoped bulk forms and applications

Status: native bulk autofill exists; reusable mappings and custom strategies are proposed.
Core applies.

## Job and data

Submit the structured field payload upfront; the service resolves, acts and verifies
serially and returns one report. Load one versioned form mapping and scoped value/vault
references. A resume is one possible private profile, never general agent memory.

## Existing selection rules

Use `browser_autofill` for qualified native text fields/textareas and single selects.
Use explicit bounded plans/actions only for supported work requiring them. Current
custom combobox/chip/password/file/multi-select cases are refused by native autofill;
do not invent a strategy or retry on another backend to claim coverage.

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
