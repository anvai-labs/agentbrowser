# Release 1.30.0 qualification

Status: published 2026-11-01. [Immutable GitHub release](https://github.com/anvai-labs/agentbrowser/releases/tag/v1.30.0)
and npm `@anvailabs/agentbrowser-mcp@1.30.0` verified. Homebrew delivery is a
separate gate, tracked below.

## A1 acceptance evidence

The [coordinate design](../../adr/031-coordinate-interaction-and-visual-evidence.md)
implements the closed-shadow interaction increment of the approved
[bounty handoff](../design/t10-bounty-flow-continuity.md).

| Check | Local evidence |
| --- | --- |
| Closed-shadow submission | Public service actions open a VRT picker, focus/type search, select, attach exact verified bytes and submit once. Independent HTTP receiver verifies category, filename, sentinel bytes and one submission |
| Policy composition | Approved coordinate input causes host/method/rate/budget refusals; denied receivers receive zero requests and sealed engagement ledgers retain the typed denial |
| Mapping | Real Chromium DPR 1/2 fixtures with hidden and visible classic scrollbars independently measure an 8px edge target after two-axis scroll; receiver sees the expected click coordinates. Native full-viewport CSS extents include scrollbar pixels in the PNG. Unknown/non-unit page zoom, pinch and visual offsets refuse |
| Controlled writes | Real delegated session plus real operation journal: takeover during submitted input seals `outcome_unknown`; regrant and repeated operation ID cause no second receiver mutation. A separate unchanged-page test refuses an unused old-grant token by trusted incarnation/epoch/review binding |
| Page concurrency and recovery | Real Chromium tests exclude coordinate preparation during ordinary action/navigation and exclude ordinary input during preparation. Disclosure CDP reset invalidates old capture evidence and permits fresh capture/preparation |
| Unsupported adapters | Trusted disable-only engine setting removes coordinate capabilities/actions, probes and mapped metadata. Obscura opts out; normal observe/screenshot and the existing experimental contract suite remain the gate |
| Refusals and cancellation | Controller/lifetime tests cover capture ownership/expiry/eviction, document/geometry/pixel changes, owner cancellation during hung approval/CDP/chooser reads, competing/wrong/late choosers, file replacement, and close/revoke/transport failure during submitted mouse/file writes |
| Hygiene | Strict workspace lint and all 15 executable lint-policy probes passed; duplication remains 4,373 tokens against the unchanged 4,373 baseline |

These are offline fixture results, not a live Bugcrowd/Wolt/Vinted pass. Live
program verification remains pending operator verification. No running service
restart is included. Native input/label attachment is main-frame only and uses
synthetic file events; it does not promise application acceptance.

## Delivery gates

| Gate | Evidence |
| --- | --- |
| Local checks and independent review | Final source `b6d99b329b8bea92886ab7e84d2e7a44899530ce`, tree `f0fee13e78ed0dfe95b302de47b0b438265c6a6d`; full pre-commit/pre-push checks with 6,389 package tests, including pinned Obscura; separate adversarial review found no remaining blocker |
| Develop integration | [PR #669](https://github.com/anvai-labs/agentbrowser/pull/669), squash `e32acb2e`; final-head protected checks green, including Windows, Obscura, documentation and journal gates |
| Main promotion and ancestry | [PR #670](https://github.com/anvai-labs/agentbrowser/pull/670), merge `d686cd4b808db488bc98bc743b2fa4cd480fac54`, exact reviewed tree; tag ancestry check passed |
| Published delivery | [Release workflow](https://github.com/anvai-labs/agentbrowser/actions/runs/41359633603) green; immutable release has 16 assets. Public npm version and `latest` both report 1.30.0 |
| Download verification | Darwin arm64 CLI, MCP and server archive match the published SHA-256 manifest. Downloaded CLI `--version` and MCP initialize `serverInfo.version` report 1.30.0 |
| Main back-sync | [PR #671](https://github.com/anvai-labs/agentbrowser/pull/671), merge `b652a338`; all checks green; no source tree changes |
| Homebrew | [Tap PR #154](https://github.com/anvai-labs/homebrew-tap/pull/154), squash `8a0f37b3`; separate review verified all 12 URL/hash pairs against the immutable manifest and a sole-file URL/hash diff. Normal required [PR CI](https://github.com/anvai-labs/homebrew-tap/actions/runs/41363870545) green, including Linux install/tests and macOS |

Existing immutable release tags and assets are not replaced. No running operator
service was upgraded or restarted.
