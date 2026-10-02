# T6 slice 3 evidence: frame observation budgets and latency

Measured 2026-10-01, macOS arm64, real Chromium, deterministic local
multi-frame fixture (main page + 4 child frames: two same-origin, one
srcdoc, one nested depth-2). Generator:
`scripts/measure-frame-observation.mjs` (deterministic local servers; no
accounts). Raw samples: see the script's JSON output.

| Surface | Median observe | Max observe | Elements |
| --- | --- | --- | --- |
| Top-level-only baseline (no frames) | 8.5 ms | 11.2 ms | 1 |
| Merged multi-frame observation | 31.2 ms | 33.1 ms | 5 |

Overhead: ~23 ms absolute. This compares a 1-element frameless page
against a 5-element multi-frame page (5 ariaSnapshot calls vs 1), so it
prices the frame-traversal work plus the extra content — not a
same-content delta. Measured on macOS arm64 with a warm engine, 3 runs;
a slower runner scales the absolute numbers but the 5 s default envelope
bounds the worst case. Per-frame capture slices
(`frameSliceMs`) bound the worst case: with the default envelope spent,
remaining frames read as `budget_exceeded` in the coverage block instead
of stalling the observation — pinned by the SnapshotBudget unit gates
(zero-remaining envelopes skip the probe entirely) and the depth-exceeded
coverage gate on real Chromium.

The numbers qualify the traversal's cost shape, not a performance
guarantee: element counts scale with the frames' actual content, and the
service-level observation budget (`budgetObservation`) bounds the final
projection regardless.
