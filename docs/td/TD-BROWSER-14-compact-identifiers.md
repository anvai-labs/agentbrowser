# TD-BROWSER-14: Compact identifiers and explicit CLI context

**Status:** Planned (target 1.18.0)
**Decision:** [ADR-022](../adr/022-compact-identifiers-and-cli-context.md)

## Problem

Session and page ids are repeated in nearly every agent call, and today they are long:
`ses_1791848997803_v4uqd61ry` (27 characters) and `pg_17_page-0` (12; about 47 under
engine-firefox, whose engine page ids are UUIDs). ADR-022 has the analysis and the decision; this
TD is the plan.

## Phases

Each phase is its own PR with its own adversarial review. Phase 1 must land before phase 2.

### Phase 1: session-keyed pages and public ids in events (no format change)

**Re-key pages.** `AgentBrowserService.pages` (`packages/api/src/service.ts`) becomes keyed by
`(sessionId, pageId)`. `listPages` must keep each session's creation order, which it gets from
Map insertion order today.

**Audit every page-id path:**
- every `pages.set`: new pages and popup adoption;
- the unchecked `pages.get(pageId)` calls in plan execution and ref remapping;
- `requirePage` / `getPage`;
- the `checkApproval` page binding;
- the matching on `pageId` in `packages/control/src/reviewed-evidence.ts`;
- snapshot, plan and outcome paths;
- delegated sessions and CDP attach;
- MCP tools;
- WebSocket subscriptions and event replay;
- artifact naming (`page-${pageId}.html`).

**Events carry public ids.** `page.created` data (`pageId`, `openerPageId`) is translated from
engine ids to public ids. A popup is published only after adoption has given it a public id.

**Testkit.** `getFakePage`'s `_<engineId>` suffix matching is replaced by an explicit
public-to-engine page lookup that the service exposes for tests, and its benchmark and test
callers are migrated.

**Tests:**
- Two sessions whose pages share an id: every page-addressed route and tool returns the existing
  `NOT_FOUND` / `SESSION_NOT_FOUND` errors and never touches the other session's page, including
  its revision and ref history.
- `page.created` carries public ids, and is published only after adoption.
- Existing id formats keep passing unchanged.

### Phase 2: compact formats

**Session ids:** `ses_` + 8 lowercase Crockford base32 characters from `crypto.randomInt`,
regenerated on collision with a live session. Uniqueness across restarts is probabilistic, as
ADR-022 states. Contract test: the `^ses_` schema pattern still holds.

**Page ids:** a per-session monotonic `p<n>`, not reused within the session. Popups take the next
ordinal.

**Tests:**
- Ordinals are not reused after close: a stale id is `NOT_FOUND`, not the newer page.
- The regenerate-on-collision path, driven by an **injected RNG** that deliberately collides
  (a statistical test would pass trivially through the collision check).
- FakeEngine and engine-playwright contract suites, plus the migrated benchmarks.
- `service.test.ts` assertions on the old `pg_` prefix are updated.

**Measure:** bytes and tokens per call on the benchmark transcripts, before and after, as release
evidence.

### Phase 3: named CLI contexts

**Commands:**
- `agentbrowser use <name> <sessionId> [pageId]`;
- `agentbrowser which [-c <name>]`, which shows the resolved ids and where they came from;
- `agentbrowser unuse <name>`.

**Storage:** a context records `{ baseUrl, instanceId, sessionId, pageId? }` in the user's state
directory, written atomically, one file per name.

**Server:** `/health` reports a random per-process `instanceId`.

**Selection and grammar:**
- `-c <name>` or `AGENTBROWSER_CLI_CONTEXT=<name>` selects a context, and the `-s`/`-p` flags
  give ids explicitly.
- With any of those flags, a command takes **no** positional ids. Without them, the positional
  grammar is unchanged.
- There is no unnamed default context (ADR-022: it would be shared across concurrent agents).
- The CLI never reads `AGENTBROWSER_SESSION_ID` (the MCP delegated-session binding) or
  `AGENTBROWSER_BASE_URL`.

**Errors, never fallback:** a context with another base URL, a different `instanceId` (the server
restarted) or a closed session or page fails.

**Page omission:** the request omits `pageId`, and the server resolves it atomically, under the
session lock, to the single open page. Zero or several open pages fail as ambiguous. The response
always returns the resolved `pageId`. MCP tools get the same rule for an optional `pageId`.

**Tests:**
- grammar selection by flag (`press -c a Enter` versus `press <s> <p> Enter`);
- two concurrent CLI processes, each using a different context, never cross;
- a stale context fails after a restart, a close, or a base-URL change;
- an omitted page becomes ambiguous when a popup opens;
- the server-side resolution is atomic.

### Phase 4: response echo (measure first)

`--json` results echo the `sessionId`/`pageId` the caller supplied. Drop the echo only if phase 2's
measurements show it matters, and **never** when the server resolved an omitted page: that echo is
how the agent learns which page it drove.

## Compatibility and release

- Ids stay opaque strings, and the session schema pattern is unchanged.
- Release notes call out the new formats, the public ids in `page.created`, and the CLI context
  commands.
- Phases 1 to 3 ship in 1.18.0. Phase 1 alone has no visible change and could ship in a patch.

## Open questions

- Should a context also be scoped to the API key or tenant, so that a key rotation invalidates it?
- Should `use` check that the session exists when the context is set, as well as when it is used?
  It must check at use time either way.
