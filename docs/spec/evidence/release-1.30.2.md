# Release 1.30.2 qualification

Status: maintenance release delivered on 2026-11-02. Source PRs
[#675](https://github.com/anvai-labs/agentbrowser/pull/675) and
[#676](https://github.com/anvai-labs/agentbrowser/pull/676) merged through protected
develop after green CI and separate adversarial review. The combined batch
[#677](https://github.com/anvai-labs/agentbrowser/pull/677), main promotion
[#678](https://github.com/anvai-labs/agentbrowser/pull/678) and release back-sync
[#679](https://github.com/anvai-labs/agentbrowser/pull/679) passed protected CI.
[v1.30.2](https://github.com/anvai-labs/agentbrowser/releases/tag/v1.30.2) is public.

This repairs research-marker transport without adding a public command or scope
authority. Unrelated destinations omit header overrides; matching destinations
still receive markers and carried marker names are stripped elsewhere. Native
admission stays POST/PUT/PATCH. Inspected redirects retain their independently
scrubbed hop headers, response floors and permanent 303 body dropping.

The same maintenance batch fixes initial-cookie privacy. A detached seed snapshot
is registered in the reserved owner's generation before engine startup. Captured
redactors and cleanup capabilities stay bound to that generation across closure
and textual ID reuse. Recorder failures stop the captured scope; mapper failures
still clean up and return a fixed secret-free error. Bulk initialization avoids
rebuilding the accumulated redaction patterns for every cookie.

| Gate | Evidence |
| --- | --- |
| Source | Develop `b497dcd67e8d9c6dcf6ae5f48f5117ebb1260ed9`; exact reviewed tree `1dc343f713eadb928d4d05bec2fab9e7f0de98b1` |
| A8 source qualification | All 6,491 tests passed required commit and push hooks; strict lint, type-check, build and built contract checks passed |
| Privacy source qualification | Seven-file v3 packet independently reviewed; 129 core and 183 API targeted tests passed, including swallowed recorder faults, late owner/ledger completion and cleanup failure canaries. Handoff/seed integration: 33 passed with observable owner-isolation and teardown assertions |
| Native regression | 73 targeted guard/worker/research-identity/redirect cases passed; seven local public-service CORS/iframe cases passed on both baseline and candidate |
| Denial proof | Method/host/rate/budget cases each recorded one corresponding denial, zero denied API receiver hits and independently verified sealed engagement ledgers |
| Review | Frozen manifest and exact rebased commit `c5b54c13` independently checked; no remaining confirmed source blocker |
| Source CI | CI `41387115862`, Windows `41387115854` and docs `41387115883` passed; the helper source also passed CI under #675 |
| Combined batch | Commit `93c3972a852b8ae82f7d6d4d25d06d8500d9472a`, independently reviewed tree `4e1c30b49a8fa5366037d3c00565b8bafb912413`; required commit, branch-push and tag-push hooks each passed all 6,511 tests, strict lint, type-check and build. Strict docs, 1,254 links and 68 release-contract tests passed |
| Promotion and ancestry | Main `c61b9afb55c3998dce886385eb67de12a11e1431`, annotated tag `v1.30.2`; protected back-sync `4e271af5dc7c202c6596381b748ba66c93924673`. Main and develop had the same reviewed tree after back-sync |
| Package delivery | [Release run 41401669334](https://github.com/anvai-labs/agentbrowser/actions/runs/41401669334) passed; 16 immutable assets, all 15 manifest digests cross-checked, four downloaded file hashes verified. Native CLI/help, MCP version/catalog and packaged server report 1.30.2. CLI signed provenance names the exact release commit/workflow; npm latest is 1.30.2 |
| Homebrew | [Tap PR #156](https://github.com/anvai-labs/homebrew-tap/pull/156) independently reviewed; all 12 URLs/hashes matched published assets, install/service/test behavior unchanged, four normal CI checks passed; merged `1cd1c24b17850ad32a266e34e9d060dee6da7235` |

The iframe fixtures require local-network permission only in fresh loopback test
contexts. Genuine preflights are correlated through trusted Network metadata;
Playwright internally fulfills their intercepted 204 responses. These tests do
not qualify new preflight policy admission or claim a target OPTIONS wire hit.
A9 was not reproduced on the current baseline; the existing response-continuation
fallback is retained, and no guard-skipping architecture is added. Diagnostics
identify whether an override was carried, not which CDP operation caused failure.

The response-admission helper remains internal and unconnected to a public fetch
action. API probes, resource/auth lifecycle capabilities, interaction helpers and
later handoff items remain separate work. Live Wolt verification is
pending operator verification. Existing services are not restarted.

This release covers initial seed registration, startup and recorder lifecycle.
Ordinary observe/console publication privacy remains a separate prerequisite
before fetch activation; this record does not claim whole-session output privacy.
Winget manifests are available on the release fork's `ab-agentbrowser-1.30.2`
branch; upstream package acceptance remains separate from the delivered channels.
