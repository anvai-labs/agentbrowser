# Bulk form-fill orchestration

The agent sends one structured payload. The service owns the serial resolve → act → reobserve → verify loop and returns one report plus a raw HTML artifact reference. This removes per-field agent round trips while keeping each browser write behind the existing action policy and session authority.

## Delivered contract

`POST /v1/sessions/{sessionId}/pages/{pageId}/autofill`, SDK `sessions.autofill`, and MCP `browser_autofill` share the protocol schema. The canonical payload uses top-level `fields`, not `goal.fields`:

```json
{
  "fields": [
    {"match":{"label":"Company name","block":{"id":"previous-employer"}},"value":"Example Ltd"},
    {"match":{"role":"combobox","label":"Source"},"option":{"value":"board"}}
  ],
  "policy":{"onAmbiguous":"fail","onVerifyFail":"retry","maxReobserve":3,"settleMs":250,"timeoutMs":240000}
}
```

For delegated sessions, supply `X-AgentBrowser-Operation-Id` (MCP `operationId`) before dispatch. One admission covers the complete batch. Lost responses require querying the existing operation-status surface; repeating an operation ID cannot resume or repeat its writes. Per-field reports are returned synchronously, not persisted for later recovery. The operation record retains completion/uncertainty status, not a durable copy of the report.

Each receipt has `field` (zero-based payload index), `match`, `resolvedRef` when resolved, `blockIdentity` when captured, `status`, and `verified`. Successful actions also carry `actionId`. `actual` is a redacted excerpt of at most 512 characters, with `actualTruncated`; verification compares the full private native value before redaction or truncation. Statuses are `verified`, `unverified` (explicit `verify: "none"`), `failed`, `uncertain`, `skipped`, and `not_attempted`. HTTP 200 means a report is available: callers must inspect `ok` and each receipt. A partial controlled batch is recorded conservatively as failed or outcome-unknown, never wholly completed.

Fill values may use existing `vault://` references: all are resolved privately before browser I/O, and the resolved values are used for comparison. Select option values remain literal. Missing or oversized resolved values reject the complete request before writes.

The final pass rechecks all previously verified fields: a later input handler can revert an earlier value. `ok` can include deliberately unverified fields; inspect `verified` when proof is required. Receipts establish observed field state, not an application-level commit or acceptance.

The HTML artifact captures whole-page markup through the existing authorized artifact store, without inlining it into the MCP response. It is not secret-redacted and may contain personal information. HTML serialization does not reliably preserve live input properties or custom widget state; verification receipts are the value evidence. Capture failure is explicit in `snapshotError`. This is not an atomic DOM/value snapshot.

## Identity, safety and bounds

- Match `role`, exact `label`, exact `dataAutomationId`, and/or `labelRegex`. The regex field intentionally supports only literals, `.*`, and optional `^`/`$` anchors using linear string matching. General regex syntax is rejected before any I/O.
- A block selects the nearest fieldset by unique `id`, exact direct-legend `label`, or both. All observed block identities must agree; a label unique among only the matching fields is insufficient. No `first` or ordinal fallback is accepted.
- The Playwright adapter captures node and fieldset identities in a private document-scoped WeakMap. Reordering preserves identity; replacement, navigation, changed identity attributes or movement into another fieldset causes refusal. Identity evidence is checked again immediately before action dispatch. DOM identity alone cannot prove business identity when an application recycles a node without changing its observable identity.
- Fresh observations precede every field. Truncated/degraded observations cannot establish uniqueness. Hidden or disabled observed controls are skipped with a receipt; the service does not guess whether a hidden field is a honeypot.
- Writes are serial and happen at most once per field. `onVerifyFail: "retry"` retries observation only. Uncertain dispatch stops the suffix regardless of skip policy. There is no rollback or automatic compensation.
- Payloads contain 1–50 fields; values/options are at most 8192 characters. Internal observations allow 2000 elements and 1 MiB, then refuse truncation. These are acceptance bounds after capture, not bounds on intermediate browser-to-host native-value transfer. `maxReobserve` is 0–5 extra reads; `settleMs` is 0–2000. Defaults are 3 and 250 ms.
- `timeoutMs` is a **cooperative admission budget**, default and maximum 240000 ms. Once exceeded, no new actions, observations or artifact captures start. An already-dispatched engine call must drain before ownership is released. A blocked renderer evaluation can therefore outlive this budget; this is not a hard wall-clock deadline. SDK bulk requests allow a 30-second transport margin and never retry automatically.
- Human takeover revokes remaining actions and response delivery through the existing authority guards. The task does not race a timer against a writer and release the session while that writer is still running.

## Strategy qualification

The internal strategy registry is trusted server code; request payloads cannot register scripts. No new runtime dependency or browser engine is introduced.

| Strategy | Status | Verification contract |
| --- | --- | --- |
| Native text/email/tel/url/search/number input and textarea | Delivered | One native fill, settled property read, final form recheck |
| Native single select | Delivered | Select by option value, settled selected value, final form recheck |
| Password, file input, native multi-select | Refused | Need separate privacy/upload/selection contracts |
| React-select / active-descendant combobox | Refused | Highlight/focus/input text does not prove committed selection; Enter may submit |
| Chip multi-select | Refused | Needs stable chip identity, committed membership and removal evidence |
| Hidden/disabled observed control | Skip with report | No write |
| Adapter without identity/value evidence | Refused before writing that field | No silent browser-engine switch |

The browser-independent orchestrator depends only on observation/action/artifact ports. The current identity/value evidence implementation is qualified on the Playwright adapter. Other engines need equivalent conformance tests before advertising this capability. A native text input used as a custom autocomplete is refused when the observable role/ARIA metadata identifies it as such.

## Co-design decisions and next qualification

1. **Endpoint versus plan:** a dedicated endpoint wraps the existing action and observation primitives. It does not reuse the plan executor's ordinal remapping, and does not add a second transport or session owner. MCP stdio remains a client bridge to the same service admission.
2. **Reusable profiles and mappings:** keep personal values separate from a versioned, declarative field mapping. Submit their materialized structured payload; do not persist personal profiles in this repository. A later mapping format should record site/form version and stable block anchors, then refuse drift before writes.
3. **Widgets without clear/rollback:** report the applied prefix and uncertainty. Automatic undo can itself trigger side effects; compensation requires a separately approved widget-specific contract.
4. **Parallel DOM writes:** not enabled. Disjoint subtrees do not prove independence of event handlers, focus, validation, network effects or the application's state store. Parallelize independent reads only after measuring and bounding them.
5. **Custom widget registry:** qualify native-independent strategies against real widget versions. Each needs a machine-checkable commitment predicate, focus ownership, stable scope, replacement behavior and partial-effect reporting. Do not introduce keyboard guesses to claim broad coverage.
6. **Durable recovery / hard deadlines:** requires a retained bounded job/report store, cancellation semantics and a draining state across service restarts. The existing in-memory operation status is not that store.

Local qualification includes repeated labels, fieldset reorder, moved/replaced nodes, native select verification, post-write normalization, cross-field invalidation, redaction collisions, human takeover, bounded display values and duplicate-operation refusal. A real Chromium fixture is driven through one actual stdio MCP call.

Live acceptance remains: fill and verify CrowdStrike R29506 and Coinbase Core Automation in fewer than four minutes each with zero per-field agent calls. This requires the authorized target sessions/URLs and approved profile/field mapping, plus qualification of the widgets those live forms actually use. The service performs no explicit submit/click/Enter action; page input/change handlers may independently commit effects.
