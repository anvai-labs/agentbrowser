# TD-BROWSER-14: Compact identifiers and explicit CLI context

**Status:** Planned (target 1.18.0)
**Decision:** [ADR-022](../adr/022-compact-identifiers-and-cli-context.md)

## Problem

Session and page ids are repeated in nearly every agent call, and today they are long:
`ses_1791848997803_v4uqd61ry` (27 characters) and `pg_17_page-0` (12; about 47 under Firefox,
whose engine page id is a UUID). See ADR-022 for the analysis and the decision. This TD is the
plan.

## Phases

Each phase is its own PR with its own adversarial review. Phase 1 must land before phase 2.

### Phase 1: key pages by session (no visible change)

- **Change:** re-key `AgentBrowserService.pages` (`packages/api/src/service.ts`) from `pageId`
  to `(sessionId, pageId)`. Audit every `pages.get/set/has/delete` site, and every path that
  takes a `pageId`, for session-scope checks, including popups, delegated sessions, the snapshot
  and plan paths, MCP tools and event replay.
- **Tests:**
  - Two sessions whose pages share an id: every page-addressed route and tool refuses
    cross-session access with `PAGE_NOT_FOUND` / `SESSION_NOT_FOUND` semantics, never another
    session's page.
  - The existing id formats keep passing unchanged.

### Phase 2: compact formats

- **Session ids:** `ses_` + 8 lowercase Crockford base32 characters from `crypto.randomInt`. A
  new id is checked against live sessions and journal entries and regenerated on collision.
  Contract test: the `^ses_` schema pattern still holds.
- **Page ids:** a per-session monotonic `p<n>`, never reused after close. The engine page id is
  kept internally and dropped from the public id. Popups take the next ordinal.
- **Tests:**
  - Ordinals are not reused after close: a stale id gets an error, not the new page.
  - Ids are unique across 1M generated sessions, using a seeded generator.
  - FakeEngine and engine-playwright contract suites pass.
- **Measure:** bytes and tokens per call on the benchmark transcripts, before and after, as
  release evidence.

### Phase 3: explicit CLI context

- **Precedence:** explicit arguments, then `AGENTBROWSER_SESSION`/`AGENTBROWSER_PAGE`, then the
  context from `agentbrowser use <session> [page]`.
  - The context is stored per base URL in the user's state directory, written atomically.
  - `agentbrowser which` shows the resolved context and its source; `agentbrowser unuse` clears
    it.
- **Errors, never fallback:** a context naming a closed session or page fails. A page may be
  omitted only for an explicitly identified session with exactly one page; otherwise the command
  fails as ambiguous. The CLI never infers "the only open session" (ADR-022).
- **MCP:** `pageId` becomes optional under the same exactly-one-page rule. `sessionId` stays
  required.
- **Tests:**
  - precedence;
  - a closed-context error;
  - two concurrent CLI processes with different contexts;
  - the ambiguity error when a popup opens.

### Phase 4: response echo (measure first)

`--json` results echo `sessionId`/`pageId` that the caller just supplied. Drop the echo only if
phase 2's measurements show it matters, and only behind a documented flag or minor-version note.

## Compatibility and release

- Ids stay opaque and the session schema pattern is unchanged.
- Old-format ids in journals and replays remain valid.
- Release notes call out the new formats, for any client that parsed id structure.
- Ships in 1.18.0. Phase 1 alone is safe in a patch release.

## Open questions

- Should the CLI context file be per tenant or API key, as well as per base URL?
- Should `use` verify the session exists at set time, as well as at use time? It must verify at
  use time either way.
