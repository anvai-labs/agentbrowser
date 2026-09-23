# Handoff: LAN CIDR allowlist for the egress policy

Goal: let an operator explicitly allow navigation to specific private
network ranges (e.g. `192.168.1.0/24` for a lab control plane at
`192.168.1.89:8080`) without weakening the default SSRF posture for
anyone else. The capability is operator-set, explicit, and off by
default.

## Current behavior (verified)

* `packages/policy/src/network-policy.ts` — `NetworkPolicy` blocks
  loopback / private IPs / cloud metadata **when the corresponding
  options are enabled** (all default to `false`).
* `packages/api/src/service.ts` (~line 552) constructs the default
  policy with all three enabled:
  `new NetworkPolicy({ blockLoopback: true, blockPrivateIPs: true, blockMetadata: true })`
  (ADR-006: SSRF defenses on by default, injectable via
  `deps.networkPolicy`).
* Two gates block a LAN target, so an allowlist must cover both:
  1. `checkHostname()` — hostname literal check
     (`Private IP addresses are blocked: <host>`).
  2. `checkResolvedAddresses()` — the DNS-rebinding gate; a hostname
     that resolves into a private range is rejected even when the
     hostname itself is a DNS name (`Resolved address is private…`).
* Classification lives in `packages/policy/src/ip-address.ts`
  (`classifyIPAddress` over a Node `BlockList`; `privateIP` flag).

## Implementation

`NetworkPolicyOptions.allowedPrivateCIDRs` is compiled once per configuration
into a Node `BlockList`, shared by hostname and resolved-address gates. IPv4,
IPv6 and mapped IPv4 identities use the existing address classifier. Explicit
prefixes are required (`/32` for an IPv4 host, `/128` for an IPv6 host); malformed
addresses, prefixes, scoped literals and DNS names fail closed. The policy owns
its CIDR array, validates updates before mutation, and preserves session/download/
gateway snapshots. Session host restrictions still apply independently.

The server entrypoint reads `AGENTBROWSER_ALLOWED_CIDRS` as a comma-separated list
before starting the engine or listener. Whitespace around entries is trimmed;
unset/blank means no exceptions. Invalid entries, including empty entries in a
nonempty list, abort startup. A `/0` entry is valid but emits a warning. The
embedded service keeps the same safe defaults via a shared factory; it does not
read ambient environment settings. Trusted embedders can inject a policy.

The setting is not part of session schemas, CLI session options or MCP tools.
`GET /v1` does not disclose the operator's LAN ranges. This change does not expand
the existing browser egress coverage guarantees described in the threat model.

## Validation target (the motivating case)

To allow only the lab host, launch the server with:

```sh
AGENTBROWSER_ALLOWED_CIDRS=192.168.1.89/32 agentbrowser-server
```

Then use a headed session through the CLI or API:

```
navigate http://192.168.1.89:8080/        # lab control plane allowed
navigate http://192.168.1.89:9001/        # same host also allowed (CIDRs do not restrict ports)
navigate http://192.168.1.65/             # unlisted host denied
navigate http://169.254.169.254/          # metadata denied
```

`192.168.1.0/24` permits **both** `.89` and `.65`; it cannot prove denial of
`.65`. Use a `/32` for the single-host qualification above, or choose a host
outside the configured subnet for a `/24` negative check. CIDR exceptions only
relax private-address blocking: loopback and metadata blocks still win.

Automated coverage lives in `packages/policy/src/private-cidr.test.ts` (both gates,
boundaries, IPv6/mapped identities, mixed DNS answers, snapshot/update ownership,
restrict-only session rules) and `packages/api/src/network-policy-config.test.ts`
(startup config parsing and shared defaults). Invalid startup is also checked
against the built entrypoint during qualification.

## Security notes (keep in the doc when merged)

* The allowlist is an **operator** setting, never a per-session or
  agent-settable one — an agent must not be able to widen its own
  egress.
* Allowing LAN ranges reintroduces real SSRF surface into private
  networks: scope the CIDR as tightly as possible (a /32 for one IPv4 host, not
  a whole LAN or the RFC1918 superset), keep the metadata block unconditional, and keep
  the deny-over-allow ordering.
* The DNS-rebinding gate must consult the same allowlist — that is why
  both gates are listed as first-class test targets above.

## Local qualification (2026-09-23)

Candidate based on `develop` `2294942`; separate loopback service on port 5719,
configured with `AGENTBROWSER_ALLOWED_CIDRS=192.168.1.89/32`. Through the built
AgentBrowser CLI and a real headed Chromium session:

| Check | Result |
| --- | --- |
| Navigate `http://192.168.1.89:8080/` | `status: success`; observed title `AnvaiOps Control Plane — Data Quality` |
| Navigate `http://192.168.1.65/` | CLI exit 1, `POLICY_DENIED` |
| Navigate `http://169.254.169.254/` | CLI exit 1, `POLICY_DENIED` |
| Observe after denied attempts | Lab URL/title retained |
| Start built server with `192.168.1.89/999` | Exit 1 with CIDR validation error before listening |

No assertion about the upstream HTTP status is made by the navigation receipt.
The existing installed service and release were not changed. External lab checks
are manual qualification, not CI dependencies. Independent Node24 and Bun probes
also checked mapped identity behavior; this does not certify broader browser
network containment.
