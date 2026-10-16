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
improbable.

Ids also outlive a restart in agent transcripts, scripts and MCP clients. For those, the
residual risk is that improbability. The CLI context (§3) goes further and binds to the server
instance, so a repeated id after a restart is never addressed through it.

### 2. Page ids

Page ids become session-scoped ordinals: `p1`, `p2`, ….
- They are monotonic within a session and not reused within it. A closed `p1` fails as not
  found; it never addresses a newer page.
- The engine page id becomes internal everywhere, including `page.created` event data, which
  must carry public ids.
- A popup is published only after it has a public id. Today the event goes out before
  asynchronous adoption.

### 3. CLI context: generated names, pinned page, instance-bound

Ids are omitted only through an explicit **context** that pins both the session and the page.

**Commands:**
- `agentbrowser use <sessionId> <pageId>` creates a context and prints its name;
- a call selects it with `-c <name>` (about 2 tokens) or `AGENTBROWSER_CLI_CONTEXT=<name>`.

**Names are generated, not chosen.** `use` prints a fresh unique name, e.g. `c_k3m9`, by default.
- `--name <n>` picks one instead, but `use` refuses to rebind an existing name to different ids
  unless given `--force`.
- A context file is created **exclusively** (`O_EXCL`), so two concurrent `use` calls can't both
  win. That's what makes the refusal real rather than check-then-act, and it also covers a
  collision of generated names, which then simply draws a new one.
- Why: if two agents both picked `-c a`, they would collide exactly like a shared default. A
  generated name can't collide by accident, and the refusal stops a quiet overwrite.
- What remains: two agents that deliberately share a name, or both pass `--force`, share a
  context. The CLI cannot prevent that, and documents it.

**The page is pinned.** A context names its page explicitly, and nothing resolves "the only open
page" at call time.
- Why: the page set can change without the agent acting. A page can `window.open` a popup and
  close itself, or a human can close the agent's page during a delegated takeover. An implicit
  "the only page" would then silently move a non-ref action (`press`, `type-text`, `navigate`)
  onto a page the agent never chose.
- Instead, a pinned page that has closed fails as stale, and the agent rebinds deliberately with
  `use`.

**Instance binding is checked by the server, atomically.** A context records the base URL and the
server's existing **`serviceGeneration`**: a random value generated per process. Today it is
exposed only in the run cursors of controlled sessions; phase 3 adds that same value to the
session view so `use` can read it for any session. No second identifier is added.
- Every context-driven request carries it in an `x-agentbrowser-generation` header. The `/v1`
  request hook rejects a mismatch before the operation runs, so there is no window between a
  health check and the call, and no extra round trip.
- **The check runs after authentication,** so unauthenticated callers see the same response
  whatever the generation. A mismatch returns the existing `SESSION_NOT_FOUND` error, which is
  what a context naming a session this process never created should get. No new error code or
  status mapping is introduced.
- **The header is compared, and nothing else.** It never feeds journal keys, run cursors or any
  identifier, which keeps the journal contract's rule that operation keys take no
  caller-supplied generation.
- A context used against another base URL, after a restart (a different generation), or after
  its session or page has closed fails. None of these ever falls through to another source.
- `/health` is not changed; `use` reads the generation from the session view.

**Grammar is decided by flags, never guessed from positionals.** With `-c`, or with explicit
`-s <session>` / `-p <page>`, a command takes **no** positional ids: `observe -c c_k3m9`,
`press -c c_k3m9 Enter`. Without those flags, today's positional grammar is unchanged. So
`press p1` is never ambiguous between a page id and a key.

**The flags are exclusive, with no precedence rules:**
- `-c` combined with `-s` or `-p` is an error (pick one source of ids).
- A page-level command given `-s` without `-p` is an error, because the page is never inferred.
- Session-level commands (`session get`, `session close`) take `-s` alone.

**Environment names avoid existing meanings.** `AGENTBROWSER_SESSION_ID` stays the MCP adapter's
operator-configured delegated-session binding, and the CLI does not read it. The CLI keeps
ignoring `AGENTBROWSER_BASE_URL`; the base URL comes from the context or from `--base-url`.

**MCP is unchanged here.** Tools keep requiring `sessionId` and `pageId`. They already benefit
from the shorter ids (§1, §2), and an MCP client holds its ids in its own context.

### 4. Element refs

Element refs (`e<revision>_<ordinal>`, ADR-004) are already compact and do not change.

## Consequences

- **Fewer tokens on every call.** The session id shrinks from 27 to 12 characters, and the page id
  from 12–47 to 2. With a context, calls repeat neither (`agentbrowser -c c_k3m9 --json observe`). The
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
  - Ships in a minor release (after 1.21.0), not a patch.
- **New surface to document and test:** `use`, `which` and `unuse`, `-c`/`-s`/`-p`,
  `AGENTBROWSER_CLI_CONTEXT`, the `x-agentbrowser-generation` request header, and the public ids
  in `page.created`.

## Alternatives considered

- **`s_{yymmddhh}_{6 chars}`.** It breaks the `^ses_` schema pattern, and the timestamp digits
  cost tokens without informing the agent. Rejected.
- **Prefix matching (git-style).** Whether a prefix is ambiguous depends on whatever other ids
  exist at the moment, so a short prefix can resolve to a different session later. Rejected for an
  agent API.
- **Inferring the only open session.** If one agent's session closes while another's stays open,
  the first agent would drive the second's session. Rejected.
- **An unnamed per-user default context, or caller-chosen names.** A default is shared across
  concurrent agents of the same user, and chosen names like `a` collide just as easily. Both
  carry the same wrong-target hazard. Rejected: names are generated, and rebinding needs
  `--force`.
- **Resolving an omitted page on the server.** It is the "only one" inference this ADR rejects
  for sessions, and the page set changes underneath the agent (popups, self-closing pages,
  takeover). It would also need a per-session lock that ordinary sessions don't have. Rejected:
  the context pins the page.
- **A new `instanceId` on `/health`.** It would duplicate `serviceGeneration` (ADR-015: one source
  of truth), and checking it with a separate request is check-then-act. Rejected for the request
  header.
- **Environment variables as the only context.** These are per-process, but many agent harnesses
  don't keep environment state between tool calls, so the agent would have to repeat them on
  every call. Kept as a way to select a named context, not as the context itself.
