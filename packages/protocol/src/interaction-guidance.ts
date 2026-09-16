/** Shared interaction semantics for human help and agent-facing adapters. */
export const INTERACTION_GUIDANCE = Object.freeze({
  snapshot:
    'Read a self-contained page snapshot with current refs. Prefer scoped bulk autofill, ' +
    'where available, for supported native forms; use a snapshot to prepare explicit steps. ' +
    'Degraded or truncated observations cannot establish complete target coverage.',
  plan:
    'Execute explicit ordered steps in one server call. Inspect per-step results and partial ' +
    'effects; command completion does not prove an application commit.',
  action:
    'Act through current element refs. Reobserve stale targets; do not guess selectors or ' +
    'reuse refs after navigation. A completed action does not prove an application commit.',
  uncertainWrite:
    'A timed-out or disconnected write may have executed. Do not blindly retry: reconcile ' +
    'the recorded operation under current authorization before any further write. ' +
    'If no operation record is available, preserve uncertainty and inspect independent outcome evidence.',
});
