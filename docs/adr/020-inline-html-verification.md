# ADR-020: Inline HTML Verification via MCP

**Status:** Accepted (2026-09-15)
**Related:** [ADR-009](009-mcp-high-level-tools.md) (the tool catalog),
[ADR-012](012-snapshot-plan-interaction-model.md) (observation model),
[Synthetic input limitations](../synthetic-input-limitations.md)

## Context

The accessibility observation — the surface agents are told to trust — cannot show
every state that matters on real forms:

- A design-system combobox renders its selection as a "chip" inside the control.
  Selected and empty look identical in the a11y output; the value lives only in the
  widget's DOM (`select__single-value`-style containers), and widgets that render
  state as an image (a flag glyph) carry no text at all.
- React-controlled checkboxes frequently serialize no `checked` HTML attribute, so
  even the raw DOM attribute is not proof of state.

Raw page HTML is the ground truth for all of these. The REST surface has had it
since A3 (`POST .../html` + `GET .../artifacts/{id}`), but:

1. The MCP tool catalog had no HTML tool at all, and
2. Artifact responses carry **relative** REST URLs (`/sessions/{sid}/artifacts/{id}`)
   that an MCP-only client cannot resolve — it has no base URL and no HTTP client,
   by design. Screenshot/PDF return the same kind of descriptor, which is fine for
   a human with a browser, and useless for an agent that wants to read bytes.

Two constraints shaped the decision:

- **Redaction.** The HTML endpoint is deliberately NOT secret-redacted: values
  typed into forms ride the HTML verbatim. Any tool exposing it must carry that
  fact as loudly as the REST description does.
- **Untrusted content.** Page HTML is attacker-controllable text heading straight
  into a model's context. The tool must frame it as data, the way `browser_observe`
  already does.

## Decision

Deliver a `browser_html` MCP tool that returns the HTML **inline as text**, not as
an artifact descriptor:

- The handler calls the HTML export and, when the service declines to inline above
  its artifact budget, transparently fetches the stored artifact and uses its bytes.
- The result is bounded by an optional `maxBytes` (default 200000) applied as a
  byte subarray; a torn trailing multibyte character surfaces as U+FFFD and the
  response reports `truncated` with the full `sizeBytes`.
- The response always carries `untrustedContent: true` and a warning that the HTML
  is not secret-redacted and must be treated as data.
- The description states the deliberate deviation from the screenshot/pdf
  descriptor precedent and why.

For parity, the CLI's `page html` command prints the decoded HTML inline under the
same `maxBytes` bound (with `--no-print` keeping the old descriptor behavior), and
`page observe` gains `--continue-from` for resuming truncated observations.

## Consequences

- An agent can close the verification loop on any widget state without leaving the
  MCP surface or shelling out to `curl`.
- Typed form values can now flow into model context through this tool by design;
  the warning and `untrustedContent` framing are the disclosure, and operators who
  need redaction should keep agents off `browser_html` for sensitive destinations
  (the same trade-off the REST endpoint already makes).
- The byte bound keeps a 500 KB page from becoming a 500 KB tool result; callers
  that need everything can raise `maxBytes` deliberately.
