# T7 prerequisite: OS-enforced egress pairing (N2)

Status: prerequisite documented 2026-10-02 (the N2 refinement's deliverable
is this record; the enforcement itself is NOT SHIPPED). Task packet:
[t7-audit-security](../tasks/t7-audit-security.md). Origin: the
foundation-first refinements ([foundation-refinements](../tasks/foundation-refinements.md))
and the egress-transport reassessment's "neither component substitutes
for the other" boundary ([egress-transport design](../../egress-transport-design.md)).

## The pairing

Hostile multi-tenancy — tenants who may deliberately attempt egress
escape — requires that each browser session's network egress be bound
to an OS-enforced identity at the process boundary, not only filtered
at the application boundary:

| Layer | Enforces | Failure mode it closes |
| --- | --- | --- |
| Application (SHIPPED, with the threat model's PARTIAL qualifiers) | SSRF base policy, session host rules, engagement scope (T7 slice 2a), redirect all-hop walk, response caps (body-bearing passthrough responses uncapped), WebSocket deny (page-routed traffic; workers uncovered, explicit off/no-policy unguarded), download pinning | honest mistakes, page-routed malicious content, scope drift |
| OS / process boundary (NOT SHIPPED) | the browser process (or its network service) may only connect through the session's authorized gateway; startup REFUSES to run when the enforcement is absent | a compromised or misrouted renderer bypassing the application filter entirely |

The two layers are a pairing, not alternatives: the application layer
cannot contain a bypassed choke point (unrouted worker traffic, kernel
level escapes, a renderer speaking directly to the network), and the OS
layer cannot express engagement semantics (paths, methods, identity
bindings, budgets, evidence quality). Neither substitutes for the
other; both are required for the hostile-tenant threat model.

## Why this is a T7 prerequisite, not a T7 deliverable

T7 slice 2a (engagement scope enforcement) is application-layer
enforcement for an AUTHORIZED operator's own discipline: it assumes the
operator configuring the scope is not the adversary. The bounty and
security-testing use cases run under exactly that assumption
(manual submission, explicit live-target authorization). The moment
sessions are offered to tenants who are the adversary, the application
boundary is insufficient BY ITSELF — closing R03/R13 capabilities for
that audience requires the pairing first. The T7 packet's stop rule
applies: the gateway program this prerequisite needs is deferred and
GATED ([egress-transport feasibility](../../egress-transport-feasibility.md)
— gate FAILED, no production transport approved); this record documents
the requirement without restarting that project implicitly.

## What the OS layer must enforce (requirements, not design)

1. Per-session egress identity: the browser process for session S can
   reach ONLY its authorized gateway (network-namespace, macOS sandbox,
   or equivalent — the mechanism is deployment-specific; the property is
   not).
2. Fail-closed startup: if the enforcement cannot be verified, the
   contained profile refuses to start (the [transport design's](../../egress-transport-design.md)
   contained row) — no silent native fallback.
3. No unauthenticated control plane on the enforcement path (the
   loopback opt-out's page→service escalation is the cautionary record;
   see the threat model's Trust boundaries list).
4. Independent verification: real network-bypass tests by an adversarial
   reviewer, not the application suite's own green checks.

## What exists today (stated plainly)

- Application layer: SHIPPED and gated (SSRF base, host rules, scope,
  all-hop walk, caps, WS deny, download pinning).
- OS layer: NOT SHIPPED. An ordinary Docker bridge is NOT forced egress
  ([threat model](../../threat-model.md)); the contained Chromium profile
  requires the deferred gateway program. No documented deployment of
  this repository currently claims OS containment.
- Implication for operators: multi-tenant exposure today requires
  compensating controls at the infrastructure boundary (existing
  network policy around the host), because the product does not yet
  provide the pairing.
