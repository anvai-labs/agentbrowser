# TD-BROWSER-7: Session-lifecycle knobs — MCP/CLI parity & self-describing bounds

**Status:** Proposed
**Context:** 2026-09-08
**Related:** [ADR-005](../adr/005-ephemeral-sessions-explicit-persistence.md) (ephemeral sessions), [ADR-009](../adr/009-mcp-high-level-tools.md) (MCP high-level tools), [ADR-011](../adr/011-cross-package-contract-single-source-of-truth.md) (single-source contract), [TD-BROWSER-5](TD-BROWSER-5-single-binary-mcp-distribution.md) (MCP distribution)

## Context

`SessionRequest` carries two lifecycle knobs — `ttlMs` (total lifetime) and
`idleTimeoutMs` (inactivity close). Both are part of the protocol contract, both
are honored by the coordinator, and both have declared bounds:

| Knob | Protocol bound | Coordinator default | Source |
|------|----------------|---------------------|--------|
| `ttlMs` | `[1000, 86_400_000]` (1 s … **1 day**) | `900_000` (15 min) | `protocol/src/schemas.ts:89`; `core/src/session-coordinator.ts:66,127` |
| `idleTimeoutMs` | `[1000, 3_600_000]` (1 s … **1 hour**) | `120_000` (2 min) | `protocol/src/schemas.ts:90`; `core/src/session-coordinator.ts:67,128,325` |

The gap: **the two agent-facing surfaces do not expose `idleTimeoutMs`, only
`ttlMs`.** The knob is reachable from the SDK (`sdk-typescript/src/client.ts:26,52`)
and the raw API (`api/src/openapi.ts:225,667`) but is silently dropped everywhere
an agent or operator actually drives a session:

| Surface | `ttlMs` | `idleTimeoutMs` | Location |
|---------|---------|-----------------|----------|
| MCP `browser_create` input schema | present | **absent** | `mcp-server/src/mcp-server.ts:103` |
| MCP `browser_create` handler | forwarded | **not forwarded** | `mcp-server/src/mcp-server.ts:132` |
| CLI `create` flags | `--ttl` | **no flag** | `cli/src/cli.ts:150` |

Because the handler only copies `request.ttlMs`, an MCP caller that passes
`idleTimeoutMs` has it dropped before `sessions.create`, so the coordinator applies
the 2-minute default via the `?? this.config.defaultIdleTimeoutMs` fallback
(`session-coordinator.ts:128`). No validation error is raised — the argument is
accepted by the MCP layer's permissive schema and discarded.

A second, smaller gap: the MCP schema entries that *do* exist (`ttlMs`,
`idleTimeoutMs` when added) carry no `description`, `minimum`, or `maximum`, so the
tool manifest an agent reads gives no hint that ttl caps at 1 day and idle at 1 hour.
The agent has to discover the bounds by trial, or by reading `protocol`.

### Reproduction (live, this session)

Creating an MCP session with `ttlMs: 86_400_000` **and** `idleTimeoutMs: 3_600_000`
returned `ttlMs: 86400000` (honored) but `idleTimeoutMs: 120000` (default) — and the
session was reaped after ~2 minutes of caller inactivity during an interactive
headed login, exactly the workflow a longer idle window exists to support. The
`idleTimeoutMs` argument was well within the protocol's `3_600_000` maximum; it was
lost at the MCP boundary, not rejected by validation.

This is the concrete cost: the headed-login flow that ADR-005 and the `cookies`
handoff are designed around is the flow most likely to exceed a 2-minute idle
window, and it is the one flow where the mitigating knob is unreachable.

## Decision

Close the surface-parity gap and make the knobs self-describing at the MCP layer —
without widening the protocol (the bounds already live in `protocol`, per ADR-011;
this TD only propagates them outward).

1. **Expose `idleTimeoutMs` on MCP `browser_create`.** Add it to the input schema
   next to `ttlMs`, and forward it in the handler:
   ```ts
   idleTimeoutMs: { type: 'number', minimum: 1000, maximum: 3_600_000,
     description: 'Close the session after this many ms of inactivity. ' +
       'Default 120000 (2 min); max 3600000 (1 h). Raise it for interactive ' +
       'headed logins where the caller is idle while a human completes SSO/2FA.' },
   // …
   if (typeof args.idleTimeoutMs === 'number') request.idleTimeoutMs = args.idleTimeoutMs;
   ```

2. **Annotate `ttlMs` the same way** — `minimum`/`maximum`/`description`
   (`Default 900000 (15 min); max 86400000 (1 day).`). The MCP manifest is the only
   documentation most agents ever see; the bounds belong in it.

3. **Add a CLI `--idle-timeout` flag** mirroring `--ttl`, so the two operator
   surfaces match.

4. **Bounds are sourced from `protocol`, not re-typed as literals.** Import or
   re-export the min/max from the protocol schema so MCP/CLI descriptions cannot
   drift from the contract (ADR-011). The literals shown above are illustrative;
   the implementation must reference the single source.

5. **(Separate concern, not this TD) The 120 s default itself.** Whether 2 minutes
   is the right *default* for an interactive-capable tool is a product question;
   this TD only makes the override reachable and discoverable. If the default is
   revisited, do it as its own change with its own rationale.

## Consequences

- **Easier / safer:** the documented 1-hour idle ceiling becomes actually usable
  from MCP and CLI; interactive headed logins can hold a session open for the human
  step without a keep-alive hack. Agents reading the manifest learn the bounds
  instead of probing for them.
- **Contract unchanged:** no new protocol fields, no bound changes — this is pure
  propagation of an existing contract to two surfaces that under-expose it.
- **Trade-off:** a larger reachable idle window lets a caller hold a browser
  process longer; `ttlMs` (max 1 day) is still the hard backstop, and both remain
  bounded by the protocol maxima, so the blast radius is unchanged from what the SDK
  already permits today.
- **Drift risk:** hardcoding the bounds in MCP/CLI would reintroduce the ADR-011
  problem; acceptance criteria require sourcing them from `protocol`.

## Acceptance criteria

- [ ] MCP `browser_create` accepts `idleTimeoutMs` and forwards it to
      `sessions.create`; a test passes a non-default value and asserts it reaches the
      coordinator (not the `?? default` branch).
- [ ] MCP schema entries for both `ttlMs` and `idleTimeoutMs` carry `minimum`,
      `maximum`, and a `description`, with the numeric bounds sourced from
      `protocol`, not literals.
- [ ] CLI exposes `--idle-timeout` alongside `--ttl`.
- [ ] A regression test asserts an out-of-range `idleTimeoutMs` from MCP is rejected
      by the protocol validation (proving the value now actually flows to the
      contract boundary instead of being dropped).
- [ ] `docs/operations.md` (or the MCP tool reference) states both defaults and
      maxima in one place.

## Implementation Notes

- Smallest correct change is items 1–2 in `mcp-server.ts` (the surface an agent
  hits); the CLI flag (item 3) is a follow-on in the same PR.
- This is adjacent to TD-BROWSER-5 (single-binary MCP distribution): if a brew tap
  / packaged manifest is produced there, it should surface these same knob
  descriptions, so land this first and let the packaging inherit the annotated
  schema rather than documenting the bounds twice.
- Verify against the reproduction above: after the fix, an MCP `browser_create`
  with `idleTimeoutMs: 3_600_000` must return `idleTimeoutMs: 3600000`.
