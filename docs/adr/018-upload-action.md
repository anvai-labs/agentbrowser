# ADR-018: The `upload` Action — Native File Attachment Without the OS Picker

**Status:** Accepted (implemented 2026-09-10)
**Context:** 2026-09-10
**Related:** [ADR-015](015-cross-package-contract-single-source-of-truth.md)
(SSOT — the action set derives from `DELIVERED_ACTION_TYPES`),
[ADR-013](013-headed-sessions-and-walled-logins.md) (walled logins — the
login stays human, the rest of the flow should not),
[Synthetic input limitations](../synthetic-input-limitations.md)

## Context

The protocol has always reserved `'upload'` in its `ActionType` superset and
the Playwright engine advertised `supportsUploads: true` — with no
implementation. Any flow that attaches a local file (job applications, claims,
support tickets) was impossible through the wire surface: the caller's only
"workaround" was a human doing the upload by hand or raw JS injection, both
of which defeat the product's reason to exist.

The trigger was a live one: re-attaching a resume to eight drafted job
applications required driving the user's personal Chrome as a stopgap because
file inputs were the single missing primitive. Every other step of the flow
(navigate, observe, click, extract) already worked.

Two constraints shaped the design:

- **File inputs are hidden by design.** `<input type=file>` is styled
  invisible on nearly every real page (a styled button/label stands in
  front). Observations exclude hidden elements (ARIA snapshot), so a file
  input usually has **no ref to target**. A targeted-only action would be
  unusable in practice.
- **No JS-eval escape hatch.** The stack deliberately exposes no
  `evaluate` action; native-picker suppression via patched prototypes was
  off the table. Playwright's `setInputFiles` sets the file list through the
  browser's own machinery — no page script, no OS dialog.

## Decision

Deliver `upload` under the long-reserved name, as the seventeenth delivered
action (per [ADR-015](015-cross-package-contract-single-source-of-truth.md),
every surface derives from the one `DELIVERED_ACTION_TYPES` tuple):

```json
{ "action": "upload", "target": { "ref": "e3_7" }, "paths": ["/abs/a.pdf"] }
```

- `paths` is required, 1..n, **absolute** (the server resolves relative
  paths against its own process cwd, which is meaningless to the caller),
  and **replaces** the input's file list (Playwright `setInputFiles`
  semantics — a second `upload` swaps the attachment, it does not append).
- `target` is **optional**. With a ref, the engine binds the observed
  element; the visibility pre-check is skipped for this action (hidden
  inputs are the normal case). Without a ref, the engine addresses
  `input[type=file]` on the page and requires **exactly one** match: zero is
  `TARGET_NOT_FOUND`, more than one is `TARGET_AMBIGUOUS` — ambiguity is
  refused, never guessed.
- **Local paths are validated by `stat` before any page contact.** A missing
  path, or one that is not a regular file (a directory counts), is
  `INVALID_REQUEST` and leaves page and revision untouched; the server
  already reads local files for screenshots/artifacts, so this touches no
  new trust boundary. A targeted `upload` still runs the same-revision
  staleness gates (`resolve()` + binding liveness) as every other targeted
  action — only the visibility pre-check is skipped for it, so a detached
  ref fails `STALE_TARGET` with `remapEligible: true`, not a raw engine
  error.
- **Evidence, not assertion:** the result reports `files: [{name, size}]`
  from the stat'd paths *and* `inputFiles: [names]` read back from the live
  input via a bound handle before the revision bump — the same
  evidence-over-attempt discipline as the remap work.

## What this does not claim

- **No picker bypassing.** Nothing suppresses or fakes the OS file dialog;
  the action never triggers one. Pages whose upload flow requires a real
  drag-and-drop or a non-input widget (e.g. canvas-based uploaders) are out
  of scope.
- **No `isTrusted` change.** The `input`/`change` events the browser fires
  after the file list is set are the same events a human-triggered pick
  produces at the DOM level, but this ADR does not claim pages checking
  event provenance deeper than the file list are satisfied — that remains
  the [synthetic-input](../synthetic-input-limitations.md) domain.
- **Network capture stays unbuilt.** A capture surface was noted during the
  same field work and remains a future candidate, deliberately not smuggled
  in here.
- **Risk classification is unchanged.** `upload` is an ordinary action to
  the approval policy: operators who want a gate add an
  `{action: 'upload'}` rule. It is not auto-classified as
  transaction/destructive — attaching a file is not by itself an
  external side effect (the submit that sends it usually is, and is gated
  as such).

## Consequences

- `supportsUploads: true` is finally true on the Playwright engine; the
  Safari/WebDriver engine returns `ENGINE_UNSUPPORTED` for it until an
  equivalent (WebDriver `Element Send Keys` on file inputs) is implemented.
- Wire, OpenAPI, MCP and SDK derive the new branch automatically from the
  SSOT tuple + schemas; the only hand-written surface text is the CLI
  subcommand and the MCP tool description.
- Reading back `inputFiles` must happen before the revision bump — refs and
  handles die with the bump (the ordering is load-bearing and asserted by
  the engine contract test).
