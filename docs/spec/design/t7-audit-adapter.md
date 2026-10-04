# T7 slice 1: visual audit adapter with baseline/versioned measurements

Status: in progress (slice 1a — the visual measurement adapter). Task
packet: [t7-audit-scope](../tasks/t7-audit-security.md) ("one
accessibility or visual adapter with baseline/versioned measurements").
Dependencies: T3 (complete). The accessibility (axe) alternative is
slice 1b and is deliberately deferred: it needs a page-context
injection surface the engine does not expose yet, while the visual
adapter builds on the existing screenshot-artifact capability.

## Choice and reuse

A **visual adapter** wrapping `pixelmatch` (the specialist pixel
comparison library, whose one dependency is pngjs) and `pngjs` (the PNG
codec, zero dependencies). The packet's prohibitions are honored literally:
no image-comparison library is BUILT — the specialist library is
wrapped; no scanner, rule engine, or bounty executor is added. The
adapter is engine-agnostic: it receives PNG buffers; capturing them is
the caller's job (the existing bounded screenshot artifact capability).

## Module and closure

New package `@agentbrowser/audit`. It is deliberately ABSENT from the
default dependency closures: the cli, mcp-server, and api packages do
not depend on it (a suite row pins this, mirroring the journal-storage
closure discipline). Consumption arrives later with the audit
mode/profile selection slice; this slice delivers the adapter, its
gates, and its storage format.

## Semantics

- `compareVisual(currentPng, baseline, options?)` is PURE: decode both
  PNGs, run pixelmatch at the baseline's color threshold (override
  allowed), and return a verdict: `match` (zero changed pixels),
  `within-threshold` (changed-pixel ratio within the baseline's
  change-ratio limit), `regression` (beyond it), or `dimension-change`
  (explicit re-baseline required — a result with guidance, not a
  crash). A diff PNG artifact is returned for the report adapter. The
  two knobs are deliberately SEPARATE numbers — loosening the per-pixel
  color tolerance (absorbing antialiasing) must not silently permit a
  larger fraction of the page to change.
- Non-PNG input is a typed error (`VisualAuditError`, coded), as are
  invalid thresholds, path-traversing labels, viewport/PNG-dimension
  mismatches, and unsupported manifest versions.
- **Baseline changes are explicit**: `BaselineStore.save` appends a new
  version to a manifest (identity, threshold, capturedAt, image) and
  never overwrites; `compareVisual` never writes. Loading a label
  returns the LATEST version; the manifest retains history.
- Identity (label + viewport) is recorded AND enforced: `save`
  validates the claimed viewport against the actual PNG dimensions, and
  comparing against a dimension-mismatched baseline yields
  `dimension-change`. Labels are strict filename components (no path
  traversal).

## Acceptance gates (synthetic, deterministic)

1. Clean control: comparing an image against its own baseline is
   `match` with zero changed pixels.
2. Seeded defect: a synthetic rectangle drawn over the baseline image
   is a `regression` with changed pixels > 0 and a diff artifact.
3. Threshold semantics: sub-threshold noise is `within-threshold`;
   damage beyond it is a `regression`.
4. Explicit baselines: `compareVisual` never writes; every
   `BaselineStore.save` adds a version; loading returns the latest;
   history is retained.
5. Dimension change: comparing across viewport sizes is a
   `dimension-change` result demanding explicit re-baseline.
6. Format guard: non-PNG input is a typed error.
7. Closure: the default surfaces (cli, mcp-server, api) do not depend
   on the audit package.

## Deliberately out of scope

- Accessibility (axe) injection (slice 1b — needs the injection
  decision), scanner-regression adapters (slice 3), SARIF/report
  templates (slice 4), CLI/MCP wiring, and any live-page capture
  orchestration (callers capture; the adapter measures).
