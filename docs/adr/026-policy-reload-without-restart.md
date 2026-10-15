# ADR-026: Policy Reload Without Restart — Tighten Live Sessions, Never Relax Them

**Status:** Proposed (2026-10-15) — awaiting the owner's decision; nothing is implemented
**Related:** [ADR-024](024-server-policy-engine-cedar.md) (server policy engine; this ADR
resolves its "reload without restart" out-of-scope line),
[ADR-007](007-approval-tokens-side-effects.md) (approval tokens),
[ADR-025](025-operator-cookie-handoff.md) (operator keys, cookie handoff),
[TD-BROWSER-15](../td/TD-BROWSER-15-server-policy-engine.md) (phase 8 below is its plan)

## Context

ADR-024 loads the Cedar policy document once, at startup (`AGENTBROWSER_POLICY_FILE`). Changing
policy therefore means restarting the server, which ends every in-flight session. That is the
wrong tool for long-running agent sessions, and the wrong lever when the change is urgent (an
operator blocking a destination should not have to kill unrelated work to do it).

ADR-024 fixed the one rule a reload must keep: **a reload must never relax a live session.**
What exists today, stated precisely (phase 8 must add the rest):

- Every operator decision goes through one `Authorizer` seam, memoized per session
  (`MemoizedAuthorizer`, keyed on action and context only).
- `policyVersion` is a SHA-256 over the document's **decision fields** (version, baseline,
  `unknownRisk`, `approvalRules`, `policies`). It does **not** cover `limits`. It is one
  server-wide value; sessions report it but do not store their own.
- Only `cookie.handoff` approval tokens carry and compare `policyVersion`. Ordinary `act`
  approval tokens (ADR-007) are not version-bound.
- Some grants are decided **once, at session creation** (`cdp.attach`, `downloads`,
  `serviceWorkers`, `cookie.seed`, `session.headed`); others are checked per call (egress per
  request and per redirect hop, `cookie.export`, approval decisions).
- `limits.maxResponseBytes` is fixed into each session's network policy at creation;
  `limits.extractMaxBytes` is server-wide.
- `SIGHUP` already means graceful shutdown for the server and the launcher.
- Operator keys (ADR-025) exist only alongside API keys and only for the single configured
  tenant.

## Decision (proposed)

### 1. One source, one explicit trigger, one admin credential

The file named by `AGENTBROWSER_POLICY_FILE` stays the only source of policy. Reload is opt-in
and is triggered by `POST /v1/admin/policy/reload`, which accepts **only** a server-scope admin
credential loaded from `AGENTBROWSER_POLICY_ADMIN_KEY_FILE` (file only, never a variable, same
handling as operator keys). The admin credential:

- is distinct from every tenant API key and operator key (a key appearing in two roles aborts
  startup), so a key scoped to one tenant can never change policy for others;
- exists independently of `AGENTBROWSER_API_KEYS`, so no-keys and multi-tenant deployments can
  reload;
- authorizes nothing else.

Configuring the file enables reload; without it the endpoint does not exist. Configuring it
without `AGENTBROWSER_POLICY_FILE` (an environment-variable deployment, which has nothing to
reload) aborts startup.

**No signal.** `SIGHUP` keeps meaning shutdown; repurposing it would turn a terminal hangup into
a reload and would not reach the server through the launcher. One HTTP trigger works the same on
Linux, macOS and Windows. A CLI convenience (`agentbrowser-server policy reload`) may wrap it.

**No file watcher.** A watcher can observe a half-written file. Operators replace the file
atomically (write, then `rename`) and then trigger.

### 2. Validate fully, swap atomically, never fail open

A reload parses and strictly validates the new document exactly as startup does. An invalid
document is refused and reported (to the caller and at `warn`, naming the error location, never
contents); **the running policy stays in force**. Reloads are serialized: one at a time.

A reload's identity is a SHA-256 over the **whole** validated document, `limits` included (the
*document identity*). A reload whose document identity is unchanged is a no-op. `policyVersion`
keeps its ADR-024 meaning for compatibility.

### 3. New sessions get the new policy; live sessions only get stricter

- Sessions created after the swap pin the new document.
- **Creation and reload are serialized.** Session creation takes one snapshot of the current
  document, makes every creation-time decision against that snapshot, and registers the session
  in the live set under the same lock that a reload holds while it swaps the document and extends
  live chains. A session created concurrently with a tightening reload is therefore either pinned
  at the new document or carries it in its chain; it can never run on the old document alone.
