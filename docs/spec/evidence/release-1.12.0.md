# AgentBrowser 1.12.0 release checkpoint

Status: candidate preparation; publication and installation are pending.
Candidate base: develop `7ccddb21a627c9019f58c99fa11848456b98492c` (PR #303).
Previous published baseline: 1.11.0 at protected main
`e00539eca682b60e5761702d1851472bb6401b12`.

## Scope and compatibility

This minor release adds navigation failure reasons, sampled active-session leases,
bounded terminal facts and opt-in attachment to operator-owned Chrome across
REST/SDK/CLI/MCP. Shared coordinator, authority and projection helpers own these
contracts; adapters do not introduce independent execution or state stores.
See the [changelog](../../../CHANGELOG.md#1120---2026-09-25).

Operator attachment is off by default, local and authenticated. It requires an
explicit acknowledgement that network enforcement is limited to navigation preflight;
hosted, multi-tenant and delegated configurations refuse. Use a dedicated profile.
Engine disconnection reports the observed fact, without inferring operator intent or
a crash. Session inspection samples leases without renewing idle lifetime.

CLI/MCP remain Bun binaries, and the Homebrew service uses Node 24. MCP is optional.
The internal journal/SQLite work does not enable durable execution or restart recovery.
Finite roadmap completion remains 3 of 9 tasks (33%); T9 recurs for each release.

## Acceptance design

The 1.11.0 Rosetta timeout follow-up adds bounded named phase timings to the existing
managed-child owner. Deadline errors identify the active phase. Cleanup still drains
owned work and observes process exit before returning. Deadlines, failure assertions
and resource ownership remain unchanged; command arguments, credentials and payloads
are not added to the phase records.

Existing consumer workflows accept an extracted server and matching Bun clients using
`resolvePackagedModules`. Qualify lease/terminal parity with the research fixture,
navigation reasons with deterministic navigation fixtures, and Chrome attachment plus
engine loss with `cdp-attach-smoke.mjs --disconnect`. Live Yahoo results are observational,
not a deterministic acceptance gate. SDK qualification uses the candidate workspace SDK.
All three scripts accept the same required candidate flags: `--server-root`,
`--expected-version`, `--expected-commit`, `--cli` and `--mcp`. `--allow-dirty`
is only for pre-commit preparation and keeps `releaseEvidence: false`. Omit all
candidate flags to retain source-checkout smoke mode, which is never release evidence.
Use `--headed` for research/navigation and `--disconnect` for the CDP fixture.
The loader validates the package stamp/closure and supplied CLI version before
browser allocation; each workflow verifies the MCP version during initialization.

Before commit: focused failing-first timing tests, version/docs checks, workspace
build, extracted-package acceptance and consumer smokes. A dirty preparation package
must explicitly opt in and cannot claim release evidence. Exact-head review, normal
hooks, eight PR/main checks, verified merge/tag ancestry, release jobs, published bytes
and Homebrew qualification remain required before claiming delivery.

## Preparation observations

The local Darwin ARM extracted service and actual Bun CLI/MCP passed all eleven
acceptance groups in 18,620 ms on Node 24.21.0. The measured outcome coordinator
child took 10,198 ms, with all thirteen case labels and the application recipe present.
This pre-commit archive is explicitly dirty and reports `releaseEvidence: false`.

Review found and reproduced a pre-existing falsy callback-rejection bug in the
managed owner: rejection with `undefined` could be reported as success. Static
non-Error normalization now preserves failure without printing arbitrary thrown data;
the failing-first regression and all thirty managed/package acceptance unit tests pass.
The shared consumer loader refuses incomplete or mismatched candidates and checks
CLI version before browser allocation. CDP PASS is emitted only after owned cleanup;
forced shutdown fails qualification. Non-Error rejection normalization also handles
throwing prototype traps without bypassing child cleanup.

All three pre-commit headed consumer workflows passed against the extracted 1.12.0
service and actual Bun clients, with `dirty: true` and `releaseEvidence: false`:

- Research: 13/52 MiB fixture filings, complete 1,408,355-byte extraction, JSON,
  cookie sharing, lease parity and explicit/TTL/idle terminal facts.
- Navigation: local success, denied unlisted LAN host and `.invalid` unresolved DNS
  agree across REST/SDK/CLI/MCP; origin-supplied diagnostic headers remain untrusted.
- Operator Chrome: disabled refusal, shared dedicated profile, preserved unowned tabs,
  owned popup adoption, detach preserving Chrome, last-page close preserving session,
  and `engine_disconnected` projection after loss of the owned fixture browser.

The 58 packaging/acceptance tests and six candidate-selection tests pass. Workspace
build, version synchronization, 960 relative documentation links, all 82 spec-context
selections and built CLI/MCP contracts pass. These are local preparation results;
reviewed commit, CI, publication and installed evidence remain separate gates.

## Preserved state and continuation

Unrelated root edits and the existing logged-in service remain preserved. Tests use
owned isolated services and profiles. Installing a binary does not upgrade a running
service; service restart needs a session checkpoint.

After delivery, resume the raw journal adapter, bounded child manager and remaining
process-loss qualification through the existing foundation. T4/T6 production evidence,
T7 security scope and T8 installed external harness qualification remain open.
