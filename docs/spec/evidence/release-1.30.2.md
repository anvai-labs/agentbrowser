# Release 1.30.2 qualification

Status: maintenance candidate. Source PRs
[#675](https://github.com/anvai-labs/agentbrowser/pull/675) and
[#676](https://github.com/anvai-labs/agentbrowser/pull/676) merged through protected
develop after green CI and separate adversarial review. Version preparation,
main promotion, tag and delivery remain gates. No publication is claimed here.

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
| Privacy source qualification | Seven-file v3 packet independently reviewed; 129 core and 183 API targeted tests passed, including swallowed recorder faults, late owner/ledger completion and cleanup failure canaries. Combined release hooks remain required |
| Native regression | 73 targeted guard/worker/research-identity/redirect cases passed; seven local public-service CORS/iframe cases passed on both baseline and candidate |
| Denial proof | Method/host/rate/budget cases each recorded one corresponding denial, zero denied API receiver hits and independently verified sealed engagement ledgers |
| Review | Frozen manifest and exact rebased commit `c5b54c13` independently checked; no remaining confirmed source blocker |
| Source CI | CI `41387115862`, Windows `41387115854` and docs `41387115883` passed; the helper source also passed CI under #675 |
| Remaining | Combined release hooks, release-version checks, protected promotion CI, tag ancestry and package/tap delivery |

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