- Each live session carries a **chain**: its pinned document plus every document loaded since it
  was created (deduplicated by document identity). A per-call decision is allowed only if
  **every** document in the chain allows it. AND is order- and repeat-insensitive, so
  deduplication is safe.
- **Never collapse the chain to "pinned AND current".** With reloads A → B → C, a session pinned
  at A would lose a restriction that B added and C dropped.
- **Approval modes compose by the same AND.** The approval mode is derived from two Authorizer
  questions (`act`, then `act.unattended`); asked of the chain, the result is "denied if any
  document denies, otherwise approval-required if any requires it".
- **Limits take the minimum along the chain, over resolved values.** Each document's limit is
  first resolved to its effective value (an omitted limit means the built-in default, for example
  10 MiB for `maxResponseBytes`); the session's effective limit is the minimum of those resolved
  values, applied from its next request or extraction. Skipping an omitted limit would relax.
  `maxResponseBytes` moves from a creation-time constant to that live value; `extractMaxBytes`
  moves from server-wide to per-session.
- **The decision cache is re-keyed.** A session's memoized decisions are keyed on its chain
  identity (or cleared when its chain grows), so a decision cached as allowed before a
  tightening is decided afresh after it.

### 4. What a reload cannot reach

- **Creation-time grants are not revoked.** A headed browser, registered service workers,
  already-seeded cookies, an attached CDP connection and the downloads setting were decided at
  creation; AND-ing later decisions cannot undo them. A tightening that would now deny such a
  grant is **reported**: the reload response lists how many live sessions hold a creation-time
  grant the new document would deny, so the operator can close those sessions. The reload does
  not terminate them itself.
- **Established connections continue.** A tightening governs new requests (per request and per
  redirect hop, with DNS re-checked as today). An open WebSocket or an in-progress download to a
  newly blocked destination is not cut.
- **Tightening is irreversible for live sessions.** With A → B (bad) → A, the chain stays
  [A, B]: B keeps restricting live sessions until they end. An accidental over-tightening (for
  example, blocking all egress) is undone only by restarting the affected sessions. This is the
  price of "never relax".

### 5. Approvals and the query surface

- **Approval tokens bind to the chain.** Phase 8 binds every approval token (ADR-007 `act`
  tokens as well as `cookie.handoff`) to the session's chain identity at mint. A token is
  refused on use if the chain has grown since; the operator re-approves under the current
  chain. (A newly denied action is also refused by the chain decision itself; the binding
  additionally covers an action whose mode changed between required and allowed.)
- **Session views:** `policyVersion` keeps reporting the session's **pinned** version, so
  existing clients are unaffected; an additive `policyChain` field lists the chain's **document
  identities** (a limits-only reload adds an entry whose `policyVersion` is unchanged). This is a
  protocol change (schema and OpenAPI), additive only.
- `GET /v1/policy` reports both the current `policyVersion` and the current document identity.
  The reload response reports the new document identity, how many live sessions now carry it, and
  the creation-time-grant count above.
- Every reload (accepted, refused or no-op) is logged with the previous and new identities.

### 6. What does not change

The floor stays unconfigurable; session narrowing and engagement scope still apply after policy;
environment-variable deployments (no policy file) have nothing to reload and are unaffected.

## Consequences

- Operators can tighten policy for running agents without restarting the service.
- Loosening never reaches a live session, and neither does undoing a tightening; a session that
  needs the looser policy must be restarted by its owner. This is the conservative, auditable
  choice.
- Creation-time grants and established connections are outside a reload's reach; the reload
  reports the former so the operator can act.
- A new server-scope credential exists (the policy admin key), held in a file.
- Memory: each document stays alive while any live session's chain references it.
- Decision cost for a live session grows with the number of distinct reloads during its
  lifetime (one evaluation per document in its chain). A cap on chain length that **refuses
  further reloads** (never drops a document) is an open question for the implementation phase.

## Alternatives considered

- **Restart only (status quo):** ends in-flight work; rejected for long-running sessions.
- **Apply the new policy to every session:** can relax a live session; violates ADR-024.
- **Freeze live sessions on their pinned document:** an urgent tightening would not reach
  running agents; rejected.
- **"Pinned AND current" only:** relaxes when a later reload drops an intermediate restriction.
- **`SIGHUP`:** already means shutdown, absent on Windows, and not forwarded by the launcher.
- **An operator key as the reload credential:** operator keys are scoped to one tenant and exist
  only with API keys; policy is server-wide.
- **Terminating sessions whose creation-time grants a reload would deny:** a reload would then
  end in-flight work, which is what this ADR exists to avoid; reported instead.
- **File watching:** races with partial writes; replaced by an explicit trigger.
