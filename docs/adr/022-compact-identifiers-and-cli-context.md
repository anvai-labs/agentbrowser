# ADR-022: Compact Identifiers and Explicit CLI Context

**Status:** Proposed (2026-10-12)
**Related:** [ADR-002](002-engine-neutral-protocol.md) (engine-neutral protocol),
[ADR-004](004-stable-element-refs-revision-checking.md) (refs and staleness),
[ADR-009](009-mcp-high-level-tools.md) (tool surface),
[TD-BROWSER-14](../td/TD-BROWSER-14-compact-identifiers.md) (implementation plan)

## Context

Agents repeat session and page identifiers in almost every call, so their length is a direct,
recurring token cost. A typical CLI call today:

```
agentbrowser --json observe ses_1791848997803_v4uqd61ry pg_17_page-0
```

**Session ids** are `ses_` + `Date.now()` + `_` + up to 9 base-36 characters from `Math.random()`.
That is usually 27 characters in all (`packages/core/src/session-coordinator.ts`). Digit runs
tokenize poorly, and the timestamp carries nothing an agent uses. Nothing reads it back: no code
derives age, ordering or TTL from it.

**Page ids** are `pg_` + a server-wide counter + **the engine's own page id**
(`packages/api/src/service.ts`, for both new pages and adopted popups):
- `pg_17_page-0` under engine-playwright;
- about 47 characters under engine-firefox, whose engine ids are `page-<uuid>`.

The engine id leaks engine internals into the public API, contrary to ADR-002. It already leaks a
second way: `page.created` events carry raw engine page ids (`pageId`, `openerPageId`), and a
client can link a popup to its public id only through the `_<engineId>` suffix.

**The protocol** fixes only the session prefix: `sessionId` matches `^ses_[a-zA-Z0-9_]+$`. Page ids
are unconstrained strings. The service treats both as opaque. One in-repository consumer does
parse the page-id structure: the testkit's `getFakePage` matches the engine page by the
`_<engineId>` suffix, and benchmarks and many tests depend on it.

## Decision

### 1. Session ids

Session ids become `ses_` + 8 random characters of lowercase Crockford base32 (no `i`, `l`, `o`,
`u`), drawn from `crypto`. For example: `ses_k3m9xq7p`.
- The `ses_` prefix stays, so the published schema pattern holds.
- A new id is regenerated if it collides with a live session.

**Uniqueness is probabilistic across restarts, and the design says so.** No store remembers
closed or pre-restart session ids: journals are keyed by operation, and the event ledgers live in
memory. So a "never reused" guarantee could not be implemented. 40 random bits make a repeat
improbable. The one consumer that outlives a restart, the CLI context (§3), is bound to the
server **instance**, so a repeated id after a restart is still never addressed by mistake.

### 2. Page ids

Page ids become session-scoped ordinals: `p1`, `p2`, ….
- They are monotonic within a session and not reused within it. A closed `p1` fails as not
  found; it never addresses a newer page.
- The engine page id becomes internal everywhere, including `page.created` event data, which
  must carry public ids.
- A popup is published only after it has a public id. Today the event goes out before
  asynchronous adoption.

### 3. CLI context: named, flag-selected, instance-bound

Ids are omitted only through an explicit **named context**:
- `agentbrowser use <name> <sessionId> [pageId]` stores the context;
- a call selects it with `-c <name>` (about 2 tokens) or `AGENTBROWSER_CLI_CONTEXT=<name>`.

**Why named only:** an unnamed per-user default would be shared by every agent running as that
user. If agent A runs `use ses_A` and agent B then runs `use ses_B`, A's next call drives B's live
session. That is the wrong-target failure ADR-004 exists to prevent, so the design has no shared
default. Each agent uses its own context name.

**What a context records:** the base URL, the server instance id (a random per-process
`instanceId` that `/health` will report), and the session id (and page id, when given).
- Using a context against another base URL fails.
- Using it after a server restart (a different `instanceId`) fails.
- Using it when the session or page has closed fails.

None of these ever falls through to another source.

**Grammar is decided by flags, never guessed from positionals.** With `-c`, or with explicit
`-s <session>` / `-p <page>`, a command takes **no** positional ids: `observe -c a`,
`press -c a Enter`. Without those flags, today's positional grammar is unchanged. So `press p1`
is never ambiguous between a page id and a key.

**Environment names avoid existing meanings.** `AGENTBROWSER_SESSION_ID` stays the MCP adapter's
operator-configured delegated-session binding, and the CLI does not read it. The CLI keeps
ignoring `AGENTBROWSER_BASE_URL`; the base URL comes from the context or from `--base-url`.

**Page omission resolves on the server.** When a context names a session but no page:
- the request carries no `pageId`;
- the server resolves it atomically, under the session's lock, to the session's single open page;
- if the session has zero or several open pages (for example, a popup opened), the request fails
  as ambiguous;
- the resolved `pageId` is always returned, so the agent sees what it drove.

The MCP tools follow the same rule for an omitted `pageId`. `sessionId` stays required.

### 4. Element refs

Element refs (`e<revision>_<ordinal>`, ADR-004) are already compact and do not change.

## Consequences

- **Fewer tokens on every call.** The session id shrinks from 27 to 12 characters, and the page id
  from 12–47 to 2. With a context, calls repeat neither (`agentbrowser -c a --json observe`). The
  token saving is measured on benchmark transcripts before release, not assumed.
- **Pages must be keyed by session first.** `service.ts` keys pages by `pageId` alone. The lookup
  helpers (`requirePage`, `getPage`) already reject a page from another session, but with shared
  keys like `p1`:
  - a second session's `pages.set` would overwrite and orphan a live page;
  - the unchecked lookups in plan execution and ref remapping would read another session's
    revision and ref history.

  Re-keying to `(sessionId, pageId)`, while keeping each session's creation order, is phase 1 of
  TD-BROWSER-14. It comes with cross-session isolation tests and lands before any format change.
- **Test and benchmark infrastructure must stop parsing ids.** `getFakePage`'s suffix match is
  replaced by an explicit public-to-engine page mapping.
- **Compatibility:**
  - Ids remain opaque strings, and the session schema pattern is unchanged.
  - Out-of-repository clients that parsed id structure would break; the release notes say so.
  - Ships in a minor release (1.18.0), not a patch.
- **New surface to document and test:** `use`, `which` and `unuse`, `-c`/`-s`/`-p`,
  `AGENTBROWSER_CLI_CONTEXT`, `instanceId` on `/health`, server-resolved page omission, and the
  public ids in `page.created`.

## Alternatives considered

- **`s_{yymmddhh}_{6 chars}`.** It breaks the `^ses_` schema pattern, and the timestamp digits
  cost tokens without informing the agent. Rejected.
- **Prefix matching (git-style).** Whether a prefix is ambiguous depends on whatever other ids
  exist at the moment, so a short prefix can resolve to a different session later. Rejected for an
  agent API.
- **Inferring the only open session.** If one agent's session closes while another's stays open,
  the first agent would drive the second's session. Rejected.
- **An unnamed per-user default context.** Shared across concurrent agents of the same user, with
  the same wrong-target hazard. Rejected; contexts are named.
- **Environment variables as the only context.** These are per-process, but many agent harnesses
  don't keep environment state between tool calls, so the agent would have to repeat them on
  every call. Kept as a way to select a named context, not as the context itself.
