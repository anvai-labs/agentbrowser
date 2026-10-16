# TD-BROWSER-14: Compact identifiers and explicit CLI context

**Status:** Planned (unscheduled; not in 1.18.0, which shipped TD-BROWSER-15/16)
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

### Phase 3: CLI contexts

**Commands:**
- `agentbrowser use <sessionId> <pageId> [--name <n>] [--force]` prints a generated name such as
  `c_k3m9`. It refuses to rebind an existing name to different ids without `--force`.
- `agentbrowser which [-c <name>]` shows the resolved ids and where they came from.
- `agentbrowser unuse <name>` removes a context.

**Storage:** `{ baseUrl, serviceGeneration, sessionId, pageId }`, one file per name in the user's
state directory, created **exclusively** (`O_EXCL`, or a link from a temporary file), never
replaced in place. `--force` deletes and then creates exclusively. It checks that the session and page exist when the context
is set, and again on every use.

**Protocol:** the session view gains `serviceGeneration`, the same per-process value that the
control view's `RunCursor` already carries for controlled sessions (one source of truth,
ADR-015). `use` reads it there.

**Server:** the `/v1` request hook, **after authentication**, compares an optional
`x-agentbrowser-generation` header with its own `serviceGeneration`. A mismatch returns the
existing `SESSION_NOT_FOUND` before the operation runs, so no new error code is added. The
header is compared only; it never feeds journal keys or run cursors. `/health` is unchanged.

**Selection and grammar:**
- `-c <name>` or `AGENTBROWSER_CLI_CONTEXT=<name>` selects a context, and the `-s`/`-p` flags
  give ids explicitly.
- With any of those flags, a command takes **no** positional ids. Without them, the positional
  grammar is unchanged.
- `-c` together with `-s`/`-p` is an error. A page-level command given `-s` without `-p` is an
  error. Session-level commands take `-s` alone.
- There is no default context.
- The CLI never reads `AGENTBROWSER_SESSION_ID` (the MCP delegated-session binding) or
  `AGENTBROWSER_BASE_URL`.

**Errors, never fallback:**
- A context used against another base URL fails.
- A context used after a restart (the generation header mismatches) fails.
- A context whose pinned session or page has closed fails as stale; the agent rebinds with
  `use`.
- The page is never inferred.

**MCP:** unchanged. Tools keep requiring `sessionId` and `pageId`.

**Tests:**
- grammar selection by flag (`press -c c_x Enter` versus `press <s> <p> Enter`);
- generated names are unique, and rebinding an existing name without `--force` is refused;
- **concurrent** `use --name x` calls: exactly one succeeds (exclusive creation);
- the flag-combination errors (`-c` with `-s`, and `-s` without `-p` on a page command);
- a generation mismatch returns `SESSION_NOT_FOUND`, and an unauthenticated request is rejected
  before the generation is compared;
- two concurrent CLI processes, using generated contexts, never cross;
- the generation header is rejected after a restart, before any side effect;
- a pinned page that closed (a popup replaced it, or a takeover closed it) fails as stale instead
  of moving to another page.

### Phase 4: response echo (measure first)

`--json` results echo the `sessionId`/`pageId` the caller supplied. Drop the echo only if phase 2's
measurements show it matters.

## Compatibility and release

- Ids stay opaque strings, and the session schema pattern is unchanged.
- Release notes call out the new formats, the public ids in `page.created`, the CLI context
  commands, and the `x-agentbrowser-generation` header.
- Phases 1 to 3 ship together in a minor release after 1.19.0. Phase 1 alone has no visible
  change and could ship in a patch.

## Open questions

- Should a context also be scoped to the API key or tenant, so that a key rotation invalidates it?
- Should a context expire on its own (a TTL), beyond failing once its session ends?
