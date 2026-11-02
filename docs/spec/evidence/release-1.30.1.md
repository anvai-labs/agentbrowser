# Release 1.30.1 qualification

Status: published and delivery verified. Source PR #672, protected main promotion
#673 and develop back-sync #674 merged. The immutable
[v1.30.1 release](https://github.com/anvai-labs/agentbrowser/releases/tag/v1.30.1),
npm and Homebrew deliver 1.30.1. Existing services were not restarted.

This repairs existing scoped UI redirect behavior before enabling the P0-2 API
probe capability. No new command, scope authority or consent mechanism is exposed.

| Gate | Evidence |
| --- | --- |
| Baseline reproduction | Corrected UTF-8 fixture against 1.30.0: seven failures among 18 cases, including HEAD 301/302/303 changing to GET, DELETE/OPTIONS 301/302 changing method, and DELETE 303→307 restoring its original method/body |
| Receiver qualification | Public service with real Chromium: HEAD, DELETE, OPTIONS and PROPFIND same-origin chains, mixed POST/PUT/DELETE 303→307 chains, independent body length/SHA-256, and 300/304 Location fields that must not redirect |
| Denial qualification | HEAD/DELETE/OPTIONS method, host, rate and budget refusals; no denied receiver hit; exported engagement ledger chain verifies and is sealed; no request body in ledger |
| Composition | DELETE/OPTIONS retain their inspected transport and response-size floors; native admission is unchanged. Existing worker CSP, header injection, all-hop policy checks, redirect caps and fail-closed target tracking remain required regression checks |
| Review-driven controls | 40 receiver cases pass, including unscoped base-policy denied redirects, declared/chunked response caps, same-origin credential retention and a cross-origin/return cookie/auth chain. A co-located guard test prevents adding marker overrides to browser preflights |
| Test timing | Native macOS headed-locale checks reproduced three 30s whole-case timeouts under suite load; isolated diagnostic passed all four. The fixture now waits for DOM readiness with a 10s bound and has a separate 60s native launch/setup/shutdown budget; assertions remain intact |
| Full checks and review | All 6,430 local tests passed through required hooks; separate adversarial review and protected integration/promotion CI passed |
| Promotion and tag | Main/tag commit `b72499f42acc358b77c7bb5137d0e91aeaed373e`; back-sync `196598277c0fdc896dd33719fc6757055c894440` has the identical reviewed tree |
| Delivery | Release workflow `41370871353` passed; immutable release has 16 assets. npm version/latest and downloaded Darwin ARM64 CLI/MCP versions verified as 1.30.1. Homebrew #155 passed CI and merged with reviewed formula hashes |

The approved [handoff order](../design/t10-bounty-flow-continuity.md) is unchanged:
this is a prerequisite checkpoint within P0-2. The `page fetch` feature remains
disabled in its separate worktree until approval/document binding, bounds,
redaction and no-replay qualification complete. Live program checks remain
pending operator verification. Existing services are not restarted.
