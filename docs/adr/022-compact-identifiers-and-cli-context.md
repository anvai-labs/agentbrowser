# ADR-022: Compact Identifiers and Explicit CLI Context

**Status:** Proposed (2026-10-12)
**Related:** [ADR-004](004-stable-element-refs-revision-checking.md) (refs and staleness),
[ADR-009](009-mcp-high-level-tools.md) (tool surface),
[TD-BROWSER-14](../td/TD-BROWSER-14-compact-identifiers.md) (implementation plan)

## Context

Agents repeat session and page identifiers in almost every call, so their length is a direct,
recurring token cost. A typical CLI call today:

```
agentbrowser --json observe ses_1791848997803_v4uqd61ry pg_17_page-0
```

- **Session ids** are `ses_` + `Date.now()` (13 digits) + 9 `Math.random()` base-36 characters
  (27 characters; `packages/core/src/session-coordinator.ts`). Digit runs tokenize poorly, and
  the timestamp carries nothing an agent uses.
- **Page ids** are `pg_` + a server-wide counter + the **engine's own page id**
  (`packages/api/src/service.ts`): `pg_17_page-0` under Playwright, and about 47 characters under
  Firefox (`page-<uuid>`). Embedding the engine id also leaks engine internals into the public
  API, which the engine-neutral protocol (ADR-002) is meant to prevent.
- The protocol fixes only the session prefix: `sessionId` matches `^ses_[a-zA-Z0-9_]+$`. Page ids
  are unconstrained strings. Clients treat both as opaque.

## Decision

1. **Session ids** become `ses_` + 8 random characters of lowercase Crockford base32 (no `i`,
   `l`, `o`, `u`), drawn from `crypto`, e.g. `ses_k3m9xq7p`.
   - The `ses_` prefix stays, so the published schema pattern holds and the change is
     non-breaking.
   - 8 characters (40 bits) rather than 6: over a long-lived server's journal the birthday bound
     for 30 bits becomes uncomfortable. Each new id is also checked against known ids (live
     sessions and journal), and **never reused**.
2. **Page ids** become session-scoped ordinals: `p1`, `p2`, …
   - They are monotonic within a session and never reused. A closed `p1` stays dead, so a stale
     id fails as "not found" and never addresses a newer page.
   - The engine's page id stays internal.
   - Pages are always addressed under their session in REST paths and tool arguments, so
     session scope is enough.
3. **CLI context is explicit, never inferred across sessions.** Precedence, highest first:
   1. explicit arguments;
   2. `AGENTBROWSER_SESSION` / `AGENTBROWSER_PAGE`;
   3. a context set by `agentbrowser use <session> [page]`, stored per base URL.

   A context that names a session or page that no longer exists is an **error**. It never falls
   through to another source, and the CLI never picks "the only open session".
   - Why: if agent A's session closes while agent B (same tenant) has one open, inference would
     silently drive B's session. That is the wrong-target failure ADR-004 exists to prevent.
   - Within an *explicitly identified* session, the page may be omitted when the session has
     exactly one page. If it has more (e.g. a popup opened), the command fails as ambiguous.
4. Element refs (`e<revision>_<ordinal>`, ADR-004) are already compact and do not change.

## Consequences

- **Fewer tokens on every call.** The session id shrinks from 27 to 12 characters and the page id
  from 12–47 to 2. With context set, CLI calls repeat neither (`agentbrowser --json observe`). The
  actual token savings will be measured on benchmark transcripts before release, not assumed.
- **Pages must be keyed by session.** `service.ts` keys every page by `pageId` alone. With
  session-scoped ordinals, `p1` exists in many sessions, so every page lookup must be re-keyed to
  `(sessionId, pageId)` **first**. Otherwise a page id from one session could address another
  session's page. This is the main implementation risk, and TD-BROWSER-14 makes it its own phase
  with cross-session isolation tests.
- **Compatibility.**
  - Ids remain opaque strings and the session pattern is unchanged.
  - Persisted journals and event replays that hold old-format ids stay valid.
  - Clients that parsed id structure (none in this repository) would break. That is called out
    in the release notes.
  - Ships in a minor release (1.18.0), not a patch.
- **New CLI surface** (`use`, `which`, `unuse`, env vars) to document. The context file is
  per-user state, and its "error, never fall through" rule must hold under concurrent agents.

## Alternatives considered

- **`s_{yymmddhh}_{6 chars}`.** It breaks the `^ses_` schema pattern, and the timestamp digits
  cost tokens without informing the agent. Rejected.
- **Prefix matching (git-style).** Ambiguity depends on whatever other ids exist at that moment,
  so a short prefix can resolve to a different session later. Rejected for an agent API.
- **Inferring the only open session.** It is the wrong-target hazard described above. Rejected.
