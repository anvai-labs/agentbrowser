# Release 1.29.1 evidence

Reconciled against origin on 2026-11-01. This records the existing publication;
it does not create or republish a release.

| Gate | Verified evidence |
| --- | --- |
| Published source | `v1.29.1` = `c2b4550ed3cd21109e447c1dbdd581fdb65e53a7`, reachable from origin/main; version PR [#665](https://github.com/anvai-labs/agentbrowser/pull/665) |
| Change | [#664](https://github.com/anvai-labs/agentbrowser/pull/664), `dce36529ac6d95595e31bbe5061b7652281178a5`; source diff inspected independently of the description |
| Feature PR CI | [41233112469](https://github.com/anvai-labs/agentbrowser/actions/runs/41233112469), all reported required jobs successful; #665's checks also successful |
| Release workflow | [41238494828](https://github.com/anvai-labs/agentbrowser/actions/runs/41238494828), success: version guard, five binary targets, four server targets, Windows bundle, npm, checksums/GitHub release and winget manifest generation |
| GitHub publication | [v1.29.1](https://github.com/anvai-labs/agentbrowser/releases/tag/v1.29.1), published 2026-10-31T22:10:17Z, not draft or prerelease; 16 uploaded assets |

The shipped source adds the `http_error_response` navigation failure reason,
the body guard's response-continuation fallback, and document-only worker CSP
handling with absent resource type treated fail-closed. It also contains scope
suggestion helpers/tests; no public integration was found during reconciliation.

The PR description's request-header host-scoping claim is not supported by the
published diff. The distinct local commit `93213f22` modifies that behavior and
remains unmerged. Neither coordinate mode nor page-fetch is part of 1.29.1.
See the [handoff status](../design/t10-bounty-flow-continuity.md).

The published change globally disables Biome's `noUnusedVariables`,
`noUnusedImports`, `noUnusedFunctionParameters` and `noUnusedPrivateClassMembers`.
The origin back-sync preserves this configuration; restoring the previous checks
is a separate follow-up. Historical green lint does not establish those checks.

This reconciliation did not redownload/execute published binaries, verify their
attestations, query npm dist-tags, verify Homebrew installation, or confirm a
winget-pkgs submission. Workflow success is recorded separately from those
consumer checks. No running service was restarted.
