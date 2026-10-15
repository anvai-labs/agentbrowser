# ADR-026: Policy Reload Without Restart — Tighten Live Sessions, Never Relax Them

**Status:** Proposed (2026-10-15) — awaiting the owner's decision; nothing is implemented
**Related:** [ADR-024](024-server-policy-engine-cedar.md) (server policy engine; this ADR
resolves its "reload without restart" out-of-scope line),
[ADR-007](007-approval-tokens-side-effects.md) (approval tokens),
[TD-BROWSER-15](../td/TD-BROWSER-15-server-policy-engine.md) (phase 8 below is its plan)

## Context

ADR-024 loads the Cedar policy document once, at startup (`AGENTBROWSER_POLICY_FILE`). Changing
policy therefore means restarting the server, which ends every in-flight session. That is the
wrong tool for long-running agent sessions, and the wrong lever when the change is urgent (an
operator blocking a destination should not have to kill unrelated work to do it).

ADR-024 already fixed the one rule a reload must keep: **a reload must never relax a live
session.** It also already provides the pieces a reload needs:

- the document version is the SHA-256 of its canonical JSON, stamped on every session at creation;
- approval tokens are bound to that version and are never consumed under a different one;
- every decision goes through one `Authorizer` seam.

## Decision (proposed)

### 1. One source, an explicit trigger

The file named by `AGENTBROWSER_POLICY_FILE` stays the only source of policy. Reload is opt-in
(`AGENTBROWSER_POLICY_RELOAD=signal`, default off) and is triggered explicitly:

- `SIGHUP` to the server process, or
- `POST /v1/policy/reload`, authenticated with an **operator** key (never an agent grant).

Windows has no `SIGHUP`, so the Windows bundle offers the endpoint only. Reloads are serialized:
one in progress at a time, and a reload of an unchanged document (same hash) is a no-op.

There is no file watcher: a watcher can observe a half-written file. Operators replace the file
atomically (write a new file, then `rename` it into place) and then trigger.

### 2. Validate fully, swap atomically, never fail open

A reload parses and strictly validates the new document exactly as startup does. An invalid
document is refused, reported (to the caller and at `warn`, naming the error location, never
contents), and **the running policy stays in force**. A reload can never take the server down or
leave it without a policy.

### 3. New sessions get the new policy; live sessions only get stricter

- Sessions created after the swap are stamped with, and decided by, the new version.
- Each live session keeps its pinned version **and** gains the new version as an additional
  restriction: a decision is allowed only if its pinned policy **and** the new policy allow it. Tightenings (blocking a destination, removing a capability) therefore apply to running
  agents immediately; loosenings apply only to sessions created afterwards.
- Proving that one Cedar policy set is stricter than another is not decidable in general; the
  conjunction makes "never relax" true by construction instead.
- A further reload composes: a live session is decided by its pinned version **and every version
  loaded since it was created**, not just the latest one. Keeping only "pinned AND current" would
  relax: with reloads A → B → C, a session pinned at A would lose a restriction that B added and C
  dropped. Each live session therefore carries its ordered chain of versions (deduplicated by
  hash); a decision is allowed only if every policy in the chain allows it. A session's chain only
  grows, and it is released when the session ends.

### 4. Approvals and the query surface

- Pending approvals minted under an older version are refused on use, as today: the operator
  re-approves under the current policy.
- `GET /v1/policy` reports the current version; each session view reports its version chain (pinned
  first). The reload response reports the new version and how many live sessions now carry it as
  an additional restriction.
- Every reload (accepted or refused) is logged with the previous and the new version.

### 5. What does not change

The floor stays unconfigurable; session narrowing and engagement scope still apply after policy;
environment-variable deployments (no policy file) have nothing to reload and are unaffected.

## Consequences

- Operators can tighten policy for running agents without restarting the service.
- Loosening never reaches a live session; a session that needs the looser policy must be restarted
  by its owner, which is the conservative and auditable choice.
- Memory: the server keeps each version alive while any live session's chain references it
  (bounded by the distinct versions loaded during live sessions; released when the last
  referencing session ends).
- Decision cost for a live session grows with the number of reloads during its lifetime (one
  evaluation per version in its chain); the decision cache (ADR-024 §8) would key on the chain.
  An operator who reloads often should expect long sessions to cost more per decision; a cap on
  chain length that refuses further reloads (rather than dropping a version) is an open question
  for the implementation phase.

## Alternatives considered

- **Restart only (status quo):** ends in-flight work; rejected for long-running sessions.
- **Apply the new policy to every session:** can relax a live session; violates ADR-024.
- **Freeze live sessions on their pinned version only:** an urgent tightening would not reach
  running agents; rejected.
- **File watching:** races with partial writes; replaced by an explicit trigger.
